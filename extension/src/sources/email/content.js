// @ts-check
// Email (Outlook web + Gmail) content script — passive DOM reader plus the
// automatic mail backfill (backfill.js + gmail-backfill.js /
// outlook-backfill.js — README "Network"). Bundled as an IIFE by
// tools/build.mjs so imports are fine.
//
// Hard rules (README repeats them):
//   - every request is a same-origin GET: Gmail's Atom feed, the hidden
//     #search iframe pages and ?view=pt print views; Outlook's
//     /api/v2.0/me/... REST reads under the page's own MSAL token;
//   - never navigate or click a user tab, never POST/PATCH/PUT/DELETE,
//     never touch write APIs or token endpoints;
//   - the Outlook token lives in one local variable per round and reaches
//     only the Authorization header — never storage, messages, or logs;
//   - chrome.storage is read-only (settings + the adapter's backfill state);
//   - mail text travels only as a transient DOM extract to OUR OWN
//     background; the adapter persists at most a per-message date snippet.

import { MSG } from "../../core/contract.js";
import { extractFor } from "./dom.js";
import {
  atomRound,
  atomFreeze,
  gmailAccountIndex,
  ATOM_GAP_MS,
  ATOM_KEY,
} from "./atom.js";
import {
  backfillRound,
  backfillFreeze,
  replayCache,
  BF_TICK_MS,
  BF_LOCK_PREFIX,
  BF_FAIL_PREFIX,
  MAIL_CHECK_NOW,
} from "./backfill.js";
import { gmailBackfill } from "./gmail-backfill.js";
import { outlookBackfill } from "./outlook-backfill.js";

(() => {
  const DEBOUNCE_MS = 2000;
  const BODY_CAP = 2 * 1024 * 1024;
  /** @type {string|null} */
  let lastBody = null;
  /** @type {number|undefined} */
  let timer;

  const send = () => {
    try {
      const ext = extractFor(document, location.href);
      if (!ext || !Array.isArray(ext.messages) || !ext.messages.length) return;
      const body = JSON.stringify(ext);
      if (!body || body.length > BODY_CAP || body === lastBody) return;
      lastBody = body;
      Promise.resolve(
        chrome.runtime.sendMessage({
          type: MSG.OBSERVED,
          payload: {
            source: ext.provider,
            kind: "dom",
            url: location.href,
            body,
            at: new Date().toISOString(),
          },
        }),
      ).catch(() => {});
    } catch {
      // A hostile DOM must stay silent — never throw into the page.
    }
  };

  const schedule = () => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      send();
    }, DEBOUNCE_MS);
  };

  const start = () => {
    send();
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  };

  if (document.readyState === "complete") start();
  else addEventListener("load", start, { once: true });
  addEventListener("hashchange", send);
  addEventListener("popstate", send);

  /* ---------------------- shared runtime state ---------------------- */

  const provider = location.hostname === "mail.google.com" ? "gmail" : "outlook";
  let frozenNow = false;
  const sendMessage = (/** @type {any} */ msg) => {
    try {
      Promise.resolve(chrome.runtime.sendMessage(msg)).catch(() => {});
    } catch {
      /* context invalidated */
    }
  };

  // Gmail only: the unread-mail Atom feed, delivered as the same observed
  // payload the passive reader sends. Only advances while not frozen.
  /** @type {() => void} */
  let atomTick = () => {};
  if (provider === "gmail") {
    const env = {
      fetchImpl: (/** @type {any} */ url, /** @type {any} */ init) => fetch(url, init),
      sendMessage,
      parseXml: (/** @type {string} */ t) => new DOMParser().parseFromString(t, "text/xml"),
      getLast: () => {
        try {
          const raw = sessionStorage.getItem(ATOM_KEY);
          return raw ? JSON.parse(raw) : null;
        } catch {
          return null;
        }
      },
      setLast: (/** @type {any} */ stamp) => {
        try {
          sessionStorage.setItem(ATOM_KEY, JSON.stringify(stamp));
        } catch {
          /* storage can be disabled */
        }
      },
      isFrozen: () => frozenNow,
      account: gmailAccountIndex(location.pathname),
      pageUrl: location.href,
    };
    atomTick = () => {
      atomRound(env).catch(() => {});
    };
    atomTick(); // this load
    setInterval(atomTick, ATOM_GAP_MS); // while the tab stays open
  }

  /* ------------------------ automatic backfill ----------------------- */

  if (window.top === window) {
    const lsGet = (/** @type {string} */ k) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    };
    const ssGet = (/** @type {string} */ k) => {
      try {
        return sessionStorage.getItem(k);
      } catch {
        return null;
      }
    };
    const settingsSlice = async () => {
      try {
        const all = /** @type {any} */ (await chrome.storage.local.get("wa1Settings"));
        const s = (all && all.wa1Settings) || {};
        return (s.sources && s.sources.outlook) || {};
      } catch {
        return {};
      }
    };
    /** In-memory cache of the last run's rows (never persisted). */
    /** @type {{folder: string, messages: any[]}[]|null} */
    let cache = null;
    const env = {
      fetchImpl: (/** @type {any} */ url, /** @type {any} */ init) => fetch(url, init),
      sendMessage,
      parseHtml: (/** @type {string} */ t) =>
        new DOMParser().parseFromString(t, "text/html"),
      sleep: (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms)),
      isFrozen: () => frozenNow,
      getSettings: settingsSlice,
      getPrev: async () => {
        try {
          const all = /** @type {any} */ (await chrome.storage.local.get("sourceState"));
          const st = (((all || {}).sourceState || {}).outlook || {}).state || {};
          return ((st.backfill || {})[provider]) || null;
        } catch {
          return null;
        }
      },
      getLock: () => Number(lsGet(BF_LOCK_PREFIX + provider)) || 0,
      setLock: (/** @type {number} */ at) => {
        try {
          localStorage.setItem(BF_LOCK_PREFIX + provider, String(at));
        } catch {
          /* best-effort */
        }
      },
      clearLock: () => {
        try {
          localStorage.removeItem(BF_LOCK_PREFIX + provider);
        } catch {
          /* best-effort */
        }
      },
      getFail: () => Number(ssGet(BF_FAIL_PREFIX + provider)) || 0,
      setFail: (/** @type {number} */ at) => {
        try {
          sessionStorage.setItem(BF_FAIL_PREFIX + provider, String(at));
        } catch {
          /* best-effort */
        }
      },
      setCache: (/** @type {any} */ c) => {
        cache = c;
      },
      getCache: () => cache,
      pageUrl: location.href,
      ...(provider === "gmail"
        ? {
            account: gmailAccountIndex(location.pathname),
            makeFrame: (/** @type {string} */ url) => {
              const el = document.createElement("iframe");
              el.setAttribute(
                "style",
                "position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none;border:0;",
              );
              el.setAttribute("aria-hidden", "true");
              document.documentElement.appendChild(el);
              el.src = url;
              return {
                navigate: (/** @type {string} */ u) => {
                  try {
                    el.src = u;
                  } catch {
                    /* navigated away */
                  }
                },
                doc: () => el.contentDocument,
                href: () => {
                  try {
                    return el.contentWindow ? el.contentWindow.location.href : "";
                  } catch {
                    return "";
                  }
                },
                remove: () => el.remove(),
              };
            },
          }
        : {
            lsValues: () => {
              /** @type {string[]} */
              const out = [];
              try {
                for (const k of Object.keys(localStorage)) {
                  if (!/accesstoken/i.test(k)) continue;
                  const v = localStorage.getItem(k);
                  if (v != null) out.push(v);
                }
              } catch {
                /* storage blocked */
              }
              return out;
            },
          }),
    };
    const impl = provider === "gmail" ? gmailBackfill : outlookBackfill;
    const tick = (/** @type {boolean} */ force) => {
      backfillRound({ ...env, now: new Date(), force }, impl).catch(() => {});
    };
    tick(false);
    setInterval(() => tick(false), BF_TICK_MS);

    // "Check again now" from Setup: an immediate incremental read (a full
    // only when the last one is >6 h old or the lookback changed).
    try {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.type === MAIL_CHECK_NOW) tick(true);
      });
    } catch {
      /* older runtimes */
    }

    // Settings changes: a lookback change shows up as lookbackChanged in
    // decideRun (full, allowed inside 6h); a provider off flag stops reads;
    // any other filter change replays this tab's in-memory cache.
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        const s = /** @type {any} */ (changes && changes.wa1Settings);
        if (!s) return;
        const before =
          (((s.oldValue || {}).sources || {}).outlook || {});
        const after = (((s.newValue || {}).sources || {}).outlook || {});
        if (after[provider] === false) return; // reads stop at the next tick
        if (
          Number(before.lookbackDays) !== Number(after.lookbackDays) &&
          after.lookbackDays != null
        ) {
          tick(true); // decideRun upgrades it to a full
          return;
        }
        if (JSON.stringify(before) !== JSON.stringify(after) && cache) {
          replayCache({ ...env, now: new Date() }, impl);
        }
      });
    } catch {
      /* no storage API */
    }
  }

  // Page Lifecycle: freeze drops in-flight fetches/rounds (generation);
  // resume/visible continues where the tab left off.
  try {
    document.addEventListener("freeze", () => {
      frozenNow = true;
      atomFreeze();
      backfillFreeze();
    });
    document.addEventListener("resume", () => {
      frozenNow = false;
      atomTick(); // the atom env re-checks its own gap — cheap
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        frozenNow = false;
        atomTick();
      }
    });
  } catch {
    /* older runtimes lack the Page Lifecycle events */
  }
})();
