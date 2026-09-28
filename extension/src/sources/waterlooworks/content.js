// @ts-check
// WaterlooWorks content script — DOM snapshotter (T3) plus the in-tab refresh
// trigger (T4). Isolated world. The snapshot builder and the hidden-iframe
// refresh round live in refresh.js (bundled into this script); this file owns
// only the trigger wiring: hash-deduped sends and the throttled refresh kick.
// No requests and no navigation of THIS page; parsers.js does the parsing.
import { buildSnapshot, maybeRefresh } from "./refresh.js";

(() => {
  // Any /myAccount/ page — grids, dashboard, messages, rankings, job/interview
  // details all live under it.
  if (!/^https:\/\/waterlooworks\.uwaterloo\.ca\/myAccount\//.test(location.href)) {
    return;
  }

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

  const send = () => {
    try {
      const complete =
        document.readyState === "complete" && Date.now() - loadedAt >= 3000;
      const snapshot = buildSnapshot(document, complete);
      if (!snapshot) return;
      const hash = hashOf(snapshot);
      if (hash === lastHash) return;
      lastHash = hash;
      // Mirror of MSG.OBSERVED — the literal keeps this script dependency-free
      // of the background's message registry.
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
  // snapshot lands even on a static page (hash dedupe still applies). Once
  // the page has settled, kick the throttled iframe refresh round too: it
  // self-gates on visibility, the 30 min per-tab throttle and the click
  // allowlist.
  const resendAfterSettled = () => {
    setTimeout(() => {
      send();
      maybeRefresh();
    }, Math.max(0, loadedAt + 3000 - Date.now()) + 100);
  };
  window.addEventListener("load", resendAfterSettled);
  if (document.readyState === "complete") resendAfterSettled();
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
})();
