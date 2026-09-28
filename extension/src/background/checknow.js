// @ts-check
/*
  Check-now orchestrator. The panel's "Check now" sends UI.CHECK_NOW; the
  background answers {accepted, runId} right away and the run continues
  asynchronously:

    sync sources (learn, outline, gcal) — runSync(adapterId, "manual"); the
      run's reason comes from the sourceState entry the sync just stamped.
    tab sources  (portal, gmail, outlook, waterlooworks, discord) — reuse
      the most recently used matching tab, else open siteUrlFor(source)
      inactive (Discord never opens a tab). The tab answers CHECK.NOW and
      finishes with CHECK.DONE.

  Results live in the top-level `checkRuns` key — NOT sourceState — because
  two SourceIds can share one adapter and checks must not fight the
  ingest's writes. checkRunView in panel/model/sources.js reads it.

  All chrome.* access is injected (`deps`) so this stays unit-testable.
*/

import { CHECK } from "../core/messages.js";
import { siteUrlFor, sourceForTabUrl } from "../core/sites.js";
import { adapterForSource } from "../core/registry.js";
import { CHECK_SOURCES } from "../sources/probes.js";
import { rowScopes } from "../panel/model/onboarding.js";

/** Sources that check by running their adapter sync. */
export const SYNC_SOURCES = new Set(["learn", "outline", "gcal"]);
/** Sources that check by poking a live tab's content script. */
export const TAB_SOURCES = new Set([
  "portal",
  "gmail",
  "outlook",
  "waterlooworks",
  "discord",
]);

export const CHECK_TIMEOUT_MS = 90 * 1000;
const COMPLETE_WAIT_MS = 30 * 1000;
const ANSWER_WAIT_MS = 15 * 1000;
const REINJECT_ANSWER_WAIT_MS = 10 * 1000;
const SEND_RETRY_MS = 1000;
const POLL_MS = 500;

/**
 * In-flight runs, keyed by SourceId. Each entry:
 * {runId, startedAtMs, resolve(msg), ours: Set<tabId>} — `resolve` is
 * called by handleCheckDone when a matching wa1:check-done lands.
 * @type {Map<string, {runId: string, startedAtMs: number,
 *   resolve: (msg: any) => void, done: Promise<any>, ours: Set<number>}>}
 */
const live = new Map();

/**
 * Start a check-now run. Responds synchronously; the run continues in the
 * background and reports through checkRuns[source].
 * @param {string} source SourceId
 * @param {any} deps {tabs, runSync, reinjectTab, stampScopes, store, now, sleep}
 * @returns {{accepted: true, runId: string} | {accepted: false, reason: string}}
 */
export function startCheck(source, deps) {
  const src = String(source || "");
  if (!SYNC_SOURCES.has(src) && !TAB_SOURCES.has(src)) {
    return { accepted: false, reason: "unsupported" };
  }
  if (live.has(src)) return { accepted: false, reason: "already-running" };
  const startedAtMs = deps.now();
  const runId = `check:${src}:${startedAtMs}`;
  /** @type {{runId: string, startedAtMs: number, resolve: (msg: any) => void, done: Promise<any>, ours: Set<number>}} */
  const run = {
    runId,
    startedAtMs,
    resolve: () => {},
    done: Promise.resolve(),
    ours: new Set(),
  };
  run.done = new Promise((r) => {
    run.resolve = r;
  });
  live.set(src, run);
  void deps.store
    .mutateKey("checkRuns", (cur) => ({
      ...(cur || {}),
      [src]: { runId, status: "running", startedAt: new Date(startedAtMs).toISOString() },
    }))
    .catch(() => {});
  runCheck(src, run, deps).catch(() => {});
  return { accepted: true, runId };
}

/**
 * wa1:check-done from a content script — resolves the matching run.
 * A stale or foreign runId is ignored.
 * @param {any} msg
 */
export function handleCheckDone(msg) {
  if (!msg || typeof msg.source !== "string" || typeof msg.runId !== "string") return;
  const run = live.get(msg.source);
  if (!run || run.runId !== msg.runId) return;
  run.resolve(msg);
}

/**
 * On any background wake: finalize running entries older than the run
 * timeout — the worker that owned them is gone. If `tabs` is given, also
 * close any tabIds the dead run recorded as opened-by-us.
 * @param {{getLocal?: Function, mutateKey: Function}} store
 * @param {Date|number} [now]
 * @param {{remove?: Function}} [tabs]
 */
export async function sweepCheckRuns(store, now = new Date(), tabs = null) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  /** @type {number[]} */
  const orphans = [];
  await store.mutateKey("checkRuns", (cur) => {
    const runs = cur || {};
    let changed = false;
    const out = { ...runs };
    for (const [src, r] of Object.entries(runs)) {
      if (
        r &&
        r.status === "running" &&
        Number.isFinite(Date.parse(r.startedAt || "")) &&
        nowMs - Date.parse(r.startedAt) > CHECK_TIMEOUT_MS
      ) {
        for (const id of r.tabIds || []) orphans.push(id);
        out[src] = {
          ...r,
          status: "failed",
          reason: "timeout",
          endedAt: new Date(nowMs).toISOString(),
        };
        changed = true;
      }
    }
    return changed ? out : runs;
  });
  if (tabs) {
    for (const id of orphans) {
      try {
        await tabs.remove(id);
      } catch {
        /* already gone */
      }
    }
  }
}

/* ------------------------------ internals ------------------------------ */

async function runCheck(source, run, deps) {
  const adapter = adapterForSource(source);
  const adapterId = adapter ? adapter.id : source;
  /** Item ids this source already had — newItems = after minus before. */
  let before = new Set();
  try {
    before = await sourceItemIds(deps.store, adapterId, source);
  } catch {
    /* count stays best-effort */
  }
  try {
    let outcome;
    if (SYNC_SOURCES.has(source)) {
      outcome = await runSyncCheck(source, adapterId, run, deps);
    } else {
      outcome = await runTabCheck(source, run, deps);
    }
    await finalize(source, run, deps, outcome, before);
  } catch {
    await finalize(source, run, deps, { ok: false, reason: "error" }, before).catch(() => {});
  } finally {
    // Only tabs WE opened get closed — a pre-existing tab is the user's.
    for (const tabId of run.ours) {
      try {
        await deps.tabs.remove(tabId);
      } catch {
        /* already gone */
      }
    }
    live.delete(source);
  }
}

async function runSyncCheck(source, adapterId, run, deps) {
  const res = await deps.runSync(adapterId, "manual");
  let minLastRun = run.startedAtMs;
  if (res && res.ok === false) {
    if (res.reason === "disabled") return { ok: false, reason: "disabled" };
    if (res.reason !== "already-running") return { ok: false, reason: "error" };
    // A sync was already doing this read. Its stamp lands near the end of
    // the run but the run stays in-flight through the post-stamp merge
    // work — so the stamp can predate our start by a little. Count any
    // stamp inside a small grace window as that read's verdict.
    minLastRun = run.startedAtMs - ALREADY_RUNNING_GRACE_MS;
  } else if (!res || !res.ok) {
    return { ok: false, reason: "error" };
  }
  // runSync reports {ok:true} even for a signed-out/no-tab adapter result;
  // the session it stamps on sourceState is the real verdict.
  const st = await recentSourceState(adapterId, run, deps, minLastRun);
  if (!st) return res && res.ok === true ? { ok: true } : { ok: false, reason: "error" };
  return verdictFromState(st);
}

/** How far back a stamp can predate our run and still be the in-flight read's. */
const ALREADY_RUNNING_GRACE_MS = 5 * 60 * 1000;

function verdictFromState(st) {
  if (st.session === "signed-out") return { ok: false, reason: "signed-out" };
  if (st.session === "no-tab") return { ok: false, reason: "not-on-page" };
  if (st.error) return { ok: false, reason: "error" };
  return { ok: true };
}

/**
 * sourceState[adapterId] once it carries a stamp at or after minLastRunMs.
 * A finishing sync always writes lastRunAt; the poll stops at the run
 * deadline.
 */
async function recentSourceState(adapterId, run, deps, minLastRunMs) {
  while (deps.now() - run.startedAtMs < CHECK_TIMEOUT_MS) {
    try {
      const states = (await deps.store.getLocal("sourceState")) || {};
      const st = states[adapterId];
      const lastRun = st && st.lastRunAt ? Date.parse(st.lastRunAt) : 0;
      if (st && lastRun >= minLastRunMs) return st;
    } catch {
      /* keep polling */
    }
    await deps.sleep(1000);
  }
  return null;
}

async function runTabCheck(source, run, deps) {
  const deadline = () => deps.now() - run.startedAtMs > CHECK_TIMEOUT_MS;
  const siteUrl = siteUrlFor(source);

  const tabs = await deps.tabs.query({}).catch(() => []);
  let tab = pickTab(tabs || [], source);
  if (!tab) {
    if (source === "discord") return { ok: false, reason: "not-on-page" };
    if (!siteUrl) return { ok: false, reason: "error" };
    tab = await openTab(deps, run, source, siteUrl);
    if (!tab) return { ok: false, reason: "error" };
  }
  await waitComplete(tab.id, run, deps);

  let answer = await askTab(tab.id, source, run.runId, deps, ANSWER_WAIT_MS, run);

  if (!answer && !run.ours.has(tab.id)) {
    // A pre-existing tab that never answers predates this build — inject
    // its scripts once, give it another window, then fall back to a fresh
    // tab (never Discord: we never open Discord pages).
    try {
      if (deps.reinjectTab) await deps.reinjectTab(tab.id, source);
    } catch {
      /* continue to the fallback */
    }
    if (deadline()) return { ok: false, reason: "timeout" };
    answer = await askTab(tab.id, source, run.runId, deps, REINJECT_ANSWER_WAIT_MS, run);
    if (!answer && source !== "discord" && siteUrl) {
      const t2 = await openTab(deps, run, source, siteUrl);
      if (t2) {
        await waitComplete(t2.id, run, deps);
        answer = await askTab(t2.id, source, run.runId, deps, ANSWER_WAIT_MS, run);
      }
    }
    if (!answer) return { ok: false, reason: "error" };
  }
  if (!answer) return { ok: false, reason: "error" };

  if (answer.accepted === false) {
    if (answer.reason === "not-on-page" && source !== "discord" && siteUrl) {
      // The page isn't on a readable view — a fresh canonical tab gets one.
      const t2 = await openTab(deps, run, source, siteUrl);
      if (!t2) return { ok: false, reason: "error" };
      await waitComplete(t2.id, run, deps);
      answer = await askTab(t2.id, source, run.runId, deps, ANSWER_WAIT_MS, run);
      if (!answer) return { ok: false, reason: "error" };
      if (answer.accepted === false) {
        return { ok: false, reason: answer.reason || "error" };
      }
    } else {
      return { ok: false, reason: answer.reason || "error" };
    }
  }

  // Accepted — the content script finishes with wa1:check-done.
  for (;;) {
    const winner = await Promise.race([
      run.done.then((msg) => ({ msg })),
      deps.sleep(POLL_MS).then(() => null),
    ]);
    if (winner) {
      const msg = winner.msg;
      return { ok: msg.ok !== false, reason: msg.reason, checked: msg.checked };
    }
    if (deadline()) return { ok: false, reason: "timeout" };
    // MV3: a pure-timer wait doesn't keep the service worker alive — the
    // worker dies ~30 s in and run.ours dies with it. One cheap API call
    // per poll resets the idle kill; the sweep cleans up whatever survives
    // a real death (crash/update).
    try {
      if (deps.keepAlive) await deps.keepAlive();
    } catch {
      /* keepalive is best-effort */
    }
  }
}

/**
 * The most recently used non-discarded open tab for this SourceId.
 * @param {any[]} tabs @param {string} source
 */
function pickTab(tabs, source) {
  /** @type {any} */
  let best = null;
  for (const t of tabs || []) {
    if (!t || t.id == null || t.discarded || typeof t.url !== "string") continue;
    if (sourceForTabUrl(t.url) !== source) continue;
    if (!best || (t.lastAccessed || 0) > (best.lastAccessed || 0)) best = t;
  }
  return best;
}

async function openTab(deps, run, source, url) {
  try {
    const tab = await deps.tabs.create({ url, active: false });
    if (tab && tab.id != null) {
      run.ours.add(tab.id);
      // Record the id on the run entry — if the worker dies mid-run the
      // next wake's sweep can still close the tab we opened.
      await deps.store
        .mutateKey("checkRuns", (cur) => {
          const r = cur && cur[source];
          return r && r.runId === run.runId
            ? { ...cur, [source]: { ...r, tabIds: [...(r.tabIds || []), tab.id] } }
            : cur;
        })
        .catch(() => {});
      return tab;
    }
  } catch {
    /* create failed */
  }
  return null;
}

/** Poll tabs.get until "complete" — capped at 30 s AND the run deadline. */
async function waitComplete(tabId, run, deps) {
  const start = deps.now();
  while (
    deps.now() - start < COMPLETE_WAIT_MS &&
    deps.now() - run.startedAtMs < CHECK_TIMEOUT_MS
  ) {
    try {
      const t = await deps.tabs.get(tabId);
      if (t && t.status === "complete") return;
    } catch {
      return; // tab vanished — the send attempts below fail fast anyway
    }
    await deps.sleep(POLL_MS);
  }
}

/**
 * Send {type: CHECK.NOW, source, runId} until a content script answers or
 * `maxMs` passes (also capped by the run's 90 s deadline). A sendMessage
 * rejection = no receiver yet; a hang counts as one failed attempt (raced
 * against the retry interval).
 * @returns {Promise<any | null>} the answer, or null when nothing answered
 */
async function askTab(tabId, source, runId, deps, maxMs, run) {
  const msg = { type: CHECK.NOW, source, runId };
  const start = deps.now();
  while (
    deps.now() - start < maxMs &&
    deps.now() - run.startedAtMs < CHECK_TIMEOUT_MS
  ) {
    const sent = deps.tabs.sendMessage(tabId, msg).then(
      (v) => ({ v }),
      () => null,
    );
    const win = await Promise.race([sent, deps.sleep(SEND_RETRY_MS).then(() => null)]);
    // An undefined resolution is NOT an answer — it means some listener
    // exists (e.g. the email reader) but none claimed the message. Keep
    // retrying until a real {accepted:…} reply or the window expires.
    if (win && typeof win === "object" && "v" in win && win.v != null) {
      return win.v;
    }
  }
  return null;
}

/** Item ids with `item.source === sourceId` inside raw:<adapterId>. */
async function sourceItemIds(store, adapterId, sourceId) {
  const raw = await store.getLocal(`raw:${adapterId}`);
  /** @type {Set<string>} */
  const ids = new Set();
  for (const it of (raw && raw.items) || []) {
    if (it && it.source === sourceId && it.id) ids.add(it.id);
  }
  return ids;
}

/** Scope candidates of the source's essential checklist rows. */
function essentialScopes(source) {
  const entry = CHECK_SOURCES[source];
  /** @type {Set<string>} */
  const scopes = new Set();
  for (const row of (entry && entry.checklist) || []) {
    if (!row || !row.essential) continue;
    for (const s of rowScopes(row)) if (s) scopes.add(s);
  }
  return [...scopes];
}

/**
 * Write the final checkRuns entry, and on an ok run stamp scopeReadAt for
 * the source's essential checklist scopes so "Not read yet" flips right
 * away.
 * @param {Set<string>} beforeIds
 */
async function finalize(source, run, deps, outcome, beforeIds) {
  const adapter = adapterForSource(source);
  const adapterId = adapter ? adapter.id : source;
  let newItems = 0;
  try {
    const after = await sourceItemIds(deps.store, adapterId, source);
    for (const id of after) if (!beforeIds.has(id)) newItems++;
  } catch {
    /* leave 0 */
  }
  const endedAt = new Date(deps.now()).toISOString();
  const entry = {
    runId: run.runId,
    status: outcome.ok ? "ok" : "failed",
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    ...(outcome.checked != null ? { checked: outcome.checked } : {}),
    newItems,
    startedAt: new Date(run.startedAtMs).toISOString(),
    endedAt,
  };
  await deps.store
    .mutateKey("checkRuns", (cur) => ({ ...(cur || {}), [source]: entry }))
    .catch(() => {});
  if (outcome.ok && typeof deps.stampScopes === "function") {
    const scopes = essentialScopes(source);
    if (scopes.length) {
      await deps.stampScopes(source, scopes, new Date(deps.now())).catch(() => {});
    }
  }
}
