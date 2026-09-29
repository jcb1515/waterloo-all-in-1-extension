// @ts-check
// Google Calendar content script — passive DOM reader (T3) for duplicate
// suppression, plus the T2 relay for the export/ical reads. Bundled as an
// IIFE by tools/build.mjs so imports are fine.
//
// Hard rules (README repeats them):
//   - never send a request the background didn't ask for — the only fetch
//     is the allowlisted RELAY_FETCH handler below,
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
import { readBodyInto } from "../../capture/fetch.js";
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

  /* ------------------------- T2 relay fetch ------------------------- */

  /*
    Runs the export/ical reads inside this tab's own session — needed in
    profiles where the service worker's host-permission CORS bypass never
    reaches calendar.google.com (its fetch answers status 0). GET only, and
    only two paths — the account export zip and subscribed-calendar .ics
    reads — so it can never be pointed at an arbitrary URL. Same-origin
    credentials only: "include" gets a 403 from Calendar.
  */
  const RELAY_PATH_RE = /^\/calendar\/(?:u\/\d{1,2}\/exporticalzip|ical\/[^?#]+\.ics)$/;
  const RELAY_LOGIN_RE = /accounts\.google\.com|ServiceLogin|\/signin/i;

  /** @param {any} msg @returns {Promise<Record<string, any>>} */
  async function relayFetch(msg) {
    const init = (msg && msg.init) || {};
    const path = String((msg && msg.path) || "");
    const method = String(init.method || "GET").toUpperCase();
    if (method !== "GET" || path.includes("..") || !RELAY_PATH_RE.test(path)) {
      return { status: 0, error: "path not allowed" };
    }
    /** @type {Response} */
    let res;
    try {
      res = await fetch(location.origin + path, {
        method: "GET",
        credentials: "same-origin",
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      const err = /** @type {any} */ (e);
      return {
        status: 0,
        error: err && err.name === "TimeoutError" ? "timeout" : String((err && err.message) || err),
      };
    }
    const out = {
      status: res.status,
      url: res.url || "",
      contentType: res.headers.get("content-type") || "",
      loginRedirect:
        (res.redirected === true && !String(res.url || "").startsWith(location.origin)) ||
        RELAY_LOGIN_RE.test(res.url || ""),
    };
    if (res.ok) await readBodyInto(res, out, init.binary === true);
    return out;
  }

  /** Async reply via promise; non-relay messages pass through unanswered. */
  const onRelayMessage = (msg, _sender, reply) => {
    if (!msg || msg.type !== MSG.RELAY_FETCH) return undefined;
    relayFetch(msg).then(reply);
    return true;
  };
  chrome.runtime.onMessage.addListener(onRelayMessage);

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
    try {
      chrome.runtime.onMessage.removeListener(onRelayMessage);
    } catch {
      /* context invalidated */
    }
  }
})();
