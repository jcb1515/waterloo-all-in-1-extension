// @ts-check
// Course-outline content script — passive DOM snapshotter (T3) plus one
// in-tab fetch round (README "Network"). While an outline.uwaterloo.ca page
// is open and not frozen it GETs every known outline URL — courses' stored
// `outlineUrl` ∪ `wa1Settings.sources.outline.urls` — same-origin with the
// page's own cookies, and replays each page as the exact wa1:observed
// "dom" payload the passive snapshotter sends.
//
// Hard rules:
//   - GETs only, and only https://outline.uwaterloo.ca/viewer/view/… URLs;
//   - chrome.storage.local is READ-only (the throttle stamp lives in
//     sessionStorage); no tokens anywhere;
//   - a freeze mid-fetch drops the stale result (generation) so a resumed
//     tab re-issues exactly that URL once;
//   - never throw into the page.

export const FETCH_TIMEOUT_MS = 15000;
export const ROUND_GAP_MS = 6 * 60 * 60 * 1000;
export const ROUND_RETRY_MS = 5 * 60 * 1000;
export const INPROGRESS_TTL_MS = 2 * 60 * 1000;
export const TICK_MS = 60 * 60 * 1000;
export const LAST_KEY = "wa1:outline:lastFetch";
export const INPROGRESS_KEY = "wa1:outline:inProgress";
const ORIGIN = "https://outline.uwaterloo.ca";
const VIEW_PREFIX = `${ORIGIN}/viewer/view/`;
const MAX_BYTES = 3 * 1024 * 1024;
// Mirror of index.js' LOGIN_WORDS — kept inline so this bundle stays lean.
const LOGIN_WORDS = /duo|shibboleth|saml|oidc|adfs|idp\.uwaterloo|sign[ -]?in|log[ -]?in/i;

/**
 * Every outline URL worth fetching: courses' `outlineUrl` union
 * `wa1Settings.sources.outline.urls`, host-filtered and deduped by
 * origin+pathname. `courses` accepts the stored array or a code-keyed map.
 * @param {any} courses
 * @param {any} settings the wa1Settings bag (or its sources.outline slice's parent)
 */
export function collectOutlineUrls(courses, settings) {
  /** @type {string[]} */
  const raw = [];
  const arr = Array.isArray(courses) ? courses : Object.values(courses || {});
  for (const c of arr) {
    const u = c && c.outlineUrl;
    if (typeof u === "string" && u.trim()) raw.push(u.trim());
  }
  const urls = settings && settings.sources && settings.sources.outline && settings.sources.outline.urls;
  for (const u of urls || []) {
    if (typeof u === "string" && u.trim()) raw.push(u.trim());
  }
  const seen = new Set();
  const out = [];
  for (const u of raw) {
    if (!u.startsWith(VIEW_PREFIX)) continue;
    /** @type {URL|null} */
    let key = null;
    try {
      key = new URL(u);
    } catch {
      continue;
    }
    const k = key.origin + key.pathname;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(u);
  }
  return out;
}

/** @type {{next: number, urls: string[], now: Date, failed: boolean}|null} */
let pending = null;
let running = 0;
let tokenSeq = 0;
// Bumped on the Page Lifecycle `freeze`: a fetch issued under an older
// generation that settles late is stale and dropped.
let generation = 0;
/** @type {{index: number, gen: number}|null} */
let inFlight = null;

/** Test hook — drop any in-flight round state. */
export function __resetOutlineRound() {
  pending = null;
  running = 0;
  tokenSeq = 0;
  generation = 0;
  inFlight = null;
}

/** The page froze: every in-flight fetch is now stale. */
export function outlineFreeze() {
  generation++;
}

const frozen = (env) => (typeof env.isFrozen === "function" ? !!env.isFrozen() : false);

const pathUrl = (u) => {
  try {
    const x = new URL(u);
    return x.origin + x.pathname;
  } catch {
    return String(u).split("?")[0];
  }
};

/** A 2xx body that is actually the SSO shell, not an outline. */
const isLoginPage = (res, body) => {
  try {
    if (res.redirected) return true;
    const host = res.url && new URL(res.url).hostname;
    if (host && host !== "outline.uwaterloo.ca") return true;
  } catch {
    /* judge by body */
  }
  return LOGIN_WORDS.test(String(body || ""));
};

/**
 * One fetch-round attempt: start or continue the round while the page is
 * not frozen; each fetched page replays as the passive "dom" payload.
 * `env` is injected so tests can drive fakes; the live wiring below binds
 * the real page APIs. Never throws, never stores the pages anywhere else.
 * @param {{
 *   fetchImpl: (url: string, init: RequestInit) => Promise<any>,
 *   sendMessage: (msg: any) => void,
 *   getUrls: () => Promise<{courses?: any, wa1Settings?: any}>,
 *   getLast?: () => {at?: number, ok?: boolean} | null,
 *   setLast?: (stamp: {at: number, ok: boolean}) => void,
 *   getInProgress?: () => number,
 *   setInProgress?: (ms: number) => void,
 *   isFrozen?: () => boolean,
 *   now?: Date,
 * }} env
 */
export async function outlineRound(env) {
  const now = env.now || new Date();
  if (frozen(env)) return { skipped: "frozen", sent: 0 };

  // Resume after a freeze: the URL in flight at freeze-time went stale
  // with the generation bump — re-issue it here.
  if (inFlight && inFlight.gen !== generation) {
    if (pending) pending.next = inFlight.index;
    inFlight = null;
    running = 0;
  }

  if (!pending) {
    const last = env.getLast ? env.getLast() : null;
    if (last && last.at) {
      // A round with failures retries early; a clean round waits 6 h.
      const gap = last.ok === false ? ROUND_RETRY_MS : ROUND_GAP_MS;
      if (now.getTime() - last.at < gap) return { skipped: "throttled", sent: 0 };
    }
    const ip = env.getInProgress ? env.getInProgress() : 0;
    if (ip && now.getTime() - ip < INPROGRESS_TTL_MS) {
      return { skipped: "in-progress", sent: 0 };
    }
    /** @type {{courses?: any, wa1Settings?: any}} */
    let bag = {};
    try {
      bag = (await env.getUrls()) || {};
    } catch {
      return { skipped: "no-urls", sent: 0 };
    }
    const urls = collectOutlineUrls(bag.courses, bag.wa1Settings);
    if (!urls.length) return { skipped: "no-urls", sent: 0 };
    pending = { next: 0, urls, now, failed: false };
    if (env.setInProgress) env.setInProgress(now.getTime());
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
 * @param {{next: number, urls: string[], now: Date, failed: boolean}} round
 */
async function runRound(env, round) {
  let sent = 0;
  while (round.next < round.urls.length) {
    if (frozen(env)) return { paused: true, sent };
    const index = round.next;
    const url = round.urls[index];
    const gen = generation;
    round.next++;
    inFlight = { index, gen };
    /** @type {any} */
    let res = null;
    try {
      res = await env.fetchImpl(url, {
        method: "GET",
        credentials: "include",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      res = null;
    }
    if (inFlight && inFlight.gen === gen) inFlight = null;
    if (gen !== generation) return { stale: true, sent };
    if (!res) {
      round.failed = true;
      continue;
    }
    const status = Number(res.status) || 0;
    let body = "";
    try {
      const t = await res.text();
      if (typeof t === "string") body = t.slice(0, MAX_BYTES);
    } catch {
      /* empty body */
    }
    if (status === 401 || status === 403 || isLoginPage(res, body)) {
      // Signed out — stop the whole round, send nothing further.
      round.failed = true;
      break;
    }
    if (!(status >= 200 && status < 300)) {
      round.failed = true;
      continue;
    }
    env.sendMessage({
      type: "wa1:observed",
      payload: {
        source: "outline",
        kind: "dom",
        url: pathUrl(url),
        body,
        at: new Date().toISOString(),
      },
    });
    sent++;
  }
  const end = env.now || new Date();
  if (env.setLast) env.setLast({ at: end.getTime(), ok: !round.failed });
  if (env.setInProgress) env.setInProgress(0);
  pending = null;
  return { sent, done: true };
}

(() => {
  // Re-injected by W1 on install/update/startup — the second copy returns.
  const g = /** @type {any} */ (globalThis);
  if (g.__wa1_outline) return;
  g.__wa1_outline = true;
  // The fetch round runs on any outline.uwaterloo.ca tab; the snapshotter
  // only on /viewer/view/ pages (the real outlines).
  if (typeof location === "undefined" || location.hostname !== "outline.uwaterloo.ca") {
    return;
  }
  const isViewer = /^https:\/\/outline\.uwaterloo\.ca\/viewer\/view\//.test(location.href);

  const MAX_SENDS = 5;
  /** @type {string|null} */
  let lastHash = null;
  let sends = 0;
  /** @type {number|undefined} */
  let timer;

  // Small string hash so we only send when the page actually changed.
  const hashOf = (/** @type {string} */ text) => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16);
  };

  const send = () => {
    try {
      if (sends >= MAX_SENDS) return;
      const body = document.documentElement && document.documentElement.outerHTML;
      if (!body || body.length > MAX_BYTES) return;
      const hash = hashOf(body);
      if (hash === lastHash) return;
      lastHash = hash;
      sends++;
      // Mirror of MSG.OBSERVED — literal so this file stays import-free.
      Promise.resolve(
        chrome.runtime.sendMessage({
          type: "wa1:observed",
          payload: {
            source: "outline",
            kind: "dom",
            url: location.origin + location.pathname,
            body,
            at: new Date().toISOString(),
          },
        }),
      ).catch(() => {});
    } catch {
      // Extension reloads invalidate the context — never throw into the page.
    }
  };

  // Don't snapshot a half-rendered document: nothing is sent before load.
  let loaded = false;
  const schedule = () => {
    if (!loaded || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      send();
    }, 1500); // outline pages render in bursts
  };

  const start = () => {
    loaded = true;
    send();
  };
  if (isViewer) {
    if (document.readyState === "complete") start();
    else window.addEventListener("load", start);
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  /* ------------------------- in-tab fetch round ------------------------- */

  let frozenNow = false;
  const env = {
    fetchImpl: (/** @type {any} */ url, /** @type {any} */ init) => fetch(url, init),
    sendMessage: (/** @type {any} */ msg) => {
      try {
        Promise.resolve(chrome.runtime.sendMessage(msg)).catch(() => {});
      } catch {
        /* context invalidated */
      }
    },
    getUrls: async () => {
      try {
        return await chrome.storage.local.get(["courses", "wa1Settings"]);
      } catch {
        return {};
      }
    },
    getLast: () => {
      try {
        const raw = sessionStorage.getItem(LAST_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
    setLast: (/** @type {any} */ stamp) => {
      try {
        sessionStorage.setItem(LAST_KEY, JSON.stringify(stamp));
      } catch {
        /* storage can be disabled */
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
    isFrozen: () => frozenNow,
  };
  const tick = () => {
    outlineRound(env).catch(() => {});
  };
  tick(); // this load
  setInterval(tick, TICK_MS); // while the tab stays open
  try {
    document.addEventListener("freeze", () => {
      frozenNow = true;
      outlineFreeze();
    });
    document.addEventListener("resume", () => {
      frozenNow = false;
      tick();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        frozenNow = false;
        tick();
      }
    });
  } catch {
    /* older runtimes lack the Page Lifecycle events */
  }
})();
