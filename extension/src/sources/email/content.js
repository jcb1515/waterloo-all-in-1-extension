// @ts-check
// Email (Outlook web + Gmail) content script — passive DOM reader plus the
// automatic mail read (backfill.js + gmail-backfill.js / outlook-backfill.js
// — README "Network"). Bundled as an IIFE by tools/build.mjs so imports are
// fine.
//
// Hard rules (README repeats them):
//   - every request is a same-origin GET: Gmail's Atom feed and ?view=pt
//     print views; Outlook's /api/v2.0/me/... REST reads under the page's
//     own MSAL token;
//   - never navigate or click a user tab, never POST/PATCH/PUT/DELETE,
//     never touch write APIs or token endpoints, never create an iframe;
//   - the Outlook token lives in one local variable per round and reaches
//     only the Authorization header — never storage, messages, or logs;
//   - chrome.storage is read-only (settings + the adapter's check state);
//   - mail text travels only as a transient DOM extract to OUR OWN
//     background; the adapter persists at most a per-message date snippet.

import { MSG } from "../../core/contract.js";
import { CHECK } from "../../core/messages.js";
import { guardInstance } from "../../capture/guard.js";
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
  makeRunBox,
  checkNowDecision,
  doneFromResult,
  gmailOnInbox,
  BF_TICK_MS,
  BF_LOCK_PREFIX,
  BF_FAIL_PREFIX,
} from "./backfill.js";
import { gmailBackfill } from "./gmail-backfill.js";
import { outlookBackfill, outlookToken } from "./outlook-backfill.js";

(() => {
  // W1 re-injects content scripts into open tabs on install/update/startup —
  // a live copy answers the ping and we return; an orphan is superseded and
  // runs teardown. See src/capture/guard.js.
  if (!guardInstance("email-content", teardown)) return;

  const DEBOUNCE_MS = 2000;
  const BODY_CAP = 2 * 1024 * 1024;
  /** @type {string|null} */
  let lastBody = null;
  /** @type {number|undefined} */
  let timer;
  /** @type {number|undefined} */
  let atomTimer;
  /** @type {number|undefined} */
  let tickTimer;
  /** @type {MutationObserver|null} */
  let observer = null;
  /** @type {any} check-now listener (top window only) */
  let onCheckNow;
  /** @type {any} settings-change listener (top window only) */
  let onSettings;
  /** @type {any} automatic-read tick (top window only) */
  let autoTick;

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
    observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, {
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
    atomTimer = setInterval(atomTick, ATOM_GAP_MS); // while the tab stays open
  }

  /* ------------------------- automatic read -------------------------- */

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
    /** Latest settings snapshot — lets check-now answer "disabled" without
     * an async storage read. Refreshed on load + every change. */
    /** @type {any} */
    let curSettings = null;
    settingsSlice().then((s) => {
      curSettings = s;
    });
    const lsTokenValues = () => {
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
    };
    const onInbox = () =>
      provider !== "gmail" || gmailOnInbox(location.hash);
    /** @type {{folder: string, messages: any[]}[]|null} in-memory cache of
     * the last run's rows (never persisted). */
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
          return ((st.check || {})[provider]) || null;
        } catch {
          return null;
        }
      },
      // Read-only: the signatures the adapter recorded for bodies already
      // fetched — backfillRound skips a body fetch while the signature
      // (Gmail last-message-id / Outlook message Id) is unchanged.
      getBodyRead: async () => {
        try {
          const all = /** @type {any} */ (await chrome.storage.local.get("sourceState"));
          const st = (((all || {}).sourceState || {}).outlook || {}).state || {};
          return ((st.bodyRead || {})[provider]) || {};
        } catch {
          return {};
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
      doc: () => document,
      onInbox,
      ...(provider === "gmail"
        ? { account: gmailAccountIndex(location.pathname) }
        : { lsValues: lsTokenValues }),
    };
    const impl = provider === "gmail" ? gmailBackfill : outlookBackfill;
    const box = makeRunBox((/** @type {boolean} */ force) =>
      backfillRound({ ...env, now: new Date(), force }, impl),
    );

    // Automatic cadence: on load, every 30 min, and on hashchange to the
    // inbox (Gmail). backfillRound itself enforces the 30-min gate, the
    // retry window and the cross-tab lock for these non-forced runs.
    autoTick = () => {
      if (!onInbox()) return;
      box.run(false).catch(() => {});
    };
    autoTick();
    tickTimer = setInterval(autoTick, BF_TICK_MS);
    addEventListener("hashchange", autoTick);

    // Check-now (panel → background → tab): reply accepted/failed at once,
    // run a forced read (bypasses the 30-min gate, the lock and the passive
    // unchanged-snapshot dedupe — never the rate cap or the kill switch),
    // then report check-done. A run already in flight is joined.
    /**
     * @param {any} msg @param {any} _sender @param {(r: any) => void} sendResponse
     */
    onCheckNow = (msg, _sender, sendResponse) => {
      const decision = checkNowDecision(msg, provider, {
        onPage: onInbox,
        disabled: () => curSettings != null && curSettings[provider] === false,
        hasToken:
          provider === "outlook"
            ? () => outlookToken(lsTokenValues(), Date.now()) != null
            : undefined,
      });
      if (decision == null) return false;
      sendResponse(decision);
      if (decision.accepted) {
        const source = String(msg.source || "");
        const runId = String(msg.runId || "");
        lastBody = null;
        send(); // re-extract the visible list — dedupe bypassed
        box
          .run(true)
          .then((res) => {
            sendMessage({
              type: CHECK.DONE,
              source,
              provider,
              runId,
              ...doneFromResult(res),
            });
          })
          .catch(() => {});
      }
      return false;
    };
    try {
      chrome.runtime.onMessage.addListener(onCheckNow);
    } catch {
      /* older runtimes */
    }

    // Settings changes: a provider off flag stops reads at the next tick;
    // any other filter change replays this tab's in-memory cache so the new
    // rules re-extract what was already read — no network.
    onSettings = (/** @type {any} */ changes, /** @type {any} */ area) => {
      if (area !== "local") return;
      const s = /** @type {any} */ (changes && changes.wa1Settings);
      if (!s) return;
      const before = (((s.oldValue || {}).sources || {}).outlook || {});
      const after = (((s.newValue || {}).sources || {}).outlook || {});
      curSettings = after;
      if (after[provider] === false) return; // reads stop at the next tick
      if (JSON.stringify(before) !== JSON.stringify(after) && cache) {
        replayCache({ ...env, now: new Date() }, impl);
      }
    };
    try {
      chrome.storage.onChanged.addListener(onSettings);
    } catch {
      /* no storage API */
    }
  }

  // Page Lifecycle: freeze drops in-flight fetches/runs (generation);
  // resume/visible continues where the tab left off. A check-now that
  // joined a frozen run resolves stale — check-done reports "timeout".
  const onFreeze = () => {
    frozenNow = true;
    atomFreeze();
    backfillFreeze();
  };
  const onResume = () => {
    frozenNow = false;
    atomTick(); // the atom env re-checks its own gap — cheap
  };
  const onVis = () => {
    if (document.visibilityState === "visible") {
      frozenNow = false;
      atomTick();
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
   * Everything this instance wired — run by guardInstance's supersede when
   * a re-injected copy takes over (our chrome.runtime is dead by then).
   */
  function teardown() {
    if (timer !== undefined) clearTimeout(timer);
    if (atomTimer !== undefined) clearInterval(atomTimer);
    if (tickTimer !== undefined) clearInterval(tickTimer);
    if (observer) observer.disconnect();
    try {
      removeEventListener("load", start);
      removeEventListener("hashchange", send);
      removeEventListener("popstate", send);
      if (autoTick) removeEventListener("hashchange", autoTick);
    } catch {
      /* dead context */
    }
    try {
      if (onCheckNow) chrome.runtime.onMessage.removeListener(onCheckNow);
      if (onSettings) chrome.storage.onChanged.removeListener(onSettings);
    } catch {
      /* dead context */
    }
    document.removeEventListener("freeze", onFreeze);
    document.removeEventListener("resume", onResume);
    document.removeEventListener("visibilitychange", onVis);
  }
})();
