// @ts-check
/*
  Reminder planning (pure) plus the notification runtime. nextReminders()
  computes every unsent reminder for the merged items; the background keeps
  one alarm at the earliest fireAt, sends chrome.notifications when they come
  due, and honours quiet hours in Toronto time.
*/

import { zonedParts, zonedIso } from "../lib/textdates/index.js";
import { effectiveItem, isVisible } from "./effective.js";
import { findClashes } from "./clashes.js";
import {
  getSettings,
  getLocal,
  mutateKey,
  getMergedView,
} from "./store.js";
import { runSync, setUserState } from "./scheduler.js";

const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const TZ = "America/Toronto";

export const REMIND_ALARM = "wa1:remind";
export const BRIEFING_ALARM = "wa1:briefing";
export const DIGEST_ALARM = "wa1:digest";
export const SENT_KEY = "remindersSent"; // {key: iso sent time}, pruned > 30 d
export const SNOOZE_KEY = "reminderSnooze"; // {key: iso until}
export const BRIEFING_KEY = "briefingLastSent"; // "YYYY-MM-DD" (Toronto)
export const DIGEST_KEY = "digestLastSent"; // "YYYY-MM-DD" (Toronto)

/** settings.reminders.digest.day values -> JS weekday (0=Sun). */
export const DIGEST_DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const STALE_MS = 6 * HOUR;
const SENT_KEEP_MS = 30 * DAY;
const FIRE_GRACE_MS = MIN; // fire reminders up to 1 min early (alarm jitter)

/** Timed events anchor on startAt; deadlines on dueAt. */
function anchorOf(eff) {
  return eff.startAt || eff.dueAt || null;
}

/**
 * Every reminder that should still go out, soonest first.
 * @param {Record<string, any>} items  merged items map
 * @param {Record<string, any>} userState
 * @param {any} settings  resolved wa1Settings
 * @param {Date} now
 * @param {Record<string, string>} [sent]     key -> iso time it fired
 * @param {Record<string, string>} [snoozed] key -> iso until
 * Keys embed the anchor ms (`<id>:<lead>:<anchor>`) so a moved date is a new
 * reminder, not a skipped one.
 * @returns {{key: string, itemId: string, fireAt: number, lead: number}[]}
 */
export function nextReminders(items, userState = {}, settings = {}, now = new Date(), sent = {}, snoozed = {}) {
  const rem = (settings && settings.reminders) || {};
  if (rem.enabled === false) return [];
  const leads = rem.leads || {};
  const acceptPending = !!(settings.review && settings.review.showPending);
  const nowMs = now.getTime();

  /** @type {any[]} */
  const out = [];
  for (const raw of Object.values(items || {})) {
    if (!raw || !raw.id) continue;
    const eff = effectiveItem(raw, userState[raw.id], { acceptPending });
    if (!isVisible(eff, nowMs)) continue;
    if (eff.status !== "open") continue;
    if (!rem.includeTentative && eff.confidence === "tentative") continue;

    // A study to-do reminds once, when it opens ("Start studying for…").
    if (eff.meta && eff.meta.auto === "study" && eff.opensAt) {
      const openMs = Date.parse(eff.opensAt);
      if (Number.isNaN(openMs)) continue;
      const key = `${eff.id}:open:${openMs}`;
      if (sent[key]) continue;
      let fireAt = openMs;
      const until = snoozed[key] ? Date.parse(snoozed[key]) : 0;
      if (until > nowMs) fireAt = Math.max(fireAt, until);
      else if (fireAt < nowMs - STALE_MS) continue;
      out.push({ key, itemId: eff.id, fireAt, lead: Math.round((Date.parse(anchorOf(eff)) - openMs) / MIN) });
      continue;
    }

    const a = anchorOf(eff);
    if (!a) continue;
    const anchorMs = Date.parse(a);
    if (Number.isNaN(anchorMs) || anchorMs <= nowMs) continue;
    const typeLeads = leads[eff.type];
    if (!Array.isArray(typeLeads)) continue;
    for (const lead of typeLeads) {
      if (typeof lead !== "number" || !(lead > 0)) continue;
      const key = `${eff.id}:${lead}:${anchorMs}`;
      if (sent[key]) continue;
      let fireAt = anchorMs - lead * MIN;
      // A snoozed reminder comes back at the snooze end — and stays fresh
      // there even though the original lead time is long past.
      const until = snoozed[key] ? Date.parse(snoozed[key]) : 0;
      if (until > nowMs) fireAt = Math.max(fireAt, until);
      else if (fireAt < nowMs - STALE_MS) continue; // too stale to bother
      out.push({ key, itemId: eff.id, fireAt, lead });
    }
  }
  return out.sort((a, b) => a.fireAt - b.fireAt);
}

/** "23:00" -> [23, 0]; null on anything else. */
function parseHhMm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h >= 0 && h < 24 && mi >= 0 && mi < 60 ? [h, mi] : null;
}

/**
 * If `now` falls inside quiet hours (Toronto wall clock, overnight windows
 * supported), the ms instant quiet ends; otherwise null.
 * @param {Date|number} now
 * @param {{enabled?: boolean, start?: string, end?: string}} [quiet]
 */
export function quietEndMs(now, quiet) {
  if (!quiet || quiet.enabled === false) return null;
  const s = parseHhMm(quiet.start);
  const e = parseHhMm(quiet.end);
  if (!s || !e) return null;
  const sm = s[0] * 60 + s[1];
  const em = e[0] * 60 + e[1];
  if (sm === em) return null;
  const p = zonedParts(new Date(now), TZ);
  const t = p.h * 60 + p.mi;
  const wrap = sm > em;
  const inside = wrap ? t >= sm || t < em : t >= sm && t < em;
  if (!inside) return null;
  const dayOffset = wrap && t >= sm ? 1 : 0;
  return Date.parse(zonedIso(p.y, p.m, p.d + dayOffset, e[0], e[1], TZ));
}

/** "in 1 hour" / "in 2 days" / "in 15 min". */
function fmtLead(ms) {
  if (ms < HOUR) return `in ${Math.max(1, Math.round(ms / MIN))} min`;
  if (ms < DAY) {
    const h = Math.round(ms / HOUR);
    return `in ${h} hour${h === 1 ? "" : "s"}`;
  }
  const d = Math.round(ms / DAY);
  return `in ${d} day${d === 1 ? "" : "s"}`;
}

/** "11:59 PM" */
function fmtTime(isoOrMs) {
  const d = new Date(isoOrMs);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}

/**
 * Notification copy for one reminder.
 * @param {any} eff effective item
 * @param {number} nowMs
 * @returns {{title: string, message: string}}
 */
export function reminderCopy(eff, nowMs) {
  const a = anchorOf(eff);
  const anchorMs = Date.parse(a);
  if (eff.meta && eff.meta.auto === "study") {
    const label = eff.meta.parentLabel || "assessment";
    // "Study for MATH 117 Midterm — the midterm is in 5 days · 4:30 PM"
    return {
      title: eff.title,
      message: `The ${label} is ${fmtLead(anchorMs - nowMs)} · ${fmtTime(anchorMs)}`,
    };
  }
  const title = eff.org ? `${eff.org} · ${eff.title}` : eff.title;
  const verb = eff.startAt ? "Starts" : "Due";
  let message = `${verb} ${fmtLead(anchorMs - nowMs)} · ${fmtTime(anchorMs)}`;
  if (eff.startAt && eff.location) message += ` · ${eff.location}`;
  return { title, message };
}

/* ------------------------------ briefing ------------------------------ */

/** Toronto local-day [start, end) ms for the day containing `now`. */
function torontoDay(now) {
  const p = zonedParts(now, TZ);
  const start = Date.parse(zonedIso(p.y, p.m, p.d, 0, 0, TZ));
  return [start, start + DAY];
}

/**
 * Morning briefing text: "Today: 2 classes · 3 due · next: ECE 105 Quiz
 * 11:59 PM", plus a clash note. Null when nothing is happening today.
 * @param {Record<string, any>} items
 * @param {Record<string, any>} userState
 * @param {Date} now
 * @param {any} [settings]
 */
export function briefingText(items, userState = {}, now = new Date(), settings = {}) {
  const acceptPending = !!(settings.review && settings.review.showPending);
  const [dayStart, dayEnd] = torontoDay(now);
  let classes = 0;
  let due = 0;
  /** @type {any} */
  let next = null;
  let nextMs = Infinity;
  for (const raw of Object.values(items || {})) {
    if (!raw || !raw.id) continue;
    const eff = effectiveItem(raw, userState[raw.id], { acceptPending });
    if (!isVisible(eff, now)) continue;
    if (eff.status !== "open") continue;
    const a = anchorOf(eff);
    if (!a) continue;
    const ms = Date.parse(a);
    if (Number.isNaN(ms) || ms < dayStart || ms >= dayEnd) continue;
    if (eff.startAt && (eff.type === "class" || eff.type === "tutorial" || eff.type === "lab")) {
      classes++;
    } else if (eff.dueAt) {
      due++;
    }
    if (ms >= now.getTime() && ms < nextMs) {
      next = eff;
      nextMs = ms;
    }
  }
  if (!classes && !due) return null;
  const parts = [`Today: ${classes} class${classes === 1 ? "" : "es"} · ${due} due`];
  if (next) {
    parts.push(`next: ${next.org ? `${next.org} ` : ""}${next.title} ${fmtTime(nextMs)}`);
  }
  const clashes = findClashes(items, userState, now, { horizonDays: 1, acceptPending }).filter(
    (c) => Date.parse(c.start) < dayEnd
  );
  if (clashes.length) {
    parts.push(`${clashes.length} clash${clashes.length === 1 ? "" : "es"} today`);
  }
  return parts.join(" · ");
}

/* ------------------------------ weekly digest ----------------------------- */

const CLASSISH_TYPES = new Set(["class", "tutorial", "term-date"]);
const WD_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Weekly digest text: "This week: 6 due (2 worth ≥10%), 1 exam, 2 interviews
 * · busiest: Thu". "This week" is the next 7 days from `now`. Null when the
 * week holds nothing reportable.
 * @param {Record<string, any>} items
 * @param {Record<string, any>} userState
 * @param {Date} now
 * @param {any} [settings]
 * @param {Record<string, any>} [todos] derived to-dos — counted as "N to-dos"
 */
export function digestText(items, userState = {}, now = new Date(), settings = {}, todos = {}) {
  const acceptPending = !!(settings.review && settings.review.showPending);
  const nowMs = now.getTime();
  const weekEnd = nowMs + 7 * DAY;
  let due = 0;
  let heavy = 0;
  let exams = 0;
  let interviews = 0;
  let todoCount = 0;
  for (const raw of Object.values(todos || {})) {
    if (!raw || !raw.id) continue;
    const eff = effectiveItem(raw, userState[raw.id], { acceptPending });
    if (!isVisible(eff, nowMs)) continue;
    if (eff.status !== "open") continue;
    const a = anchorOf(eff);
    if (!a) continue;
    const ms = Date.parse(a);
    if (!Number.isNaN(ms) && ms >= nowMs && ms < weekEnd) todoCount++;
  }
  /** @type {Map<number, number>} */
  const dayCounts = new Map();
  for (const raw of Object.values(items || {})) {
    if (!raw || !raw.id) continue;
    const eff = effectiveItem(raw, userState[raw.id], { acceptPending });
    if (!isVisible(eff, nowMs)) continue;
    if (eff.status !== "open") continue;
    const a = anchorOf(eff);
    if (!a) continue;
    const ms = Date.parse(a);
    if (Number.isNaN(ms) || ms < nowMs || ms >= weekEnd) continue;
    const p = zonedParts(new Date(ms), TZ);
    if (eff.type === "exam") {
      exams++;
      dayCounts.set(p.weekday, (dayCounts.get(p.weekday) || 0) + 1);
    } else if (eff.type === "interview") {
      interviews++;
      dayCounts.set(p.weekday, (dayCounts.get(p.weekday) || 0) + 1);
    } else if (eff.dueAt && !CLASSISH_TYPES.has(eff.type)) {
      due++;
      if (typeof eff.weight === "number" && eff.weight >= 10) heavy++;
      dayCounts.set(p.weekday, (dayCounts.get(p.weekday) || 0) + 1);
    }
  }
  if (!due && !exams && !interviews && !todoCount) return null;
  const parts = [];
  if (due) {
    parts.push(`${due} due${heavy ? ` (${heavy} worth ≥10%)` : ""}`);
  }
  if (exams) parts.push(`${exams} exam${exams === 1 ? "" : "s"}`);
  if (interviews) parts.push(`${interviews} interview${interviews === 1 ? "" : "s"}`);
  if (todoCount) parts.push(`${todoCount} to-do${todoCount === 1 ? "" : "s"}`);
  let busiest = -1;
  let busiestN = 0;
  for (const [d, n] of dayCounts) {
    if (n > busiestN) {
      busiest = d;
      busiestN = n;
    }
  }
  let text = `This week: ${parts.join(", ")}`;
  if (busiest >= 0) text += ` · busiest: ${WD_SHORT[busiest]}`;
  return text;
}

/* --------------------------- runtime (browser) --------------------------- */

/** Read sent/snoozed maps, pruning sent keys older than 30 days. */
async function reminderStore() {
  const [sentRaw, snoozedRaw] = await Promise.all([getLocal(SENT_KEY), getLocal(SNOOZE_KEY)]);
  const sent = sentRaw && typeof sentRaw === "object" ? sentRaw : {};
  const snoozed = snoozedRaw && typeof snoozedRaw === "object" ? snoozedRaw : {};
  const cutoff = Date.now() - SENT_KEEP_MS;
  const pruned = Object.fromEntries(
    Object.entries(sent).filter(([, at]) => Date.parse(/** @type {string} */ (at)) > cutoff)
  );
  return { sent: pruned, snoozed };
}

/**
 * Keep `wa1:remind` armed at the earliest pending reminder. Call after
 * recomputeAll, on reminder-settings changes, and at startup.
 * @param {{alarm?: (name: string, at: number|null) => void}} [deps]
 */
export async function rescheduleReminders(deps = {}) {
  const alarm =
    deps.alarm ||
    ((name, at) => {
      try {
        if (at == null) chrome.alarms.clear(name);
        else chrome.alarms.create(name, { when: at });
      } catch {
        /* alarms unavailable */
      }
    });
  const settings = await getSettings();
  const { sent, snoozed } = await reminderStore();
  const mv = await getMergedView();
  const now = new Date();
  const pending = nextReminders(
    { ...mv.items, ...(mv.todos || {}) },
    mv.userState,
    settings,
    now,
    sent,
    snoozed
  );
  const next = pending.find((r) => r.fireAt > now.getTime() - STALE_MS);
  alarm(REMIND_ALARM, next ? next.fireAt : null);
  await rescheduleBriefing(settings, deps);
  await rescheduleDigest(settings, deps);
}

/** Arm `wa1:briefing` at the next Toronto occurrence of the briefing time. */
async function rescheduleBriefing(settings, deps = {}) {
  const alarm =
    deps.alarm ||
    ((name, at) => {
      try {
        if (at == null) chrome.alarms.clear(name);
        else chrome.alarms.create(name, { when: at });
      } catch {
        /* alarms unavailable */
      }
    });
  const briefing = settings && settings.reminders && settings.reminders.briefing;
  const t = briefing && parseHhMm(briefing.time);
  if (!briefing || briefing.enabled === false || !t) {
    alarm(BRIEFING_ALARM, null);
    return;
  }
  const now = new Date();
  const p = zonedParts(now, TZ);
  let at = Date.parse(zonedIso(p.y, p.m, p.d, t[0], t[1], TZ));
  if (at <= now.getTime()) at = Date.parse(zonedIso(p.y, p.m, p.d + 1, t[0], t[1], TZ));
  alarm(BRIEFING_ALARM, at);
}

/** Arm `wa1:digest` at the next Toronto occurrence of the digest day/time. */
async function rescheduleDigest(settings, deps = {}) {
  const alarm =
    deps.alarm ||
    ((name, at) => {
      try {
        if (at == null) chrome.alarms.clear(name);
        else chrome.alarms.create(name, { when: at });
      } catch {
        /* alarms unavailable */
      }
    });
  const digest = settings && settings.reminders && settings.reminders.digest;
  const t = digest && parseHhMm(digest.time);
  const dow = digest && DIGEST_DAYS[String(digest.day || "").toLowerCase()];
  if (!digest || digest.enabled === false || !t || dow == null) {
    alarm(DIGEST_ALARM, null);
    return;
  }
  const now = new Date();
  const p = zonedParts(now, TZ);
  let delta = (dow - p.weekday + 7) % 7;
  let at = Date.parse(zonedIso(p.y, p.m, p.d + delta, t[0], t[1], TZ));
  if (at <= now.getTime()) at = Date.parse(zonedIso(p.y, p.m, p.d + delta + 7, t[0], t[1], TZ));
  alarm(DIGEST_ALARM, at);
}

/** Reminders due right now (or up to a minute early), none older than 6 h. */
function dueNow(pending, nowMs) {
  return pending.filter((r) => r.fireAt <= nowMs + FIRE_GRACE_MS && r.fireAt >= nowMs - STALE_MS);
}

/**
 * wa1:remind fired: send every due reminder, with the Learn submission
 * recheck and quiet-hours deferral, then re-arm.
 */
export async function fireDueReminders() {
  const settings = await getSettings();
  const rem = (settings && settings.reminders) || {};
  if (rem.enabled === false) return;
  const now = new Date();
  let mv = await getMergedView();
  let { sent, snoozed } = await reminderStore();
  const allItems = () => ({ ...mv.items, ...(mv.todos || {}) });
  let pending = nextReminders(allItems(), mv.userState, settings, now, sent, snoozed);
  let due = dueNow(pending, now.getTime());
  if (!due.length) {
    await rescheduleReminders();
    return;
  }

  // Learn submission recheck: if a due reminder is a Learn deadline/quiz,
  // re-sync Learn first (20 s cap) — a submitted item shouldn't nag.
  const needsLearnCheck = due.some((r) => {
    const it = mv.items[r.itemId] || (mv.todos || {})[r.itemId];
    return it && it.source === "learn" && (it.type === "deadline" || it.type === "quiz");
  });
  if (needsLearnCheck) {
    try {
      await Promise.race([
        runSync("learn", "reminder"),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 20000)),
      ]);
      mv = await getMergedView();
      ({ sent, snoozed } = await reminderStore());
      pending = nextReminders(allItems(), mv.userState, settings, new Date(), sent, snoozed);
      due = dueNow(pending, Date.now());
    } catch {
      /* recheck is best-effort; fire on last-known state */
    }
  }

  const markSent = {};
  const snoozePatch = {};
  for (const r of due) {
    const eff = effectiveItem(
      mv.items[r.itemId] || (mv.todos || {})[r.itemId],
      mv.userState[r.itemId],
      {
        acceptPending: !!(settings.review && settings.review.showPending),
      }
    );
    if (!eff || eff.status !== "open" || !isVisible(eff, Date.now())) {
      markSent[r.key] = new Date().toISOString();
      continue;
    }
    const anchorMs = Date.parse(anchorOf(eff));
    if (!(anchorMs > Date.now())) {
      markSent[r.key] = new Date().toISOString();
      continue;
    }
    // Quiet hours: defer to the end if the anchor outlives it, else drop.
    const qEnd = quietEndMs(Date.now(), rem.quietHours);
    if (qEnd) {
      if (anchorMs > qEnd) {
        snoozePatch[r.key] = new Date(qEnd).toISOString();
      } else {
        markSent[r.key] = new Date().toISOString();
      }
      continue;
    }
    const copy = reminderCopy(eff, Date.now());
    try {
      await chrome.notifications.create(`wa1:rem:${r.key}`, {
        type: "basic",
        iconUrl: "icons/icon-128.png",
        title: copy.title,
        message: copy.message,
        buttons: [{ title: "Mark done" }, { title: "Snooze 1 h" }],
      });
      markSent[r.key] = new Date().toISOString();
      delete snoozePatch[r.key];
    } catch (e) {
      console.warn("[wa1] notify", e && /** @type {any} */ (e).message);
    }
  }

  if (Object.keys(markSent).length) {
    await mutateKey(SENT_KEY, (cur) => ({ ...(cur || {}), ...markSent }));
  }
  if (Object.keys(snoozePatch).length) {
    await mutateKey(SNOOZE_KEY, (cur) => ({ ...(cur || {}), ...snoozePatch }));
  }
  await rescheduleReminders();
}

/** One-per-day morning briefing notification. */
export async function sendBriefing() {
  const settings = await getSettings();
  const briefing = settings && settings.reminders && settings.reminders.briefing;
  if (!briefing || briefing.enabled === false) return;
  const now = new Date();
  const p = zonedParts(now, TZ);
  const dayKey = `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
  const last = await getLocal(BRIEFING_KEY);
  if (last === dayKey) return;
  const mv = await getMergedView();
  const text = briefingText(mv.items, mv.userState, now, settings);
  if (!text) {
    await rescheduleBriefing(settings);
    return;
  }
  try {
    await chrome.notifications.create("wa1:briefing", {
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title: "Waterloo All-in-1",
      message: text,
    });
    await mutateKey(BRIEFING_KEY, () => dayKey);
  } catch (e) {
    console.warn("[wa1] briefing", e && /** @type {any} */ (e).message);
  }
  await rescheduleBriefing(settings);
}

/** One-per-week digest notification. */
export async function sendDigest() {
  const settings = await getSettings();
  const digest = settings && settings.reminders && settings.reminders.digest;
  if (!digest || digest.enabled === false) return;
  const now = new Date();
  const p = zonedParts(now, TZ);
  const dayKey = `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
  const last = await getLocal(DIGEST_KEY);
  if (last === dayKey) return;
  const mv = await getMergedView();
  const text = digestText(mv.items, mv.userState, now, settings, mv.todos);
  if (text) {
    try {
      await chrome.notifications.create("wa1:digest", {
        type: "basic",
        iconUrl: "icons/icon-128.png",
        title: "Your week at Waterloo",
        message: text,
      });
    } catch (e) {
      console.warn("[wa1] digest", e && /** @type {any} */ (e).message);
    }
  }
  // Mark the day even when the week is empty, so we don't keep checking.
  await mutateKey(DIGEST_KEY, () => dayKey);
  await rescheduleDigest(settings);
}

/** `<id>:<lead>:<anchor>` -> id. Item ids contain colons, so strip two tails. */
function itemIdFromKey(key) {
  return key.replace(/:\d+:\d+$/, "");
}

/** Notification click + button handlers; call once at SW startup. */
export function installNotificationHandlers() {
  try {
    chrome.notifications.onButtonClicked.addListener(async (id, btnIdx) => {
      if (!String(id).startsWith("wa1:rem:")) return;
      const key = String(id).slice("wa1:rem:".length);
      const itemId = itemIdFromKey(key);
      try {
        if (btnIdx === 0) {
          await setUserState(itemId, { done: true, doneAt: new Date().toISOString() });
        } else {
          await mutateKey(SNOOZE_KEY, (cur) => ({
            ...(cur || {}),
            [key]: new Date(Date.now() + 60 * MIN).toISOString(),
          }));
        }
        chrome.notifications.clear(id);
        await rescheduleReminders();
      } catch {
        /* best effort */
      }
    });
    chrome.notifications.onClicked.addListener(async (id) => {
      if (!String(id).startsWith("wa1:rem:")) return;
      const key = String(id).slice("wa1:rem:".length);
      const itemId = itemIdFromKey(key);
      try {
        const mv = await getMergedView();
        const it = mv.items[itemId];
        const url = it && (it.url || (it.evidence && it.evidence.url));
        if (url) {
          await chrome.tabs.create({ url });
        } else {
          const win = await chrome.windows.getLastFocused().catch(() => null);
          if (win && win.id != null) {
            await chrome.sidePanel.open({ windowId: win.id }).catch(() => {});
          }
        }
      } catch {
        /* best effort */
      }
      chrome.notifications.clear(id);
    });
  } catch {
    /* notifications unavailable */
  }
}
