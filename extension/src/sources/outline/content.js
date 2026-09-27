// @ts-check
// Course-outline content script — passive DOM snapshotter (T3). Isolated world,
// plain script, self-contained on purpose: no imports, no requests, no
// navigation. Sends the whole page to the background as an ObservedPayload;
// parsers.js does the real parsing in the offscreen document.
(() => {
  // Only /viewer/view/ pages are real outlines.
  if (!/^https:\/\/outline\.uwaterloo\.ca\/viewer\/view\//.test(location.href)) {
    return;
  }

  const MAX_BYTES = 3 * 1024 * 1024;
  const MAX_SENDS = 5;
  /** @type {string|null} */
  let lastHash = null;
  let sends = 0;
  /** @type {number|undefined} */
  let timer;

  // Small string hash so we only send when the page actually changed.
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
      if (sends >= MAX_SENDS) return;
      const body = document.documentElement && document.documentElement.outerHTML;
      if (!body || body.length > MAX_BYTES) return;
      const hash = hashOf(body);
      if (hash === lastHash) return;
      lastHash = hash;
      sends++;
      // Mirror of MSG.OBSERVED — literal so this file stays import-free.
      chrome.runtime.sendMessage({
        type: "wa1:observed",
        payload: {
          source: "outline",
          kind: "dom",
          url: location.origin + location.pathname,
          body,
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
    }, 1500); // outline pages render in bursts
  };

  send();
  window.addEventListener("load", send);
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
})();
