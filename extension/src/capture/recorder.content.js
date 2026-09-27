// @ts-check
/*
  Isolated-world discovery recorder. Receives page-network CustomEvents from
  observer.main.js, reduces them to redacted shapes and page outlines, and
  forwards them to the background's discovery store. Also sends one
  wa1:tab-ready per page load so the background can track open site tabs.

  Settings (chrome.storage.local "discoverySettings"):
    { enabled: true (default), redactWords: [] }
  When disabled the recorder stays silent apart from TAB_READY.
*/

import { MSG, PAGE_EVENT, SITE_BY_HOST } from "../core/contract.js";
import { normalizePath, shapeOf, htmlOutline, redactText, hashString } from "./redact.js";

(() => {
  const site = /** @type {Record<string, string>} */ (SITE_BY_HOST)[location.hostname];
  if (!site) return;

  const READY_EVENT = "wa1:recorder-ready";
  const SNAP_THROTTLE_MS = 3000;
  const SNAP_MIN_INTERVAL_MS = 10000;

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

  /** Extension reloads invalidate the context; never let that surface. */
  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      /* context invalidated */
    }
  }

  send({ type: MSG.TAB_READY, source: site, url: location.origin + location.pathname });

  function applySettings(s) {
    enabled = !s || s.enabled !== false;
    redactWords = s && Array.isArray(s.redactWords) ? s.redactWords : [];
  }

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
    startSnapshots();
  }

  /** @param {Event} e */
  function onPageEvent(e) {
    if (!enabled) return;
    try {
      const d = JSON.parse(/** @type {CustomEvent} */ (e).detail);
      if (!d || d.kind !== "net") return;
      /** @type {any} */
      let shape = null;
      const ct = String(d.contentType || "");
      if (typeof d.body === "string" && d.body) {
        if (/json/i.test(ct)) {
          try {
            shape = shapeOf(JSON.parse(d.body), "", 0, redactWords);
          } catch {
            shape = null;
          }
        } else if (/html/i.test(ct)) {
          try {
            shape = htmlOutline(new DOMParser().parseFromString(d.body, "text/html"), outlineOpts());
          } catch {
            shape = null;
          }
        }
      }
      send({
        type: MSG.DISCOVERY,
        site,
        entry: {
          kind: "net",
          endpoint: normalizePath(d.url),
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
      const path = normalizePath(location.href);
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

  /* ------------------------- settings ------------------------- */

  try {
    chrome.storage.local
      .get("discoverySettings")
      .then(({ discoverySettings }) => {
        applySettings(discoverySettings);
        if (enabled) wire();
      })
      .catch(() => wire());
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.discoverySettings) return;
      applySettings(changes.discoverySettings.newValue);
      if (enabled) wire();
    });
  } catch {
    wire();
  }
})();
