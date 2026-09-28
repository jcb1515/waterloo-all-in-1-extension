// @ts-check
// WaterlooWorks content script — DOM snapshotter (T3). Isolated world, plain
// script, self-contained on purpose: no imports, no requests, no navigation,
// no clicking. Sends the rendered structure to the background as an
// ObservedPayload; parsers.js does the real parsing in the offscreen document.
(() => {
  // Any /myAccount/ page — grids, dashboard, messages, rankings, job/interview
  // details all live under it.
  if (!/^https:\/\/waterlooworks\.uwaterloo\.ca\/myAccount\//.test(location.href)) {
    return;
  }

  const MAX_BYTES = 1.5 * 1024 * 1024;
  const OBSERVE_SEL = [
    "h1", "h2", "h3", "h4",
    "table",
    // label/value fallbacks: dl blocks and .label/.value-style pairs
    "dl", ".label", ".control-label", ".field-label",
  ].join(",");
  const loadedAt = Date.now();
  /** @type {string|null} */
  let lastHash = null;
  /** @type {number|undefined} */
  let timer;

  // Small string hash so we only send when the snapshot actually changed.
  const hashOf = (text) => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16);
  };

  const buildSnapshot = () => {
    /** @type {Element[]} */
    const targets = [];
    for (const el of document.querySelectorAll(OBSERVE_SEL)) {
      // .label/.value pairs need their shared parent to keep the pairing.
      const target =
        el.matches(".label,.control-label,.field-label") && el.parentElement
          ? el.parentElement
          : el;
      if (!targets.includes(target)) targets.push(target);
    }
    // A target contained in another target would duplicate its tables —
    // WW reuses ".label" broadly and the shared parent can wrap a grid.
    const unique = targets.filter(
      (t) => !targets.some((o) => o !== t && o.contains(t))
    );
    const parts = [];
    for (const el of unique) {
      const html = el.outerHTML;
      if (html && !parts.includes(html)) parts.push(html);
    }
    const complete =
      document.readyState === "complete" && Date.now() - loadedAt >= 3000;
    const snapshot =
      `<html data-wa1-complete="${complete ? "1" : "0"}"><head><title>` +
      `${(document.title || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")}` +
      `</title></head><body>${parts.join("")}</body></html>`;
    return snapshot.length <= MAX_BYTES ? snapshot : null;
  };

  const send = () => {
    try {
      const snapshot = buildSnapshot();
      if (!snapshot) return;
      const hash = hashOf(snapshot);
      if (hash === lastHash) return;
      lastHash = hash;
      // Mirror of MSG.OBSERVED — literal so this file stays import-free.
      chrome.runtime.sendMessage({
        type: "wa1:observed",
        payload: {
          source: "waterlooworks",
          kind: "dom",
          url: location.href,
          body: snapshot,
          at: new Date().toISOString(),
        },
      });
    } catch {
      // Extension reloads invalidate the context — never throw into the page.
    }
  };

  const schedule = () => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      send();
    }, 2000); // throttled: Vue re-renders in bursts
  };

  send();
  window.addEventListener("load", send);
  // A page that finishes rendering before the 3 s completeness mark may never
  // mutate again — resend once shortly after the mark so a complete=1
  // snapshot lands even on a static page (hash dedupe still applies).
  const resendAfterSettled = () => {
    setTimeout(send, Math.max(0, loadedAt + 3000 - Date.now()) + 100);
  };
  window.addEventListener("load", resendAfterSettled);
  if (document.readyState === "complete") resendAfterSettled();
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
})();
