// @ts-check
// Email (Outlook web + Gmail) content script — PASSIVE DOM reader (T3),
// plus on Gmail the one allowed request: the unread-mail Atom feed
// (atom.js — README "Network"). Bundled as an IIFE by tools/build.mjs so
// imports are fine.
//
// Hard rules (README repeats them):
//   - no requests except GET /mail/u/<n>/feed/atom on Gmail (atom.js),
//   - never navigate or click, never touch storage or tokens
//     (atom.js' sessionStorage throttle stamp aside — see ATOM_KEY),
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

  // Gmail only: the unread-mail Atom feed, delivered as the same observed
  // payload the passive reader sends. Only advances while not frozen.
  if (location.hostname === "mail.google.com") {
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
    const atomTick = () => {
      atomRound(env).catch(() => {});
    };
    atomTick(); // this load
    setInterval(atomTick, ATOM_GAP_MS); // while the tab stays open
    try {
      document.addEventListener("freeze", () => {
        frozenNow = true;
        atomFreeze();
      });
      document.addEventListener("resume", () => {
        frozenNow = false;
        atomTick();
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
  }
})();
