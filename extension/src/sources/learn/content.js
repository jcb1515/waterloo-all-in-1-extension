/*
  Content script on Learn pages.

  Mock Learn (localhost:8080/d2l/*): the mock pages and the extension talk only
  through DOM events on document.
    page -> extension  "learn-mock:ready"   the page wants course data
    extension -> page  "learn-mock:data"    detail is a JSON string of the fake Learn catalog
    page -> extension  "learn-mock:submit"  detail is JSON { ou, itemId, kind } after Submit on a dropbox or quiz

  Contract relay (T2), on any Learn page:
    background -> here  { type: MSG.RELAY_FETCH, path, init }  runs a GET on
      this page's own origin, which carries the Learn session cookie, and
      returns a contract FetchResult. Only /d2l/api/ paths are allowed.
      init.binary answers chunked base64 (10 MB cap -> error "too-large");
      bodies are read only when res.ok.
  See src/sources/learn/live-source.js.
*/
import { MSG } from "../../core/contract.js";
import { guardInstance } from "../../capture/guard.js";
import { readBodyInto } from "../../capture/fetch.js";

(() => {
  // Re-injected by W1 on install/update/startup — a live copy answers the
  // ping and we return; an orphan is superseded and runs teardown.
  if (!guardInstance("learn-content", teardown)) return;
  const isMock = location.hostname === "localhost" || location.hostname === "127.0.0.1";

  // Contract relay (T2): background asks an open Learn tab to run a GET with
  // the page's own session cookie and answer a contract FetchResult.
  const onRelayFetch = (/** @type {any} */ msg, /** @type {any} */ _sender, /** @type {any} */ sendResponse) => {
    if (!msg || msg.type !== MSG.RELAY_FETCH) return false;
    const path = String(msg.path || "");
    const method = String((msg.init && msg.init.method) || "GET").toUpperCase();
    if (method !== "GET" || !path.startsWith("/d2l/api/") || path.includes("..")) {
      sendResponse({ status: 0, error: "path not allowed" });
      return false;
    }
    (async () => {
      try {
        const res = await fetch(location.origin + path, {
          method: "GET",
          credentials: "same-origin",
          headers: (msg.init && msg.init.headers) || { Accept: "application/json" },
          signal: AbortSignal.timeout(20000),
        });
        const out = {
          status: res.status,
          url: res.url,
          contentType: res.headers.get("content-type") || "",
          loginRedirect: /\/d2l\/login/i.test(res.url || ""),
        };
        if (res.ok) await readBodyInto(res, out, !!(msg.init && msg.init.binary));
        sendResponse(out);
      } catch (e) {
        sendResponse({ status: 0, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  };
  chrome.runtime.onMessage.addListener(onRelayFetch);

  /** Superseded by a re-injected copy — drop the listeners we registered. */
  function teardown() {
    try {
      chrome.runtime.onMessage.removeListener(onRelayFetch);
      chrome.storage.onChanged.removeListener(onCatalogChange);
    } catch {
      /* dead context */
    }
    try {
      document.removeEventListener("learn-mock:ready", sendData);
      document.removeEventListener("learn-mock:submit", onMockSubmit);
    } catch {
      /* never wired on non-mock pages */
    }
  }

  if (!isMock) return;

  async function sendData() {
    let catalog;
    try {
      ({ catalog } = await chrome.storage.local.get("catalog"));
    } catch {
      return;
    }
    if (!catalog) return;
    const payload = {
      student: catalog.student,
      term: catalog.term,
      courses: catalog.courses,
      items: catalog.items,
      builtAt: catalog.builtAt,
    };
    document.dispatchEvent(new CustomEvent("learn-mock:data", { detail: JSON.stringify(payload) }));
  }

  document.addEventListener("learn-mock:ready", sendData);

  const onMockSubmit = (/** @type {any} */ e) => {
    let d;
    try {
      d = JSON.parse(e.detail);
    } catch {
      return;
    }
    chrome.runtime.sendMessage({ type: "learn:submitted", orgUnitId: d.ou, itemId: d.itemId, kind: d.kind });
  };
  document.addEventListener("learn-mock:submit", onMockSubmit);

  const onCatalogChange = (/** @type {any} */ changes, /** @type {any} */ area) => {
    if (area === "local" && changes.catalog) sendData();
  };
  chrome.storage.onChanged.addListener(onCatalogChange);

  sendData();
})();
