// @ts-check
// Google Calendar content script — PASSIVE DOM reader (T3) for duplicate
// suppression. Bundled as an IIFE by tools/build.mjs so imports are fine.
//
// Hard rules (README repeats them):
//   - never send a request (no fetch/XHR/web-socket),
//   - never navigate or click, never touch storage or tokens,
//   - only the structural extract (titles, times, calendarKind) travels to
//     OUR OWN background; descriptions/guests/locations never leave the DOM.
//
// Sends only settled reads: the grid must be present and its chip set
// unchanged for the settle window (gcalGate in dom.js) — a still-rendering
// view must never apply visible-range deletion. A heartbeat re-sends at
// least every 30 min so an open tab keeps the read fresh.

import { MSG } from "../../core/contract.js";
import { guardInstance } from "../../capture/guard.js";
import { hashString } from "../../capture/redact.js";
import { gcalExtract, gcalGate } from "./dom.js";
import { GCAL } from "./selectors.js";

(() => {
  // Re-injected by W1 on install/update/startup — a live copy answers the
  // ping and we return; an orphan is superseded and runs teardown.
  if (!guardInstance("gcal-content", teardown)) return;
  if (location.hostname !== "calendar.google.com") return;

  const DEBOUNCE_MS = 2000;
  const TICK_MS = 5000;
  const BODY_CAP = 1024 * 1024;
  const gate = gcalGate();
  /** @type {string|null} */
  let lastHash = null;
  /** @type {number|undefined} */
  let timer;
  /** @type {number|undefined} */
  let tickTimer;
  /** @type {MutationObserver|null} */
  let observer = null;

  const tick = () => {
    try {
      const now = Date.now();
      const ext = gcalExtract(document, location.href);
      const grid = ext.view !== "other";
      const chips = document.querySelectorAll(GCAL.chip).length;
      // The signature covers everything the adapter would merge or delete:
      // the view, its visible range and each event's identity.
      const sig = hashString(
        JSON.stringify({
          v: ext.view,
          r: ext.range,
          e: (ext.events || []).map((e) => `${e.title}|${e.startAt}`),
        }),
      );
      const { send, settled, heartbeat } = gate.tick(grid, chips, sig, now);
      if (!send) return;
      const body = JSON.stringify({ ...ext, settled });
      if (!body || body.length > BODY_CAP) return;
      const hash = hashString(body);
      if (hash === lastHash && !heartbeat) return;
      lastHash = hash;
      gate.sent(now);
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
      tick();
    }, DEBOUNCE_MS);
  };

  const start = () => {
    tick();
    // Mutations cover view changes; the interval covers the heartbeat and
    // lets an empty/stable grid reach its settle window.
    observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    tickTimer = setInterval(tick, TICK_MS);
  };

  if (document.readyState === "complete") start();
  else addEventListener("load", start, { once: true });
  addEventListener("hashchange", tick);
  addEventListener("popstate", tick);

  /** Superseded by a re-injected copy — drop timers, observer, listeners. */
  function teardown() {
    if (timer !== undefined) clearTimeout(timer);
    if (tickTimer !== undefined) clearInterval(tickTimer);
    if (observer) observer.disconnect();
    removeEventListener("load", start);
    removeEventListener("hashchange", tick);
    removeEventListener("popstate", tick);
  }
})();
