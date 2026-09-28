// @ts-check
// Portal content script — page-load auto-fetch (w1.md "v2 additions", option
// 1). Portal's own calls go to portalapi2 with `Authorization: Bearer
// <token>` and no cookies, and the token lives in the page's own
// localStorage, so a GET from this content script is indistinguishable from
// the app's own traffic.
//
// Hard rules:
//   - the token is only ever that request's Authorization header — never
//     stored, never in a message, log, payload, session value or extension
//     storage;
//   - GET only, and never the account-refresh endpoint (a refresh we
//     trigger could rotate the token and sign the user out of their tab);
//   - never throw into the page.
//
// Rounds advance whenever the page is not frozen — a hidden tab that is
// merely backgrounded still runs. Edge freezes hidden tabs and a fetch
// issued just before the freeze can hang until the tab resumes, so progress
// lives in module memory (`pending`), endpoints only ever run once, and
// every fetch carries a `generation` number: the Page Lifecycle `freeze`
// event bumps it, a `resume` re-issues the endpoint that was in flight, and
// the stale promise's late settle is ignored by the generation check — so
// `running` can never stick. `visibilitychange` is only a hint (visible ⇒
// not frozen). A round counts as complete only after all four endpoints
// were attempted — only then is `lastFetch` stamped (30 min gap, 5 min when
// anything failed). A short-lived sessionStorage in-progress marker (2 min)
// keeps a second load from racing a live round, and `wa1:portal:lastRound`
// keeps a redacted per-endpoint summary for debugging.
//
// Every response — including non-2xx — replays to the background as the
// exact wa1:observed "net" payload the passive recorder would have
// forwarded, so observe.parse and everything downstream behave as if the
// page itself had called the API (a replayed 401 marks the session
// signed-out; other failures land as 0-item readStats).

import { MSG } from "../../core/contract.js";
import { CHECK } from "../../core/messages.js";
import { guardInstance } from "../../capture/guard.js";
import { zonedParts } from "../../lib/textdates/index.js";

export const API_BASE = "https://portalapi2.uwaterloo.ca";
export const FETCH_TIMEOUT_MS = 15000;
export const ROUND_INTERVAL_MS = 60 * 60 * 1000;
export const ROUND_MIN_GAP_MS = 30 * 60 * 1000;
export const ROUND_RETRY_GAP_MS = 5 * 60 * 1000;
export const INPROGRESS_TTL_MS = 2 * 60 * 1000;
export const LAST_FETCH_KEY = "wa1:portal:lastFetch";
export const INPROGRESS_KEY = "wa1:portal:inProgress";
export const LAST_ROUND_KEY = "wa1:portal:lastRound";
export const TOKEN_KEY = "auth.portal.token";
const BODY_CAP = 5000000; // same cap the recorder applies to observed bodies

const dayMs = 24 * 60 * 60 * 1000;

/** "YYYY-MM-DD" for the Toronto calendar day `ms` after `now`. */
function ymd(now, ms) {
  const p = zonedParts(new Date(now.getTime() + ms));
  const iso = new Date(Date.UTC(p.y, p.m - 1, p.d)).toISOString();
  return iso.slice(0, 10);
}

/**
 * The four endpoints of a round, in fetch order. DailyEventsV2's query
 * names (`start`/`end`, YYYY-MM-DD) are our best reading of the app bundle —
 * see README "needs tuning".
 * @param {Date} now
 */
export function portalFetchUrls(now) {
  return [
    `${API_BASE}/v2/student/CourseEnrollments/`,
    `${API_BASE}/v2/student/CourseSchedule/`,
    `${API_BASE}/v2/student/ExamSchedule/`,
    `${API_BASE}/v2/Calendar/DailyEventsV2?start=${ymd(now, -7 * dayMs)}&end=${ymd(now, 120 * dayMs)}`,
  ];
}

/** @type {{next: number, results: any[], token: string, now: Date}|null} */
let pending = null;
/** The runRound currently executing: a token so a stale holder can't free
 *  a newer holder's lock when it finally returns. */
let running = 0;
let tokenSeq = 0;
// Bumped on every Page Lifecycle `freeze`: a fetch issued under an older
// generation that settles late is stale and its result is dropped.
let generation = 0;
/** The endpoint index + generation of the fetch in flight, if any. */
/** @type {{index: number, gen: number}|null} */
let inFlight = null;

/** Test hook — drop any in-flight round state. */
export function __resetPortalRound() {
  pending = null;
  running = 0;
  tokenSeq = 0;
  generation = 0;
  inFlight = null;
}

/** The page froze: every in-flight fetch is now stale. */
export function portalFreeze() {
  generation++;
}

const pathOf = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split("?")[0];
  }
};

const frozen = (env) => (typeof env.isFrozen === "function" ? !!env.isFrozen() : false);

/**
 * One fetch-round attempt: start or continue the round — while the page is
 * not frozen — and replay each response as the passive `wa1:observed` net
 * payload. `env` is injected so tests can drive fakes; the live wiring
 * below binds the real page APIs. Returns counts — never the token, never
 * throws.
 * @param {{
 *   fetchImpl: (url: string, init: RequestInit) => Promise<any>,
 *   sendMessage: (msg: any) => void,
 *   getToken: () => string | null,
 *   getLast: () => number,
 *   setLast: (ms: number) => void,
 *   getInProgress?: () => number,
 *   setInProgress?: (ms: number) => void,
 *   getRoundSummary?: () => any,
 *   setRoundSummary?: (summary: any) => void,
 *   isFrozen?: () => boolean,
 *   now?: Date,
 *   force?: boolean,
 * }} env
 */
export async function portalRound(env) {
  const now = env.now || new Date();
  if (frozen(env)) return { skipped: "frozen", sent: 0 };

  // Resume after a freeze: the endpoint in flight at freeze-time went stale
  // with the generation bump — re-issue it here. Its late settle is ignored
  // by runRound's generation check, and the stale holder's finally only
  // clears its own lock token.
  if (inFlight && inFlight.gen !== generation) {
    if (pending) pending.next = inFlight.index;
    inFlight = null;
    running = 0;
  }

  if (!pending) {
    const last = Number(env.getLast()) || 0;
    if (!env.force && last && now.getTime() - last < ROUND_MIN_GAP_MS) {
      // A round with failures retries early; a clean round waits the full gap.
      const summary = env.getRoundSummary ? env.getRoundSummary() : null;
      const failed =
        !!(summary && summary.error) ||
        (summary && Array.isArray(summary.results) && summary.results.some((r) => r && r.error));
      const gap = failed ? ROUND_RETRY_GAP_MS : ROUND_MIN_GAP_MS;
      if (now.getTime() - last < gap) return { skipped: "throttled", sent: 0 };
    }
    const ip = Number(env.getInProgress ? env.getInProgress() : 0) || 0;
    if (ip && now.getTime() - ip < INPROGRESS_TTL_MS) {
      return { skipped: "in-progress", sent: 0 };
    }
    const token = env.getToken();
    if (!token) {
      if (env.setRoundSummary) {
        env.setRoundSummary({ at: now.toISOString(), error: "no-token", results: [] });
      }
      return { skipped: "no-token", sent: 0 };
    }
    pending = { next: 0, results: [], token, now };
    if (env.setInProgress) env.setInProgress(now.getTime());
  } else {
    // The token may have been refreshed while the tab was frozen.
    const token = env.getToken();
    if (!token) return { skipped: "no-token", sent: 0 };
    pending.token = token;
  }

  if (running) return { skipped: "in-flight", sent: 0 };
  const token = ++tokenSeq;
  running = token;
  try {
    return await runRound(env, /** @type {NonNullable<typeof pending>} */ (pending));
  } finally {
    if (running === token) running = 0;
  }
}

/**
 * @param {any} env
 * @param {{next: number, results: any[], token: string, now: Date}} round
 */
async function runRound(env, round) {
  const urls = portalFetchUrls(round.now);
  let sent = 0;
  while (round.next < urls.length) {
    // A frozen page's task queue doesn't run: stop advancing so a resume
    // picks the round up here instead of issuing a fetch that hangs.
    if (frozen(env)) return { paused: true, sent };
    const index = round.next;
    const url = urls[index];
    const first = index === 0;
    const gen = generation;
    round.next++;
    inFlight = { index, gen };
    const t0 = Date.now();
    /** @type {any} */
    let res;
    /** @type {string|undefined} */
    let error;
    try {
      res = await env.fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${round.token}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      const name = e && /** @type {any} */ (e).name;
      error = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
    }
    if (inFlight && inFlight.gen === gen) inFlight = null;
    if (gen !== generation) {
      // A freeze bumped the generation while this fetch was in flight. The
      // result is stale — whoever resumed already re-issued the endpoint.
      return { stale: true, sent };
    }
    const ms = Date.now() - t0;
    const status = res ? Number(res.status) || 0 : 0;
    if (!error && !(status >= 200 && status < 300)) error = `http-${status}`;
    round.results.push({ path: pathOf(url), status, ms, ...(error ? { error } : {}) });
    if (res) {
      await replay(env, url, res);
      sent++;
      // A dead session on the first request ends the round; later in the
      // round that endpoint is skipped and the rest still run.
      if (first && (status === 401 || status === 403)) break;
    }
  }
  // Round complete: stamp the gap marker and the redacted summary, release
  // the in-progress lock and this context's resume state.
  const end = env.now || new Date();
  if (env.setLast) env.setLast(end.getTime());
  if (env.setRoundSummary) {
    env.setRoundSummary({ at: end.toISOString(), results: round.results });
  }
  if (env.setInProgress) env.setInProgress(0);
  pending = null;
  return { sent, done: true, results: round.results.length };
}

/**
 * Replay a response byte-for-byte as the passive recorder's net payload —
 * any status, since the passive path forwards 4xx/5xx too (the background
 * records a readStat either way, and a 401 marks the session signed-out).
 * @param {any} env @param {string} url @param {any} res
 */
async function replay(env, url, res) {
  let body = "";
  try {
    const text = await res.text();
    if (typeof text === "string") body = text.slice(0, BODY_CAP);
  } catch {
    /* empty body is fine */
  }
  let contentType = "";
  try {
    contentType = (res.headers && res.headers.get("content-type")) || "";
  } catch {
    /* keep "" */
  }
  env.sendMessage({
    type: MSG.OBSERVED,
    payload: {
      source: "portal",
      kind: "net",
      url,
      method: "GET",
      status: Number(res.status) || 0,
      contentType,
      body,
      at: new Date().toISOString(),
    },
  });
}

/* ------------------------------ live wiring ------------------------------ */

(() => {
  try {
    // W1 re-injects content scripts into open tabs on install/update/startup
    // — a live copy answers the ping and we return; an orphan is superseded
    // and runs teardown. See src/capture/guard.js.
    if (!guardInstance("portal-content", teardown)) return;
    if (
      typeof location === "undefined" ||
      location.hostname !== "portal.uwaterloo.ca" ||
      typeof chrome === "undefined" ||
      !chrome.runtime ||
      typeof chrome.runtime.sendMessage !== "function"
    ) {
      return;
    }
    const env = {
      fetchImpl: (/** @type {any} */ url, /** @type {any} */ init) => fetch(url, init),
      sendMessage: (/** @type {any} */ msg) => {
        try {
          Promise.resolve(chrome.runtime.sendMessage(msg)).catch(() => {});
        } catch {
          /* context invalidated */
        }
      },
      getToken: () => {
        try {
          return localStorage.getItem(TOKEN_KEY);
        } catch {
          return null;
        }
      },
      getLast: () => {
        try {
          return Number(sessionStorage.getItem(LAST_FETCH_KEY)) || 0;
        } catch {
          return 0;
        }
      },
      setLast: (/** @type {number} */ ms) => {
        try {
          sessionStorage.setItem(LAST_FETCH_KEY, String(ms));
        } catch {
          /* storage can be disabled — the in-memory fetch still ran once */
        }
      },
      getInProgress: () => {
        try {
          return Number(sessionStorage.getItem(INPROGRESS_KEY)) || 0;
        } catch {
          return 0;
        }
      },
      setInProgress: (/** @type {number} */ ms) => {
        try {
          if (ms) sessionStorage.setItem(INPROGRESS_KEY, String(ms));
          else sessionStorage.removeItem(INPROGRESS_KEY);
        } catch {
          /* storage can be disabled */
        }
      },
      getRoundSummary: () => {
        try {
          const raw = sessionStorage.getItem(LAST_ROUND_KEY);
          return raw ? JSON.parse(raw) : null;
        } catch {
          return null;
        }
      },
      setRoundSummary: (/** @type {any} */ summary) => {
        try {
          sessionStorage.setItem(LAST_ROUND_KEY, JSON.stringify(summary));
        } catch {
          /* storage can be disabled */
        }
      },
      isFrozen: () => frozenNow,
    };
    let frozenNow = false;
    /** In-flight round promise — a check-now during one joins it. */
    /** @type {Promise<any>|null} */
    let roundP = null;
    const run = (/** @type {boolean} */ force) => {
      if (!roundP) {
        roundP = portalRound({ ...env, force, now: new Date() })
          .catch(() => ({ error: "run" }))
          .finally(() => {
            roundP = null;
          });
      }
      return roundP;
    };
    const tick = () => {
      run(false).catch(() => {});
    };
    tick(); // this load
    const tickTimer = setInterval(tick, ROUND_INTERVAL_MS); // hourly while the tab stays open
    // "Check again now" (panel → background → tab): reply accepted at
    // once — signed-out when the page holds no token — then run a forced
    // round (the 30-min gap bypassed, the 401 stop not) and report
    // check-done when it lands.
    const onCheckNow = (/** @type {any} */ msg, /** @type {any} */ _sender, /** @type {any} */ sendResponse) => {
      if (!msg || msg.type !== CHECK.NOW) return false;
      if (String(msg.source || "") !== "portal") return false;
      if (!env.getToken()) {
        sendResponse({ accepted: false, reason: "signed-out" });
        return false;
      }
      sendResponse({ accepted: true });
      run(true)
        .then((res) => {
          const r = res && typeof res === "object" ? res : {};
          const skip = String(r.skipped || "");
          const done = r.stale || skip === "frozen" || r.paused
            ? { ok: false, reason: "timeout" }
            : r.error || skip === "no-token"
              ? { ok: false, reason: skip === "no-token" ? "signed-out" : "error" }
              : skip
                ? { ok: false, reason: "error" }
                : { ok: true };
          env.sendMessage({
            type: CHECK.DONE,
            source: String(msg.source || ""),
            runId: String(msg.runId || ""),
            checked: Number(r.results) || Number(r.sent) || 0,
            ...done,
          });
        })
        .catch(() => {});
      return false;
    };
    try {
      chrome.runtime.onMessage.addListener(onCheckNow);
    } catch {
      /* older runtimes */
    }
    // Page Lifecycle: a freeze makes every in-flight fetch stale (the
    // generation bump); resume/visibility-change clear the flag and
    // continue the round where it stopped.
    const onFreeze = () => {
      frozenNow = true;
      portalFreeze();
    };
    const onResume = () => {
      frozenNow = false;
      tick();
    };
    const onVis = () => {
      if (document.visibilityState === "visible") {
        frozenNow = false;
        tick();
      }
    };
    try {
      document.addEventListener("freeze", onFreeze);
      document.addEventListener("resume", onResume);
      document.addEventListener("visibilitychange", onVis);
    } catch {
      /* older runtimes lack the Page Lifecycle events */
    }

    /**
     * Everything this instance wired — run by guardInstance's supersede
     * when a re-injected copy takes over (our chrome.runtime is dead).
     */
    function teardown() {
      clearInterval(tickTimer);
      try {
        chrome.runtime.onMessage.removeListener(onCheckNow);
      } catch {
        /* dead context */
      }
      document.removeEventListener("freeze", onFreeze);
      document.removeEventListener("resume", onResume);
      document.removeEventListener("visibilitychange", onVis);
    }
  } catch {
    /* never throw into the page */
  }
})();
