// @ts-check
/*
  Scheduler: runs adapter syncs under concurrency/backoff rules, folds results
  into raw:<source>, then recomputes the merged view and the badge.
  Pure helpers (nextBackoff, shouldRun) are exported for tests.
*/

import { recompute, applyResult, mergeApplications, mergeUpdates, mergeCourses, mergeTerms, resultUpdates } from "./merge.js";
import {
  getSettings,
  getLocal,
  setLocal,
  mutateKey,
  getMergedView,
  appendLog,
  patchUserState,
  rawKey,
  enqueue,
  MAX_UPDATES,
} from "./store.js";
import { ADAPTERS, adapterForSource } from "./registry.js";
import { t1Fetch, relayFetch } from "../capture/fetch.js";
import { parseHtml } from "../capture/parse.js";
import { extractDates } from "../lib/textdates/index.js";
import { scheduleFeedPublish } from "../calendar/publish.js";
import { effectiveItem, isVisible } from "./effective.js";
import { rescheduleReminders } from "./remind.js";

const MAX_CONCURRENT = 2;
const MINUTE = 60 * 1000;

/* --------------------------- pure helpers --------------------------- */

/**
 * Backoff after `failures` consecutive failures: 5m x 2^(n-1), capped at 6h.
 * @param {number} failures
 * @returns {number} ms
 */
export function nextBackoff(failures) {
  const n = Math.max(1, Math.floor(failures || 0));
  return Math.min(5 * MINUTE * 2 ** (n - 1), 6 * 3600 * 1000);
}

/**
 * Should the adapter run now?
 * @param {{state?: any, lastRunAt?: string, backoffUntil?: string} | null} state sourceState entry
 * @param {number} now Date.now()
 * @param {"alarm"|"manual"|"tab"|"startup"|"scope"|"reminder"} reason
 * @param {number} intervalMinutes adapter's sync interval
 */
export function shouldRun(state, now, reason, intervalMinutes) {
  const st = state || {};
  const backoffUntil = st.backoffUntil ? Date.parse(st.backoffUntil) : 0;
  if (reason === "manual") return true; // a student request overrides backoff
  if (backoffUntil && now < backoffUntil) return false;
  const lastRun = st.lastRunAt ? Date.parse(st.lastRunAt) : 0;
  if (reason === "tab") return !lastRun || now - lastRun >= 2 * MINUTE;
  if (reason === "startup" || reason === "alarm") {
    return !intervalMinutes || intervalMinutes <= 0 ? !lastRun : now - lastRun >= intervalMinutes * MINUTE;
  }
  return true;
}

/**
 * Course -> group map derived from stored Course.group values. The Portal
 * adapter reports groups once it's live; until then this is empty and the
 * profile's own groups apply.
 * @param {any[]} [courses]
 */
export function groupsFromCourses(courses) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const c of courses || []) {
    if (c && c.code && c.group != null && c.group !== "") {
      out[String(c.code)] = String(c.group);
    }
  }
  return out;
}

/**
 * The settings slice an adapter sees: the shared profile (sections, groups)
 * plus its own `sources[adapterId]` block. Stored shapes are normalised here
 * so adapters get what they expect — e.g. `sources.outline.urls` is stored
 * as an object code->url but the adapter iterates it as a URL list.
 * @param {string} adapterId
 * @param {Record<string, any>} settings full settings object
 * @param {{courses?: any[], outlineFiles?: any[]}} [extras]
 *   courses feeds the group fallback (profile.groups still wins);
 *   outlineFiles (stored `outlineFiles` entries) becomes `files` for outline.
 * @returns {Record<string, any>}
 */
export function adapterSettings(adapterId, settings, extras) {
  const s = settings || {};
  const src = (s.sources && s.sources[adapterId]) || {};
  const groups = {
    ...groupsFromCourses(extras && extras.courses),
    ...((s.profile && s.profile.groups) || {}),
  };
  const out = {
    ...(s.profile ? { sections: s.profile.sections || {}, groups } : {}),
    ...src,
  };
  if (out.urls && !Array.isArray(out.urls) && typeof out.urls === "object") {
    out.urls = Object.values(out.urls).map(String).filter(Boolean);
  }
  if (adapterId === "outline" && extras && Array.isArray(extras.outlineFiles)) {
    out.files = extras.outlineFiles.map((f) =>
      f && f.kind === "pdf"
        ? { name: f.name, kind: "pdf", base64: f.base64 }
        : { name: f && f.name, kind: "html", html: f && f.html }
    );
  }
  return out;
}

/**
 * The next sourceState entry after a read. Two kinds:
 *
 *   "sync"     a scheduled/manual adapter.sync — the full status refresh,
 *              except that a "no-tab"/"signed-out" session keeps the previous
 *              lastOkAt and complete (nothing was actually read).
 *   "observe"  a passive T3 payload — if the adapter reports a session, only
 *              that field moves; a result with readOk entries is a real read
 *              and refreshes session/lastOkAt/complete/error/itemCount;
 *              anything else (e.g. an incomplete DOM snapshot) changes only
 *              the adapter's private state.
 *
 * @param {any} prev     previous sourceState entry (or undefined)
 * @param {any} result   SyncResult (possibly with observe's `scope`)
 * @param {Date|string} now
 * @param {"sync"|"observe"} kind
 * @param {number} [itemCount] items stored under the source's raw key
 */
export function nextSourceState(prev, result, now, kind, itemCount) {
  const p = prev || {};
  const nowIso = (now instanceof Date ? now : new Date(now)).toISOString();

  if (kind === "observe") {
    const st = { ...p };
    if (result.state !== undefined) st.state = result.state;
    if (result.session) {
      st.session = result.session;
    } else if (Array.isArray(result.readOk) && result.readOk.length) {
      st.session = "signed-in";
      st.lastOkAt = nowIso;
      st.complete = !!result.complete;
      st.error = result.error || null;
      if (itemCount != null) st.itemCount = itemCount;
    }
    return st;
  }

  const session = result.session || null;
  const sessionErr = session === "no-tab" || session === "signed-out";
  const isSessionErr =
    result.error && (result.error.code === "signed-out" || result.error.code === "no-tab");
  const failures = result.error ? (p.failures || 0) + 1 : 0;
  const backoffMs = result.error
    ? isSessionErr
      ? Math.min(nextBackoff(failures), 30 * MINUTE)
      : nextBackoff(failures)
    : 0;
  return {
    state: result.state !== undefined ? result.state : p.state || {},
    lastRunAt: nowIso,
    lastOkAt: sessionErr ? p.lastOkAt || null : result.error ? p.lastOkAt || null : nowIso,
    session,
    error: result.error || null,
    complete: sessionErr ? (p.complete ?? false) : !!result.complete,
    failures,
    backoffUntil: backoffMs ? new Date(Date.parse(nowIso) + backoffMs).toISOString() : null,
    itemCount: itemCount ?? p.itemCount ?? 0,
  };
}

/* --------------------------- runSync --------------------------- */

let running = 0;
const inFlight = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs one adapter sync. At most one run per adapter at a time and at most
 * MAX_CONCURRENT overall; manual runs skip backoff.
 * @param {string} adapterId
 * @param {"alarm"|"manual"|"tab"|"startup"|"scope"|"reminder"} reason
 */
export async function runSync(adapterId, reason) {
  const adapter = ADAPTERS.find((a) => a.id === adapterId);
  if (!adapter || typeof adapter.sync !== "function") return { ok: false, reason: "no-sync" };
  const settings = await getSettings();
  const srcSettings = (settings.sources && settings.sources[adapterId]) || {};
  if (srcSettings.enabled === false) return { ok: false, reason: "disabled" };
  if (inFlight.has(adapterId)) return { ok: false, reason: "already-running" };
  const stateMap = (await getLocal("sourceState")) || {};
  if (!shouldRun(stateMap[adapterId], Date.now(), reason, adapter.intervalMinutes)) {
    return { ok: false, reason: "backoff" };
  }
  while (running >= MAX_CONCURRENT) await sleep(50);
  running++;
  inFlight.add(adapterId);
  try {
    await doSync(adapter, settings, reason);
    return { ok: true };
  } finally {
    running--;
    inFlight.delete(adapterId);
  }
}

/**
 * The SyncContext handed to adapters. `extras` carries per-adapter extras:
 * the merged courses (group fallback) for everyone, `outlineFiles` for
 * outline only.
 */
function makeCtx(adapter, settings, state, mv, extras) {
  const id = adapter.id;
  return {
    now: new Date(),
    settings: adapterSettings(id, settings, { courses: Object.values(mv.courses), ...(extras || {}) }),
    state: state || {},
    courses: Object.values(mv.courses),
    terms: Object.values(mv.terms),
    fetch: t1Fetch,
    relay: relayFetch,
    parseHtml,
    textDates: extractDates,
    log: (message, data) =>
      appendLog(id, data === undefined ? String(message) : `${message} ${safeJson(data)}`),
  };
}

/**
 * Per-adapter extras for adapterSettings. Only outline needs its imported
 * files (`outlineFiles` storage key); nothing else reads that key.
 * @param {string} adapterId
 */
async function adapterExtras(adapterId) {
  if (adapterId !== "outline") return undefined;
  const files = await getLocal("outlineFiles");
  return { outlineFiles: Array.isArray(files) ? files : [] };
}

function safeJson(v) {
  try {
    return JSON.stringify(v).slice(0, 200);
  } catch {
    return "";
  }
}

/** Call adapter.sync, converting a throw into an error SyncResult. */
async function callSync(adapter, ctx) {
  try {
    return await /** @type {any} */ (adapter).sync(ctx);
  } catch (e) {
    const err = /** @type {any} */ (e);
    return {
      items: [],
      complete: false,
      error: { code: "exception", message: String((err && err.message) || err) },
    };
  }
}

/**
 * @param {import("./contract.js").Adapter} adapter
 * @param {Record<string, any>} settings full settings object
 * @param {string} reason
 */
async function doSync(adapter, settings, reason) {
  const id = adapter.id;
  const now = new Date();
  const prevState = ((await getLocal("sourceState")) || {})[id];
  const mv = await getMergedView();
  const ctx = makeCtx(adapter, settings, prevState && prevState.state, mv, await adapterExtras(adapter.id));
  const seenVersion = stateVersion(id);

  // The adapter call stays outside the ingest queue so observes aren't
  // blocked while it fetches.
  let result = await callSync(adapter, ctx);

  // The fold is queued with observes/captures: a slow sync that finishes
  // after an observe re-reads the fresh raw and state before writing.
  return ingest(id, async () => {
    if (stateVersion(id) !== seenVersion) {
      // ctx.state moved on while sync() ran (an observe wrote it). Re-run
      // once against the fresh state so the result — including the adapter's
      // private next-state — is derived from what is actually stored.
      const curState = ((await getLocal("sourceState")) || {})[id];
      const mv2 = await getMergedView();
      const ctx2 = makeCtx(
        adapter,
        settings,
        curState && curState.state,
        mv2,
        await adapterExtras(id)
      );
      result = await callSync(adapter, ctx2);
    }

    const mv2 = await getMergedView();
    await setLocal(rawKey(id), applyResult(mv2.raws[id] || null, result, { mode: "sync" }));

    const rawItems = /** @type {any} */ (await getLocal(rawKey(id))) || { items: [] };
    await mutateKey("sourceState", (cur) => ({
      ...(cur || {}),
      [id]: nextSourceState((cur || {})[id], result, now, "sync", (rawItems.items || []).length),
    }));
    bumpStateVersion(id);
    await appendLog(id, `sync (${reason}) ${result.error ? `error ${result.error.code}` : `ok ${result.items.length} items`}`);
    await recomputeAll(now, resultUpdates(result));
    return result;
  });
}

/* --------------------------- ingests --------------------------- */

const ingestQueues = new Map();
/** Serialise observed/capture ingests per source. */
function ingest(source, fn) {
  const prev = ingestQueues.get(source) || Promise.resolve();
  const run = prev.then(fn);
  ingestQueues.set(source, run.catch(() => {}));
  return run;
}

/**
 * Per-adapter write counter for sourceState. A long-running sync snapshots it
 * when building ctx.state; if it moved by fold time, the adapter's state is
 * stale and sync() is re-run once against the fresh one.
 */
const stateVersions = new Map();
const stateVersion = (/** @type {string} */ id) => stateVersions.get(id) || 0;
const bumpStateVersion = (/** @type {string} */ id) =>
  stateVersions.set(id, stateVersion(id) + 1);

function ingestResult(source, result, scope) {
  return ingest(source, async () => {
    const mv = await getMergedView();
    const raw = applyResult(mv.raws[source] || null, result, { mode: "scope", scope });
    await setLocal(rawKey(source), raw);
    await recomputeAll(new Date(), resultUpdates(result));
  });
}

/**
 * wa1:observed — a recorder saw a page-network response whose URL matched an
 * observe pattern. The owning adapter's observe.parse turns it into items.
 * @param {import("./contract.js").ObservedPayload} payload
 */
export async function handleObserved(payload) {
  const adapter = payload && adapterForSource(payload.source);
  const parse = adapter && adapter.observe && adapter.observe.parse;
  if (!adapter || typeof parse !== "function") return;
  const source = payload.source;
  return ingest(source, async () => {
    const mv = await getMergedView();
    const settings = await getSettings();
    const st = ((await getLocal("sourceState")) || {})[adapter.id];
    let result;
    try {
      result = await parse(payload, makeCtx(adapter, settings, st && st.state, mv, await adapterExtras(adapter.id)));
    } catch (e) {
      const err = /** @type {any} */ (e);
      await appendLog(source, `observe failed: ${(err && err.message) || err}`);
      return;
    }
    if (!result || !Array.isArray(result.items)) return;
    const raw = applyResult(mv.raws[source] || null, result, { mode: "scope", scope: result.scope });
    await setLocal(rawKey(source), raw);
    // The adapter's private state moves forward on every observe too, so its
    // next diff/compares start from this read; the visible status fields move
    // only per nextSourceState's rules.
    await mutateKey("sourceState", (cur) => ({
      ...(cur || {}),
      [adapter.id]: nextSourceState(
        (cur || {})[adapter.id],
        result,
        new Date(),
        "observe",
        (raw.items || []).length
      ),
    }));
    bumpStateVersion(adapter.id);
    await recomputeAll(new Date(), resultUpdates(result));
  });
}

/**
 * wa1:capture — a content script (or the panel) hands in already-parsed items.
 * @param {{source:string, scope:string, items:any[], applications?:any[], complete?:boolean}} msg
 */
export async function handleCapture(msg) {
  if (!msg || !msg.source || !msg.scope) return;
  return ingestResult(
    msg.source,
    {
      items: Array.isArray(msg.items) ? msg.items : [],
      applications: msg.applications,
      complete: !!msg.complete,
    },
    msg.scope
  );
}

/* --------------------------- recompute + badge --------------------------- */

/**
 * Recomputes the merged view (items/links/uidMap), unions applications from
 * the raws, merges courses and terms, records updates, refreshes the badge.
 * Serialised through the store's write queue.
 * @param {Date} [now]
 * @param {any[]} [extraUpdates] updates the producing adapter reported
 *   (SyncResult.updates / state.lastUpdates); deduplicated by id.
 */
export async function recomputeAll(now = new Date(), extraUpdates = []) {
  return enqueue(async () => {
    const mv = await getMergedView();
    const res = recompute({
      raws: mv.raws,
      prevItems: mv.items,
      links: mv.links,
      uidMap: mv.uidMap,
      userState: mv.userState,
      now,
    });
    const applications = mergeApplications(mv.raws);
    // All writes happen inside this one queued task — a nested enqueue()
    // (pushUpdates/mutateKey) would deadlock against the outer task.
    const cur = await chrome.storage.local.get("updates");
    const updates = mergeUpdates(
      Array.isArray(cur.updates) ? cur.updates : [],
      [...res.updates, ...(extraUpdates || [])],
      MAX_UPDATES
    );
    await chrome.storage.local.set({
      items: res.items,
      links: res.links,
      uidMap: res.uidMap,
      applications,
      courses: mergeCourses(mv.raws),
      terms: mergeTerms(mv.raws),
      updates,
    });
    await refreshBadge();
    // Republish the calendar feed (debounced) when it's enabled.
    scheduleFeedPublish().catch(() => {});
    // Re-arm the reminder/briefing alarms for the new merged view.
    rescheduleReminders().catch(() => {});
    return res;
  });
}

/** Re-merge only (e.g. after a userState change) — no adapter calls. */
export async function remerge() {
  return recomputeAll(new Date());
}

/**
 * Patch userState for one canonical id, then recompute.
 * @param {string} id
 * @param {Record<string, any>} patch
 */
export async function setUserState(id, patch) {
  await patchUserState(id, patch);
  await recomputeAll(new Date());
}

/**
 * Badge = items due by end of today (plus overdue): open, not pending review
 * or dismissed, not a timetable/term-date type, not hidden or snoozed.
 */
export async function refreshBadge() {
  try {
    const [mv, settings] = await Promise.all([getMergedView(), getSettings()]);
    const acceptPending = !!(settings.review && settings.review.showPending);
    const endToday = new Date();
    endToday.setHours(23, 59, 59, 999);
    const endMs = endToday.getTime();
    const nowMs = Date.now();
    let n = 0;
    for (const it of Object.values(mv.items)) {
      const eff = effectiveItem(it, mv.userState[it.id], { acceptPending });
      if (eff.status !== "open") continue;
      if (!isVisible(eff, nowMs)) continue;
      if (eff.type === "class" || eff.type === "tutorial" || eff.type === "lab" || eff.type === "term-date") continue;
      const anchor = eff.dueAt || eff.startAt;
      if (!anchor || Date.parse(anchor) > endMs) continue;
      n++;
    }
    await chrome.action.setBadgeText({ text: n ? String(n) : "" });
  } catch {
    /* badge is best-effort */
  }
}

/**
 * wa1:clear-source — drop a source's raw data and state, then recompute.
 * @param {string} source
 */
export async function clearSource(source) {
  await chrome.storage.local.remove([rawKey(source)]);
  await mutateKey("sourceState", (cur) => {
    const all = { ...(cur || {}) };
    delete all[source];
    return all;
  });
  bumpStateVersion(source);
  await recomputeAll(new Date());
}

export { patchUserState };
