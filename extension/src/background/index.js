// @ts-check
/*
  Waterloo All-in-1 background service worker.

  - Runs adapter syncs on alarms / tab-open / startup / manual panel requests
    (core/scheduler.js), folds results into raw:<source>, recomputes the
    merged view and drives the badge.
  - Answers TAB_READY with the adapter's observe patterns, receives
    OBSERVED (T3 net responses) and CAPTURE (content-script pushes) ingests.
  - Keeps the Phase-0 discovery recorder listener.

  Everything stays in chrome.storage.local on this computer — nothing is
  uploaded anywhere.
*/

import { MSG } from "../core/contract.js";
import { UI } from "../core/messages.js";
import { ADAPTERS, adapterForSource, observePatternsFor } from "../core/registry.js";
import { migrateStorage, getLocal } from "../core/store.js";
import {
  runSync,
  recomputeAll,
  refreshBadge,
  shouldRun,
  handleObserved,
  handleCapture,
  setUserState,
  clearSource,
} from "../core/scheduler.js";
import { handleDiscoveryMessage } from "../capture/discovery-store.js";
import {
  publishFeed,
  scheduleFeedPublish,
  stopFeed,
  PUBLISH_ALARM,
  DAILY_ALARM,
} from "../calendar/publish.js";
import {
  rescheduleReminders,
  fireDueReminders,
  sendBriefing,
  installNotificationHandlers,
  REMIND_ALARM,
  BRIEFING_ALARM,
} from "../core/remind.js";

const BADGE_BG = "#FED34C"; // school bus yellow
const BADGE_TEXT = "#16181D";

/* ------------------------------ setup ------------------------------ */

async function setup() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    /* older Chrome/Edge lacks sidePanel */
  }
  try {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_BG });
    if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: BADGE_TEXT });
  } catch {
    /* ignore */
  }
  // One repeating alarm per adapter that has a sync interval.
  for (const a of ADAPTERS) {
    if (!a.intervalMinutes || a.intervalMinutes <= 0) continue;
    const name = `sync:${a.id}`;
    try {
      if (!(await chrome.alarms.get(name))) chrome.alarms.create(name, { periodInMinutes: a.intervalMinutes });
    } catch (e) {
      console.warn(`[wa1] alarm ${name}`, e);
    }
  }
  // Daily publish alarm so a quiet week still refreshes the feed's expiry.
  try {
    if (!(await chrome.alarms.get(DAILY_ALARM))) {
      chrome.alarms.create(DAILY_ALARM, { periodInMinutes: 24 * 60 });
    }
  } catch (e) {
    console.warn(`[wa1] alarm ${DAILY_ALARM}`, e);
  }
  installNotificationHandlers();
  await recomputeAll(); // rebuild merged view + badge; also arms the reminders
  await rescheduleReminders().catch(() => {});
}

/** On startup, run adapters whose last run is older than their interval. */
async function catchUp() {
  const states = (await getLocal("sourceState")) || {};
  const now = Date.now();
  for (const a of ADAPTERS) {
    if (typeof a.sync !== "function") continue;
    if (shouldRun(states[a.id], now, "startup", a.intervalMinutes)) {
      runSync(a.id, "startup").catch(() => {});
    }
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  migrateStorage()
    .then(setup)
    .then(catchUp)
    .catch((e) => console.warn("[wa1] install", e));
  if (details && details.reason === "install") {
    // First run: the options page opens on the setup checklist.
    chrome.tabs
      .create({ url: chrome.runtime.getURL("src/options/options.html#welcome") })
      .catch(() => {});
  }
});
chrome.runtime.onStartup.addListener(() => {
  setup()
    .then(catchUp)
    .catch((e) => console.warn("[wa1] startup", e));
});
setup().catch(() => {}); // SW reloads (dev reloads) don't fire onStartup

chrome.alarms.onAlarm.addListener((alarm) => {
  const m = /^sync:(.+)$/.exec(alarm.name || "");
  if (m) runSync(m[1], "alarm").catch(() => {});
  if (alarm.name === PUBLISH_ALARM || alarm.name === DAILY_ALARM) {
    publishFeed().catch((e) => console.warn("[wa1] publish", e && e.message));
  }
  if (alarm.name === REMIND_ALARM) {
    fireDueReminders().catch((e) => console.warn("[wa1] remind", e && e.message));
  }
  if (alarm.name === BRIEFING_ALARM) {
    sendBriefing().catch((e) => console.warn("[wa1] briefing", e && e.message));
  }
});

/* ------------------------------ messages ------------------------------ */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return false;

  if (msg.type === MSG.TAB_READY) {
    onTabReady(msg).then(sendResponse, () => sendResponse({ observe: [] }));
    return true;
  }
  if (msg.type === MSG.OBSERVED) {
    handleObserved(msg.payload).catch(() => {});
    return false;
  }
  if (msg.type === MSG.CAPTURE) {
    handleCapture(msg).catch(() => {});
    return false;
  }
  if (msg.type === UI.SYNC) {
    manualSync(msg.source).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === UI.SET_USER_STATE) {
    if (!msg.id) return false;
    setUserState(msg.id, msg.patch || {}).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === UI.OPEN) {
    openOrFocus(msg.url).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === UI.CLEAR_SOURCE) {
    if (!msg.source) return false;
    clearSource(msg.source).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === UI.CALENDAR_PUBLISH) {
    publishFeed({ force: true }).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === UI.CALENDAR_STOP) {
    stopFeed().then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === UI.TEST_NOTIFY) {
    testNotification().then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  return false;
});

/** Settings -> Reminders "Send test notification". */
async function testNotification() {
  try {
    await chrome.notifications.create(`wa1:test:${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title: "ECE 105 · Quiz #3",
      message: "Due in 1 hour · 11:59 PM",
      buttons: [{ title: "Mark done" }, { title: "Snooze 1 h" }],
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && /** @type {any} */ (e).message) || e) };
  }
}

/**
 * A site tab announced itself. Reply with the adapter's observe patterns and
 * kick a "tab" sync when the adapter wants one and hasn't run recently.
 * @param {{source?: string, url?: string}} msg
 */
async function onTabReady(msg) {
  const site = msg.source;
  const observe = site ? observePatternsFor(site) : [];
  const adapter = site && adapterForSource(site);
  if (adapter && adapter.syncOnTabOpen && typeof adapter.sync === "function") {
    const states = (await getLocal("sourceState")) || {};
    if (shouldRun(states[adapter.id], Date.now(), "tab", adapter.intervalMinutes)) {
      runSync(adapter.id, "tab").catch(() => {});
    }
  }
  return { observe };
}

/** @param {string} [source] run one adapter (a SourceId), or all enabled adapters */
async function manualSync(source) {
  if (source) {
    const a = adapterForSource(source);
    const r = a ? await runSync(a.id, "manual") : null;
    return { ok: !!(r && r.ok), reason: r ? r.reason : "unknown-source" };
  }
  const results = await Promise.all(ADAPTERS.map((a) => runSync(a.id, "manual")));
  return { ok: results.some((r) => r && r.ok) };
}

/** @param {string} url */
async function openOrFocus(url) {
  if (!url) return;
  try {
    const tabs = await chrome.tabs.query({ url });
    const tab = tabs && tabs[0];
    if (tab && tab.id != null) {
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
      return;
    }
  } catch {
    /* fall through to create */
  }
  await chrome.tabs.create({ url });
}

/* ------------------------------ badge ------------------------------ */

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.items || changes.userState) refreshBadge().catch(() => {});
    // Any settings change that touches calendar.* re-arms the debounced
    // publish (scheduleFeedPublish itself checks enabled).
    const s = changes.wa1Settings;
    const before = /** @type {any} */ (s && s.oldValue) || {};
    const after = /** @type {any} */ (s && s.newValue) || {};
    if (s && JSON.stringify(before.calendar) !== JSON.stringify(after.calendar)) {
      scheduleFeedPublish().catch(() => {});
    }
    if (
      s &&
      (JSON.stringify(before.reminders) !== JSON.stringify(after.reminders) ||
        JSON.stringify(before.review) !== JSON.stringify(after.review))
    ) {
      rescheduleReminders().catch(() => {});
    }
  });
} catch {
  /* ignore */
}

/* ------------------------------ discovery recorder (Phase 0) ------------------------------ */

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || (msg.type !== MSG.DISCOVERY && msg.type !== MSG.TAB_READY)) return false;
  handleDiscoveryMessage(msg);
  return false;
});
