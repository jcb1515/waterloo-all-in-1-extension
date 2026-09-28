// @ts-check
/*
  Isolated-world site agent. Three jobs:

    T2 relay   answers wa1:relay-fetch by running the fetch here, inside the
               site's own session (cookies the service worker can't send).
    T3 observe forwards net events whose URL matches the adapter's patterns
               (sent back in the TAB_READY response) as wa1:observed — with
               the raw body, since this stays on this computer.
    discovery  reduces net events to redacted shapes and page outlines for
               the discovery store (toggleable; OBSERVED works regardless).

  Settings (chrome.storage.local "discoverySettings"):
    { enabled: true (default), redactWords: [] }
*/

import { MSG, PAGE_EVENT, SITE_BY_HOST } from "../core/contract.js";
import { normalizePath, bodyShape, htmlOutline, redactText, hashString } from "./redact.js";
import { readBodyInto } from "./fetch.js";
import { UI } from "../core/messages.js";
import { probeFor, shouldSendProbe } from "../sources/probes.js";

(() => {
  const site = /** @type {Record<string, string>} */ (SITE_BY_HOST)[location.hostname];
  if (!site) return;

  const READY_EVENT = "wa1:recorder-ready";
  const SNAP_THROTTLE_MS = 3000;
  const SNAP_MIN_INTERVAL_MS = 10000;
  const OBSERVED_BODY_CAP = 5000000;
  const RELAY_TIMEOUT_MS = 20000;
  const LOGIN_URL_RE = /login|signin|sso|cas|idp/i;

  /*
    Per-site text policy for htmlOutline. "structural" records element counts
    and text lengths only, so usernames, DM names and mail subjects never
    leave the page. Discord's member list is an <aside>, its message headers
    are <h3>, and the DM list under /channels/@me is a <nav>; Outlook keeps
    the user's name in the tab title and subjects under [role=main].
  */
  const SITE_POLICY = {
    discord: { textMode: "structural", excludeSelectors: ["aside", '[class*="members"]', '[data-list-id="chat-messages"]'] },
    outlook: { textMode: "structural", excludeSelectors: ['[role="main"]'] },
    gmail: { textMode: "structural", excludeSelectors: ['[role="main"]'] },
    learn: { textMode: "full" },
    portal: { textMode: "full" },
    waterlooworks: { textMode: "full" },
  };
  const policy = SITE_POLICY[site] || { textMode: "full" };
  const structural = policy.textMode === "structural";

  /** Options for htmlOutline, including this site's privacy policy. */
  function outlineOpts() {
    const opts = { extraWords: redactWords, ...policy };
    // The Discord DM list lives in a <nav> — record no nav texts there.
    if (site === "discord" && location.pathname.startsWith("/channels/@me")) opts.navSelectors = "";
    return opts;
  }

  let enabled = true;
  /** @type {string[]} */
  let redactWords = [];
  let wired = false;
  let snapping = false;
  /** @type {RegExp[]} url patterns the adapter wants observed (from TAB_READY) */
  let observeRegexes = [];

  /** Extension reloads invalidate the context; never let that surface. */
  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      /* context invalidated */
    }
  }

  // One TAB_READY per load. The response tells us which page-network URLs the
  // site's adapter wants observed as wa1:observed payloads.
  try {
    chrome.runtime
      .sendMessage({ type: MSG.TAB_READY, source: site, url: location.origin + location.pathname })
      .then((resp) => {
        const patterns = resp && Array.isArray(resp.observe) ? resp.observe : [];
        observeRegexes = patterns
          .map((p) => {
            try {
              return new RegExp(p);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
      })
      .catch(() => {});
  } catch {
    /* context invalidated */
  }

  /* ------------------------- T2 relay fetch ------------------------- */

  // Runs fetches the background can't (same-origin session cookies). Only
  // site-relative GET/POST paths — no scheme, no "..", no redirects off host.
  // On Learn the site content script answers RELAY_FETCH itself (restricted
  // to GET /d2l/api/); registering here too would race the fetch twice.
  if (site !== "learn")
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || msg.type !== MSG.RELAY_FETCH) return false;
      const path = String(msg.path || "");
      const method = String((msg.init && msg.init.method) || "GET").toUpperCase();
      if (!path.startsWith("/") || path.includes("..") || (method !== "GET" && method !== "POST")) {
        sendResponse({ status: 0, error: "not-allowed" });
        return false;
      }
      (async () => {
        try {
          /** @type {RequestInit} */
          const init = { method, credentials: "same-origin", signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) };
          if (msg.init && msg.init.headers) init.headers = msg.init.headers;
          if (method === "POST" && msg.init && typeof msg.init.body === "string") init.body = msg.init.body;
          const res = await fetch(location.origin + path, init);
          /** @type {Record<string, any>} */
          const out = { status: res.status, url: res.url, contentType: res.headers.get("content-type") || "" };
          if (res.status === 401 || LOGIN_URL_RE.test(res.url || "")) out.loginRedirect = true;
          if (res.ok) await readBodyInto(res, out, !!(msg.init && msg.init.binary === true));
          sendResponse(out);
        } catch (e) {
          const err = /** @type {any} */ (e);
          sendResponse({ status: 0, error: err && err.name === "TimeoutError" ? "timeout" : String((err && err.message) || err) });
        }
      })();
      return true;
    });

  function applySettings(s) {
    enabled = !s || s.enabled !== false;
    redactWords = s && Array.isArray(s.redactWords) ? s.redactWords : [];
  }

  // The net-event listener runs even when discovery recording is disabled:
  // it feeds the OBSERVED forwarding below. Only the redacted discovery
  // writes are gated on `enabled`.
  function wire() {
    if (wired) return;
    wired = true;
    document.addEventListener(PAGE_EVENT, onPageEvent);
    // Tell the page-world observer to replay whatever it buffered.
    try {
      document.dispatchEvent(new CustomEvent(READY_EVENT));
    } catch {
      /* ignore */
    }
  }

  /** @param {Event} e */
  function onPageEvent(e) {
    /** @type {any} */
    let d = null;
    try {
      d = JSON.parse(/** @type {CustomEvent} */ (e).detail);
    } catch {
      return;
    }
    if (!d || d.kind !== "net") return;

    // T3: the adapter wants this response — forward it unredacted (stays local).
    const fullUrl = String(d.url || "");
    if (observeRegexes.length && observeRegexes.some((re) => re.test(fullUrl))) {
      send({
        type: MSG.OBSERVED,
        payload: {
          source: site,
          kind: "net",
          url: fullUrl,
          method: d.method || "GET",
          status: d.status,
          contentType: d.contentType || "",
          body: typeof d.body === "string" ? d.body.slice(0, OBSERVED_BODY_CAP) : "",
          at: d.at || new Date().toISOString(),
        },
      });
    }

    if (!enabled) return;
    try {
      // shapeOf wins whenever the body parses as JSON, whatever the declared
      // content type — WaterlooWorks serves JSON as text/html.
      const shape = bodyShape(d.body, d.contentType, redactWords, (html) => {
        try {
          return htmlOutline(new DOMParser().parseFromString(html, "text/html"), outlineOpts());
        } catch {
          return null;
        }
      });
      send({
        type: MSG.DISCOVERY,
        site,
        entry: {
          kind: "net",
          endpoint: normalizePath(d.url, redactWords),
          method: d.method || "GET",
          status: d.status,
          contentType: d.contentType || "",
          size: d.size || 0,
          shape,
        },
      });
    } catch {
      /* ignore malformed events */
    }
  }

  /* ------------------------- page snapshots ------------------------- */

  let lastPath = "";
  let lastHash = "";
  let lastSentAt = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let debounceTimer = null;

  function snapshot() {
    if (!enabled) return;
    const now = Date.now();
    if (now - lastSentAt < SNAP_MIN_INTERVAL_MS) return;
    try {
      const path = normalizePath(location.href, redactWords);
      const outline = htmlOutline(document, outlineOpts());
      const hash = hashString(JSON.stringify(outline));
      if (path === lastPath && hash === lastHash) return;
      lastPath = path;
      lastHash = hash;
      lastSentAt = now;
      const title = structural
        ? `<text ${String(document.title || "").replace(/\s+/g, " ").trim().length}>`
        : redactText(document.title, redactWords);
      send({
        type: MSG.DISCOVERY,
        site,
        entry: { kind: "page", path, title, outline },
      });
    } catch {
      /* ignore */
    }
  }

  function startSnapshots() {
    if (snapping) return;
    snapping = true;
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", snapshot, { once: true });
    } else {
      snapshot();
    }
    window.addEventListener("load", snapshot, { once: true });
    try {
      // Throttle, not debounce: on sites that mutate constantly (Discord,
      // Gmail) a debounce that resets every mutation would starve snapshots.
      new MutationObserver(() => {
        if (!debounceTimer) {
          debounceTimer = setTimeout(() => {
            debounceTimer = null;
            snapshot();
          }, SNAP_THROTTLE_MS);
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    } catch {
      /* ignore */
    }
  }

  /* ------------------------- reader probe ------------------------- */

  // "Check readers": run the site's probe on load and after page mutations,
  // report COUNTS ONLY (never text) at most once per PROBE_MIN_INTERVAL_MS
  // and only when the result changed.
  const probeFn = probeFor(site);
  const PROBE_THROTTLE_MS = 3000;
  const PROBE_MIN_INTERVAL_MS = 5000;
  let probeLast = { at: 0, json: "" };
  /** @type {ReturnType<typeof setTimeout> | null} */
  let probeTimer = null;

  function runProbe() {
    if (!probeFn) return;
    try {
      const res = probeFn(document, location.href);
      if (!res || typeof res !== "object") return;
      const now = Date.now();
      const json = JSON.stringify([res.page, res.counts, res.ok, res.hints]);
      if (!shouldSendProbe(probeLast, json, now, PROBE_MIN_INTERVAL_MS)) return;
      probeLast = { at: now, json };
      send({
        type: UI.PROBE,
        source: site,
        page: res.page || "unknown",
        counts: res.counts || {},
        ok: !!res.ok,
        hints: Array.isArray(res.hints) ? res.hints : [],
        at: new Date().toISOString(),
      });
    } catch {
      /* probe must never break the page */
    }
  }

  function startProbe() {
    if (!probeFn) return;
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", runProbe, { once: true });
    } else {
      runProbe();
    }
    window.addEventListener("load", runProbe, { once: true });
    try {
      new MutationObserver(() => {
        if (!probeTimer) {
          probeTimer = setTimeout(() => {
            probeTimer = null;
            runProbe();
          }, PROBE_THROTTLE_MS);
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    } catch {
      /* ignore */
    }
  }

  /* ---------------------- "Something missed?" snapshot ---------------------- */

  // The panel asks the recorder on this tab to save a structural page
  // outline plus the user's note into the discovery store. Uses the site's
  // privacy policy — Discord/email stay structural, so no text leaves here.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== UI.PROBE_SNAPSHOT) return false;
    try {
      const path = normalizePath(location.href, redactWords);
      const outline = htmlOutline(document, outlineOpts());
      const title = structural
        ? `<text ${String(document.title || "").replace(/\s+/g, " ").trim().length}>`
        : redactText(document.title, redactWords);
      send({
        type: MSG.DISCOVERY,
        site,
        entry: {
          kind: "page",
          path,
          title,
          outline,
          note: String(msg.note || "").slice(0, 500),
        },
      });
      sendResponse({ ok: true });
    } catch {
      sendResponse({ ok: false });
    }
    return false;
  });

  /* ------------------------- settings ------------------------- */

  wire(); // net events feed OBSERVED forwarding whether or not discovery is on
  startProbe();
  try {
    chrome.storage.local
      .get("discoverySettings")
      .then(({ discoverySettings }) => {
        applySettings(discoverySettings);
        if (enabled) startSnapshots();
      })
      .catch(() => startSnapshots());
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.discoverySettings) return;
      applySettings(changes.discoverySettings.newValue);
      if (enabled) startSnapshots();
    });
  } catch {
    startSnapshots();
  }
})();
