// @ts-check
// Email (Outlook web + Gmail) content script — PASSIVE DOM reader (T3).
// Bundled as an IIFE by tools/build.mjs so imports are fine.
//
// Hard rules (README repeats them):
//   - never send a request (no fetch/XHR/web-socket),
//   - never navigate or click, never touch storage or tokens,
//   - mail text travels only as a transient DOM extract to OUR OWN
//     background; the adapter persists at most a per-message date snippet.

import { MSG } from "../../core/contract.js";
import { extractFor } from "./dom.js";

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
})();
