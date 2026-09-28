// @ts-check
// Portal content script — page-load auto-fetch (w1.md "v2 additions", option
// 1). Portal's own calls go to portalapi2 with `Authorization: Bearer
// <token>` and no cookies, and the token lives in the page's own
// localStorage, so a GET from this content script is indistinguishable from
// the app's own traffic.
//
// Hard rules:
//   - the token is only ever that request's Authorization header — never
//     stored, never in a message, log, payload or extension storage;
//   - GET only, and never the account-refresh endpoint (a refresh we
//     trigger could rotate the token and sign the user out of their tab);
//   - missing token, 401 or 403: stop the round and send nothing;
//   - never throw into the page.
//
// Every response replays to the background as the exact wa1:observed "net"
// payload the passive recorder would have forwarded, so observe.parse and
// everything downstream behave as if the page itself had called the API.

import { MSG } from "../../core/contract.js";
import { zonedParts } from "../../lib/textdates/index.js";

export const API_BASE = "https://portalapi2.uwaterloo.ca";
export const FETCH_TIMEOUT_MS = 15000;
export const ROUND_INTERVAL_MS = 60 * 60 * 1000;
export const ROUND_MIN_GAP_MS = 30 * 60 * 1000;
export const LAST_FETCH_KEY = "wa1:portal:lastFetch";
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

/**
 * One fetch round: token → 4 sequential GETs → replay each response as the
 * passive `wa1:observed` net payload. `env` is injected so tests can drive
 * fakes; the live wiring below binds the real page APIs. Returns counts —
 * never the token, never throws.
 * @param {{
 *   fetchImpl: (url: string, init: RequestInit) => Promise<any>,
 *   sendMessage: (msg: any) => void,
 *   getToken: () => string | null,
 *   getLast: () => number,
 *   setLast: (ms: number) => void,
 *   now?: Date,
 * }} env
 */
export async function portalRound(env) {
  const now = env.now || new Date();
  const last = Number(env.getLast()) || 0;
  if (last && now.getTime() - last < ROUND_MIN_GAP_MS) return { skipped: "throttled", sent: 0 };
  const token = env.getToken();
  if (!token) return { skipped: "no-token", sent: 0 };
  env.setLast(now.getTime());

  let sent = 0;
  for (const url of portalFetchUrls(now)) {
    /** @type {any} */
    let res;
    try {
      res = await env.fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      continue; // timeout/offline — try the next endpoint
    }
    const status = Number(res && res.status) || 0;
    // The session is gone or the token expired: stop quietly and replay
    // nothing (the passive path still catches the app's own calls).
    if (status === 401 || status === 403) break;
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
        status,
        contentType,
        body,
        at: new Date().toISOString(),
      },
    });
    sent++;
  }
  return { skipped: null, sent };
}

/* ------------------------------ live wiring ------------------------------ */

(() => {
  try {
    if (
      typeof location === "undefined" ||
      location.hostname !== "portal.uwaterloo.ca" ||
      typeof chrome === "undefined" ||
      !chrome.runtime ||
      typeof chrome.runtime.sendMessage !== "function"
    ) {
      return;
    }
    /** @type {{fetchImpl: any, sendMessage: any, getToken: any, getLast: any, setLast: any}} */
    const env = {
      fetchImpl: (url, init) => fetch(url, init),
      sendMessage: (msg) => {
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
      setLast: (ms) => {
        try {
          sessionStorage.setItem(LAST_FETCH_KEY, String(ms));
        } catch {
          /* storage can be disabled — the in-memory fetch still ran once */
        }
      },
    };
    const tick = () => {
      portalRound(env).catch(() => {});
    };
    tick(); // this load
    setInterval(tick, ROUND_INTERVAL_MS); // then hourly while the tab stays open
  } catch {
    /* never throw into the page */
  }
})();
