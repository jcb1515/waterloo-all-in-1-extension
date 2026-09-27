// @ts-check
/*
  Scheduler: runs adapter syncs under concurrency/backoff rules, folds results
  into raw:<source>, then recomputes the merged view and the badge.
  Pure helpers (nextBackoff, shouldRun) are exported for tests.
*/

import { recompute, applyResult, diffApplications, mergeCourses, mergeTerms } from "./merge.js";
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
 * @param {"alarm"|"manual"|"tab"|"startup"|"scope"} reason
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

/* --------------------------- runSync --------------------------- */

let running = 0;
const inFlight = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs one adapter sync. At most one run per adapter at a time and at most
 * MAX_CONCURRENT overall; manual runs skip backoff.
 * @param {string} adapterId
 * @param {"alarm"|"manual"|"tab"|"startup"|"scope"} reason
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
    await doSync(adapter, srcSettings, reason);
    return { ok: true };
  } finally {
    running--;
    inFlight.delete(adapterId);
  }
}

/** The SyncContext handed to adapters. */
function makeCtx(adapter, srcSettings, state, mv) {
  const id = adapter.id;
  return {
    now: new Date(),
    settings: srcSettings || {},
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

function safeJson(v) {
  try {
    return JSON.stringify(v).slice(0, 200);
  } catch {
    return "";
  }
}

/**
 * @param {import("./contract.js").Adapter} adapter
 * @param {Record<string, any>} srcSettings
 * @param {string} reason
 */
async function doSync(adapter, srcSettings, reason) {
  const id = adapter.id;
  const now = new Date();
  const prevState = ((await getLocal("sourceState")) || {})[id];
  const mv = await getMergedView();
  const ctx = makeCtx(adapter, srcSettings, prevState && prevState.state, mv);

  /** @type {any} */
  let result;
  try {
    result = await /** @type {any} */ (adapter).sync(ctx);
  } catch (e) {
    const err = /** @type {any} */ (e);
    result = { items: [], complete: false, error: { code: "exception", message: String((err && err.message) || err) } };
  }

  await setLocal(rawKey(id), applyResult(mv.raws[id] || null, result, { mode: "sync" }));

  const isSessionErr =
    result.error && (result.error.code === "signed-out" || result.error.code === "no-tab");
  const failures = result.error ? (prevState && prevState.failures ? prevState.failures + 1 : 1) : 0;
  const backoffMs = result.error
    ? isSessionErr
      ? Math.min(nextBackoff(failures), 30 * MINUTE)
      : nextBackoff(failures)
    : 0;
  const rawItems = /** @type {any} */ (await getLocal(rawKey(id))) || { items: [] };
  await mutateKey("sourceState", (cur) => ({
    ...(cur || {}),
    [id]: {
      state: result.state !== undefined ? result.state : (prevState && prevState.state) || {},
      lastRunAt: now.toISOString(),
      lastOkAt: result.error ? (prevState && prevState.lastOkAt) || null : now.toISOString(),
      session: result.session || null,
      error: result.error || null,
      complete: !!result.complete,
      failures,
      backoffUntil: backoffMs ? new Date(now.getTime() + backoffMs).toISOString() : null,
      itemCount: (rawItems.items || []).length,
    },
  }));
  await appendLog(id, `sync (${reason}) ${result.error ? `error ${result.error.code}` : `ok ${result.items.length} items`}`);
  await recomputeAll(now);
  return result;
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

function ingestResult(source, result, scope) {
  return ingest(source, async () => {
    const mv = await getMergedView();
    const raw = applyResult(mv.raws[source] || null, result, { mode: "scope", scope });
    await setLocal(rawKey(source), raw);
    await recomputeAll(new Date());
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
    const srcSettings = ((await getSettings()).sources || {})[adapter.id] || {};
    const st = ((await getLocal("sourceState")) || {})[adapter.id];
    let result;
    try {
      result = await parse(payload, makeCtx(adapter, srcSettings, st && st.state, mv));
    } catch (e) {
      const err = /** @type {any} */ (e);
      await appendLog(source, `observe failed: ${(err && err.message) || err}`);
      return;
    }
    if (!result || !Array.isArray(result.items)) return;
    const raw = applyResult(mv.raws[source] || null, result, { mode: "scope", scope: result.scope });
    await setLocal(rawKey(source), raw);
    await recomputeAll(new Date());
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
 * Recomputes the merged view (items/links/uidMap), diffs applications, merges
 * courses and terms, records updates, refreshes the badge. Serialised through
 * the store's write queue.
 */
export async function recomputeAll(now = new Date()) {
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
    const nextApps = {};
    for (const rec of Object.values(mv.raws)) {
      for (const app of (rec && rec.applications) || []) {
        if (app && app.id) nextApps[app.id] = { ...(nextApps[app.id] || {}), ...app };
      }
    }
    const { applications, updates: appUpdates } = diffApplications(mv.applications, nextApps, now);
    // All writes happen inside this one queued task — a nested enqueue()
    // (pushUpdates/mutateKey) would deadlock against the outer task.
    const cur = await chrome.storage.local.get("updates");
    const updates = [...res.updates, ...appUpdates, ...(Array.isArray(cur.updates) ? cur.updates : [])].slice(
      0,
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
    const mv = await getMergedView();
    const endToday = new Date();
    endToday.setHours(23, 59, 59, 999);
    const endMs = endToday.getTime();
    const nowMs = Date.now();
    let n = 0;
    for (const it of Object.values(mv.items)) {
      if (it.status !== "open") continue;
      if (it.review === "pending" || it.review === "dismissed") continue;
      if (it.type === "class" || it.type === "tutorial" || it.type === "lab" || it.type === "term-date") continue;
      const us = mv.userState[it.id] || {};
      if (us.hidden) continue;
      if (us.snoozedUntil && Date.parse(us.snoozedUntil) > nowMs) continue;
      const anchor = it.dueAt || it.startAt;
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
  await recomputeAll(new Date());
}

export { patchUserState };
