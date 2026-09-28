// @ts-check
/*
  Mail backfill core — the shared scheduling/rate/batch machinery behind the
  automatic mail read. Provider-specific acquisition lives in
  gmail-backfill.js (a hidden #search iframe + ?view=pt print views) and
  outlook-backfill.js (the page's MSAL token against the same-origin
  /api/v2.0 REST); this file never builds a URL itself.

  Rules enforced here (README "Network" repeats them):
    - one full backfill per 6 h per provider across tabs/reloads, unless
      lookbackDays changed (adapter-recorded state + a 5 min localStorage
      lock so two tabs never race);
    - incremental reads every 30 min while a tab is open and not frozen;
    - <= 20 requests/minute per provider (list pages + bodies);
    - <= 10 list pages per run; <= 50 messages per payload batch;
    - 15 s per request; any non-200/redirect/login page/non-JSON aborts the
      round and retries in 5 min;
    - a Page Lifecycle freeze drops in-flight work (generation), like atom.js.

  Payloads are the same wa1:observed kind:"dom" shape the passive reader
  sends, with view "backfill" and a backfill{runId,full,lookbackDays,since,
  batch,final,checked} marker the adapter turns into state.backfill.
*/

import { MSG } from "../../core/contract.js";
import { needsBody } from "./rules.js";
import { SENT_FOLDERS } from "./extract.js";

export const BF_TICK_MS = 30 * 60 * 1000;
export const BF_FULL_GAP_MS = 6 * 60 * 60 * 1000;
export const BF_RETRY_MS = 5 * 60 * 1000;
export const BF_LOCK_MS = 5 * 60 * 1000;
export const BF_TIMEOUT_MS = 15000;
export const BF_RATE_PER_MIN = 20;
export const BF_MAX_PAGES = 10;
export const BF_BATCH = 50;
export const BF_LOOKBACK_DAYS = 30;
export const BF_LOCK_PREFIX = "wa1:mail:backfill:lock:";
export const BF_FAIL_PREFIX = "wa1:mail:backfill:fail:";
export const MAIL_CHECK_NOW = "wa1:mail-check-now";

// Bumped on the Page Lifecycle `freeze` event — a round (or part of one)
// that started under an older generation drops whatever lands late.
let generation = 0;
export function backfillFreeze() {
  generation++;
}
/** Test hook — reset the freeze generation. */
export function __resetBackfill() {
  generation = 0;
}

/** settings.lookbackDays: default 30, clamped 7..90. @param {any} v */
export function clampLookback(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return BF_LOOKBACK_DAYS;
  return Math.max(7, Math.min(90, Math.round(n)));
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
 * What this tick should do, from the adapter-recorded state.
 * @param {any} prev    state.backfill[provider] ({lastRunAt,lastFullAt,lookbackDays,newestAt})
 * @param {any} settings  the sources.outlook slice
 * @param {number} nowMs
 * @param {{force?: boolean}} [opts]  force = "check again now" (incremental due immediately)
 * @returns {{kind: "full"|"incremental"|"skip", reason?: string,
 *   lookbackDays: number, since?: string|null}}
 */
export function decideRun(prev, settings, nowMs, { force = false } = {}) {
  const lookbackDays = clampLookback(settings && settings.lookbackDays);
  const p = prev && typeof prev === "object" ? prev : {};
  const lastFullAt = Date.parse(p.lastFullAt || "") || 0;
  const lastRunAt = Date.parse(p.lastRunAt || "") || 0;
  const lookbackChanged =
    p.lookbackDays != null && Number(p.lookbackDays) !== lookbackDays;
  // A full is due on first run, on a lookback change (the only thing allowed
  // inside 6 h), or once the last full is 6 h old.
  if (!lastFullAt || lookbackChanged || nowMs - lastFullAt >= BF_FULL_GAP_MS) {
    return { kind: "full", lookbackDays, since: null };
  }
  if (force || !lastRunAt || nowMs - lastRunAt >= BF_TICK_MS) {
    return { kind: "incremental", lookbackDays, since: p.newestAt || null };
  }
  return { kind: "skip", reason: "throttled", lookbackDays };
}

/** @param {string} s */
const cleanIso = (s) => {
  const t = Date.parse(String(s || ""));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/**
 * One backfill tick for a provider. `impl` is the provider acquisition object:
 *   impl.provider: "gmail"|"outlook"
 *   impl.folders(settings): string[]           ("inbox", +"sent" when opted in)
 *   impl.open(env, plan)  -> ctx | null        null = skip quietly (no token…)
 *   impl.listPage(env, a) -> {messages, threadMap?, nextCursor?} | null
 *   impl.fetchBody(env, a) -> {body?, links?, parts?, subject?, from?} | "abort" | null
 *   impl.close(env, ctx)                       cleanup (iframe removal)
 * where `a` is {ctx, folder, cursor, plan, slot(), request()}.
 *
 * env: {now?, force?, isFrozen?, sleep, sendMessage, getSettings?, getPrev?,
 *   getLock?, setLock?, clearLock?, getFail?, setFail?, fetchImpl, pageUrl?,
 *   setCache?, …provider impl needs (makeFrame, lsValues, account, parseHtml)}.
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

  /** @type {any} */
  let prev = null;
  try {
    prev = env.getPrev ? await env.getPrev() : null;
  } catch {
    prev = null;
  }
  const failAt = Number(env.getFail ? await env.getFail() : 0) || 0;
  if (failAt && nowMs - failAt < BF_RETRY_MS) return done({ skipped: "retry" });

  const plan = decideRun(prev, settings, nowMs, { force: !!env.force });
  if (plan.kind === "skip") return done({ skipped: plan.reason });

  const lockAt = Number(env.getLock ? await env.getLock() : 0) || 0;
  if (lockAt && nowMs - lockAt < BF_LOCK_MS) return done({ skipped: "locked" });
  if (env.setLock) {
    try {
      await env.setLock(nowMs);
    } catch {
      /* lock best-effort */
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
  /** Rate-limited GET-with-timeout; returns the raw response. */
  const request = async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
    await slot();
    const res = await env.fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(BF_TIMEOUT_MS),
    });
    return res;
  };

  const runId = `${impl.provider}-${nowMs.toString(36)}`;
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
          backfill: {
            runId,
            full: plan.kind === "full",
            lookbackDays: plan.lookbackDays,
            since: plan.kind === "full" ? null : plan.since || null,
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

  let ctx = null;
  try {
    ctx = impl.open ? await impl.open(env, { plan }) : {};
    if (ctx == null) return done({ skipped: impl.provider === "outlook" ? "no-token" : "unavailable" });
    const gateCtx = { settings };

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
          if (!sentPass && needsBody(m, gateCtx)) {
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
      if (msgs4Cache(folderMsgs)) cache.push({ folder, messages: folderMsgs });
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
    if (env.clearLock) {
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
    return done({ error: "http", sent });
  }

  if (env.setCache) {
    try {
      env.setCache(cache);
    } catch {
      /* memory only */
    }
  }
  // The final payload lands even when the run found nothing — it is what lets
  // the adapter advance lastRunAt/lastFullAt.
  sendPayload(cache.length ? cache[0].folder : "inbox", [], true);
  return done({ sent });
}

function msgs4Cache(/** @type {any[]} */ msgs) {
  return Array.isArray(msgs) && msgs.length;
}

/**
 * Replay the in-memory cache of the last run as backfill payloads — no
 * network. Used when a settings (filter) change should re-extract what the
 * tab already read. Cache entries: [{folder, messages}].
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
            backfill: {
              runId: `${impl.provider}-replay`,
              full: false,
              lookbackDays: BF_LOOKBACK_DAYS,
              since: null,
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
