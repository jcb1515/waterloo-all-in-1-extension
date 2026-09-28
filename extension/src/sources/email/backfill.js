// @ts-check
/*
  Mail backfill core — the shared scheduling/rate/batch machinery behind the
  automatic mail read. Provider-specific acquisition lives in
  gmail-backfill.js (the tab's own inbox DOM + ?view=pt print views) and
  outlook-backfill.js (the page's MSAL token against the same-origin
  /api/v2.0 REST); this file never builds a URL itself.

  Rules enforced here (README "Network" repeats them):
    - automatic runs when the adapter-recorded check[provider].at is >=30 min
      old — there is no full/incremental split, no lookback cursor;
    - forced runs (check-now) bypass the 30-min gate and the cross-tab lock,
      never the rate cap or the provider-off kill switch;
    - a per-tab in-flight join: a check-now during a running run shares it;
      the cross-tab localStorage lock (3 min TTL) applies to automatic runs
      only;
    - <= 20 requests/minute per provider (list pages + bodies);
    - <= 10 list pages per run; <= 50 messages per payload batch;
    - 15 s per request; any non-200/redirect/login page/non-JSON aborts the
      run and retries in 5 min;
    - a Page Lifecycle freeze drops in-flight work (generation), like atom.js.

  Payloads are the same wa1:observed kind:"dom" shape the passive reader
  sends, with view "backfill" and a check{runId,batch,final,checked,since,
  ok?,reason?} marker the adapter turns into state.check[provider].
*/

import { MSG } from "../../core/contract.js";
import { needsBody } from "./rules.js";
import { SENT_FOLDERS } from "./extract.js";

export const BF_TICK_MS = 30 * 60 * 1000;
export const BF_RETRY_MS = 5 * 60 * 1000;
export const BF_LOCK_MS = 3 * 60 * 1000;
export const BF_TIMEOUT_MS = 15000;
export const BF_RATE_PER_MIN = 20;
export const BF_MAX_PAGES = 10;
export const BF_BATCH = 50;
export const BF_LOCK_PREFIX = "wa1:mail:backfill:lock:";
export const BF_FAIL_PREFIX = "wa1:mail:backfill:fail:";
export const OUTLOOK_COUNTS = [50, 100, 200];
export const CHECK_NOW = "wa1:check-now";
export const CHECK_DONE = "wa1:check-done";

// Bumped on the Page Lifecycle `freeze` event — a run (or part of one)
// that started under an older generation drops whatever lands late.
let generation = 0;
export function backfillFreeze() {
  generation++;
}
/** Test hook — reset the freeze generation. */
export function __resetBackfill() {
  generation = 0;
}

/**
 * Content-script double-injection guard: W1 re-injects scripts into open
 * tabs after install/update/startup; the second copy must leave its
 * listeners unregistered. `key` is the source name (__wa1_email etc.).
 * @param {string} key
 */
export function injectOnce(key) {
  const g = /** @type {any} */ (globalThis);
  const k = `__wa1_${key}`;
  if (g[k]) return false;
  g[k] = true;
  return true;
}

/**
 * True while a Gmail tab shows the first inbox page — "" / "#inbox" /
 * "#inbox?…". A second page ("#inbox/p2") or an open thread
 * ("#inbox/<id>") does not count.
 * @param {string} hash
 */
export function gmailOnInbox(hash) {
  const h = String(hash || "");
  return h === "" || h === "#inbox" || h.startsWith("#inbox?");
}

/**
 * The check-now decision for one tab: null = the message isn't for this
 * tab (wrong type, or another provider's tab), otherwise the reply to
 * sendResponse. `source` accepts the provider, or "email" (any mail tab).
 * @param {any} msg
 * @param {string} provider  "gmail"|"outlook"
 * @param {{onPage?: () => boolean, hasToken?: () => boolean,
 *   disabled?: () => boolean}} [opts]
 */
export function checkNowDecision(msg, provider, opts = {}) {
  if (!msg || msg.type !== CHECK_NOW) return null;
  const src = String(msg.source || "");
  if (src !== "email" && src !== provider) return null;
  if (opts.disabled && opts.disabled()) return { accepted: false, reason: "disabled" };
  if (opts.onPage && !opts.onPage()) return { accepted: false, reason: "not-on-page" };
  if (opts.hasToken && !opts.hasToken()) return { accepted: false, reason: "signed-out" };
  return { accepted: true };
}

/**
 * Map a finished run's stats to the check-done fields {ok, reason?,
 * checked} — shared so the listener and tests agree.
 * @param {any} r  backfillRound's return
 */
export function doneFromResult(r) {
  const res = r && typeof r === "object" ? r : {};
  const checked = Number(res.listed) || 0;
  if (res.stale) return { ok: false, reason: "timeout", checked };
  if (res.error) return { ok: false, reason: "error", checked };
  const skip = String(res.skipped || "");
  if (skip === "no-token") return { ok: false, reason: "signed-out", checked };
  if (skip === "off") return { ok: false, reason: "disabled", checked };
  if (skip === "not-on-page") return { ok: false, reason: "not-on-page", checked };
  if (skip) return { ok: false, reason: "error", checked };
  return { ok: true, checked };
}

/**
 * Per-tab run registry: one in-flight run at a time; a joiner (check-now
 * during a run) shares the same promise — each caller still gets its own
 * check-done via its own .then on the returned promise.
 * @param {(force: boolean) => Promise<any>} start
 */
export function makeRunBox(start) {
  /** @type {Promise<any>|null} */
  let pending = null;
  return {
    get running() {
      return !!pending;
    },
    /** @param {boolean} force */
    run(force) {
      if (!pending) {
        try {
          // start() runs synchronously so callers observe `running` and a
          // same-tick second call joins rather than double-starts.
          pending = Promise.resolve(start(force)).catch(() => ({ error: "run" }));
        } catch {
          pending = Promise.resolve({ error: "run" });
        }
      }
      return pending.finally(() => {
        // Only clear when this promise is still the current one — a run
        // that started after ours finished must not be nulled by us.
        pending = null;
      });
    },
  };
}

/** settings.outlookCount: one of 50/100/200, default 100. @param {any} v */
export function clampOutlookCount(v) {
  const n = Number(v);
  return OUTLOOK_COUNTS.includes(n) ? n : 100;
}

/**
 * Rolling-window rate gate: at most RATE_PER_MIN timestamps inside any 60 s.
 */
export function makeRate() {
  /** @type {number[]} */
  const times = [];
  return {
    /** ms until the next request is allowed (0 = take it now). @param {number} nowMs */
    waitMs(nowMs) {
      while (times.length && nowMs - times[0] >= 60000) times.shift();
      if (times.length < BF_RATE_PER_MIN) return 0;
      return Math.max(0, times[0] + 60000 - nowMs);
    },
    /** @param {number} nowMs */
    take(nowMs) {
      times.push(nowMs);
    },
    get size() {
      return times.length;
    },
  };
}

/**
 * One mail read for a provider. `impl` is the provider acquisition object:
 *   impl.provider: "gmail"|"outlook"
 *   impl.skipReason: "no-token"|"not-on-page"   (what an open()->null means)
 *   impl.folders(settings): string[]           ("inbox", +"sent" when opted in)
 *   impl.open(env, plan)  -> ctx | null        null = skip with skipReason
 *   impl.listPage(env, a) -> {messages, threadMap?, nextCursor?} | null
 *   impl.fetchBody(env, a) -> {body?, links?, parts?, subject?, from?} | "abort" | null
 *   impl.close(env, ctx)                       cleanup
 * where `a` is {ctx, folder, cursor, plan, slot(), request()}.
 *
 * env: {now?, force?, isFrozen?, sleep, sendMessage, getSettings?,
 *   getPrev? (state.check[provider]), getLock?/setLock?/clearLock?,
 *   getFail?/setFail?, fetchImpl, pageUrl?, setCache?, …provider impl needs
 *   (doc/onInbox, lsValues, account, parseHtml)}.
 * @param {any} env
 * @param {any} impl
 */
export async function backfillRound(env, impl) {
  const now = env.now || new Date();
  const nowMs = now.getTime();
  const t0 = Date.now();
  const stats = { requests: 0, peakRate: 0, pages: 0, bodies: 0, listed: 0 };
  const done = (extra = {}) => ({ sent: 0, ms: Date.now() - t0, ...stats, ...extra });
  if (typeof env.isFrozen === "function" && env.isFrozen()) return done({ skipped: "frozen" });

  /** @type {any} */
  let settings;
  try {
    settings = env.getSettings ? await env.getSettings() : {};
  } catch {
    settings = {};
  }
  settings = settings || {};
  if (settings[impl.provider] === false) return done({ skipped: "off" });

  const force = !!env.force;
  if (!force) {
    // Automatic runs only: the 30-min gate (adapter-recorded check.at),
    // the 5-min failure retry window and the cross-tab localStorage lock.
    /** @type {any} */
    let prev = null;
    try {
      prev = env.getPrev ? await env.getPrev() : null;
    } catch {
      prev = null;
    }
    const failAt = Number(env.getFail ? await env.getFail() : 0) || 0;
    if (failAt && nowMs - failAt < BF_RETRY_MS) return done({ skipped: "retry" });
    const lastAt = Date.parse((prev && prev.at) || "") || 0;
    if (lastAt && nowMs - lastAt < BF_TICK_MS) return done({ skipped: "throttled" });
    const lockAt = Number(env.getLock ? await env.getLock() : 0) || 0;
    if (lockAt && nowMs - lockAt < BF_LOCK_MS) return done({ skipped: "locked" });
    if (env.setLock) {
      try {
        await env.setLock(nowMs);
      } catch {
        /* lock best-effort */
      }
    }
  }

  const gen = generation;
  const stale = () => gen !== generation || (env.isFrozen && env.isFrozen());
  const rate = makeRate();
  /** Wait out the rolling window, then mark one request slot. */
  const slot = async () => {
    for (;;) {
      if (stale()) throw new Error("stale");
      const wait = rate.waitMs(Date.now());
      stats.peakRate = Math.max(stats.peakRate, rate.size);
      if (wait <= 0) break;
      await (env.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))))(wait);
    }
    rate.take(Date.now());
    stats.requests++;
    stats.peakRate = Math.max(stats.peakRate, rate.size);
  };
  /** Rate-limited GET-with-timeout; returns the raw response. Hard guard:
   * GET only, same-origin relative paths only — anything else throws. */
  const request = async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
    const method = String((init && init.method) || "GET").toUpperCase();
    if (method !== "GET") throw new Error("backfill: non-GET request refused");
    const u = String(url || "");
    if (!u.startsWith("/") || u.startsWith("//")) {
      throw new Error("backfill: off-origin request refused");
    }
    await slot();
    const res = await env.fetchImpl(u, {
      ...init,
      signal: AbortSignal.timeout(BF_TIMEOUT_MS),
    });
    return res;
  };

  const runId = `${impl.provider}-${nowMs.toString(36)}`;
  const since = new Date(t0).toISOString();
  const checked = new Set();
  let sent = 0;
  let batch = 0;
  let failed = false;
  /** @type {Record<string, any>} */
  let threadMap = {};
  /** @type {{folder: string, messages: any[]}[]} */
  const cache = [];

  const sendPayload = (/** @type {string} */ folder, /** @type {any[]} */ messages, /** @type {boolean} */ final, /** @type {any} */ extra = {}) => {
    env.sendMessage({
      type: MSG.OBSERVED,
      payload: {
        source: impl.provider,
        kind: "dom",
        url: env.pageUrl || "",
        body: JSON.stringify({
          v: 1,
          provider: impl.provider,
          folder,
          view: "backfill",
          messages,
          ...(Object.keys(threadMap).length ? { threadMap } : {}),
          check: {
            runId,
            since,
            batch: batch++,
            final,
            checked: checked.size,
            ...extra,
          },
        }),
        at: new Date().toISOString(),
      },
    });
    sent++;
  };

  const plan = { count: clampOutlookCount(settings.outlookCount) };
  /** @type {any} */
  let ctx = null;
  try {
    ctx = impl.open ? await impl.open(env, plan) : {};
    if (ctx == null) return done({ skipped: impl.skipReason || "unavailable" });

    for (const folder of impl.folders(settings)) {
      /** @type {any} */
      let cursor = null;
      const folderMsgs = [];
      for (;;) {
        if (stale()) return done({ stale: true, sent });
        if (stats.pages >= BF_MAX_PAGES) break;
        // eslint-disable-next-line no-await-in-loop
        const page = await impl.listPage(env, { ctx, folder, cursor, plan, slot, request });
        if (!page) {
          failed = true;
          break;
        }
        stats.pages++;
        const msgs = (page.messages || []).filter((/** @type {any} */ m) => m && m.key);
        if (page.threadMap) Object.assign(threadMap, page.threadMap);
        const sentPass = SENT_FOLDERS.has(String(folder).toLowerCase());
        for (const m of msgs) {
          checked.add(String(m.key));
          // Bodies only for gated candidates — bulk senders without a gated
          // reason never cost a request, and the sent pass reads nothing
          // (its rows only close reply tasks).
          if (!sentPass && needsBody(m, { settings })) {
            // eslint-disable-next-line no-await-in-loop
            const body = await impl.fetchBody(env, { ctx, msg: m, folder, slot, request });
            if (body === "abort") {
              failed = true;
              break;
            }
            if (body) {
              Object.assign(m, body);
              m.bodyFetched = true;
              stats.bodies++;
            }
          }
        }
        if (failed) break;
        stats.listed += msgs.length;
        folderMsgs.push(...msgs);
        for (let i = 0; i < msgs.length; i += BF_BATCH) {
          sendPayload(folder, msgs.slice(i, i + BF_BATCH), false);
        }
        cursor = page.nextCursor || null;
        if (!cursor) break;
      }
      if (folderMsgs.length) cache.push({ folder, messages: folderMsgs });
      if (failed) break;
    }
  } catch (e) {
    if (String((e && /** @type {any} */ (e).message) || e) === "stale") {
      return done({ stale: true, sent });
    }
    failed = true;
  } finally {
    try {
      if (impl.close && ctx != null) impl.close(env, ctx);
    } catch {
      /* cleanup best-effort */
    }
    if (!force && env.clearLock) {
      try {
        await env.clearLock();
      } catch {
        /* best-effort */
      }
    }
  }

  if (failed) {
    if (env.setFail) {
      try {
        await env.setFail(nowMs);
      } catch {
        /* best-effort */
      }
    }
    // A failure still lands a final marker — state.check records
    // {ok:false, reason:"error"} so Setup isn't left on "Checking…".
    sendPayload(cache.length ? cache[0].folder : "inbox", [], true, {
      ok: false,
      reason: "error",
    });
    return done({ error: "http", sent });
  }

  if (env.setCache) {
    try {
      env.setCache(cache);
    } catch {
      /* memory only */
    }
  }
  // The final payload lands even when the run found nothing — it is what
  // advances state.check[provider].at (an empty inbox is still "read").
  sendPayload(cache.length ? cache[0].folder : "inbox", [], true, { ok: true });
  return done({ sent });
}

/**
 * Replay the in-memory cache of the last run as backfill payloads — no
 * network. Used when a settings (filter) change should re-extract what the
 * tab already read. Cache entries: [{folder, messages}]. Replay payloads
 * carry check.replay — the adapter never lets them touch state.check.
 * @param {any} env @param {any} impl
 */
export function replayCache(env, impl) {
  const cache = env.getCache ? env.getCache() : null;
  if (!Array.isArray(cache) || !cache.length) return { sent: 0 };
  let sent = 0;
  for (const entry of cache) {
    const msgs = (entry && entry.messages) || [];
    for (let i = 0; i < msgs.length; i += BF_BATCH) {
      env.sendMessage({
        type: MSG.OBSERVED,
        payload: {
          source: impl.provider,
          kind: "dom",
          url: env.pageUrl || "",
          body: JSON.stringify({
            v: 1,
            provider: impl.provider,
            folder: entry.folder || "inbox",
            view: "backfill",
            messages: msgs.slice(i, i + BF_BATCH),
            check: {
              runId: `${impl.provider}-replay`,
              since: new Date().toISOString(),
              batch: Math.floor(i / BF_BATCH),
              final: i + BF_BATCH >= msgs.length,
              checked: msgs.length,
              replay: true,
            },
          }),
          at: new Date().toISOString(),
        },
      });
      sent++;
    }
  }
  return { sent };
}
