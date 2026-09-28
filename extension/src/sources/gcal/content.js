// @ts-check
// Google Calendar content script — PASSIVE DOM reader (T3) for duplicate
// suppression. Bundled as an IIFE by tools/build.mjs so imports are fine.
//
// Hard rules (README repeats them):
//   - never send a request (no fetch/XHR/web-socket),
//   - never navigate or click, never touch storage or tokens,
//   - only the structural extract (titles, times, calendarKind) travels to
//     OUR OWN background; descriptions/guests/locations never leave the DOM.

import { MSG } from "../../core/contract.js";
import { hashString } from "../../capture/redact.js";
import { gcalExtract } from "./dom.js";

(() => {
  if (location.hostname !== "calendar.google.com") return;

  const DEBOUNCE_MS = 2000;
  const BODY_CAP = 1024 * 1024;
  /** @type {string|null} */
  let lastHash = null;
  /** @type {number|undefined} */
  let timer;

  const send = () => {
    try {
      const ext = gcalExtract(document, location.href);
      // Events OR a range: an empty visible week still matters — it means
      // events there were deleted and the rolling state must drop them.
      if (!ext || (!ext.events.length && !ext.range)) return;
      const body = JSON.stringify(ext);
      if (!body || body.length > BODY_CAP) return;
      const hash = hashString(body);
      if (hash === lastHash) return;
      lastHash = hash;
      Promise.resolve(
        chrome.runtime.sendMessage({
          type: MSG.OBSERVED,
          payload: {
            source: "gcal",
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
