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
  See src/sources/learn/live-source.js.
*/
import { MSG } from "../../core/contract.js";

(() => {
  const isMock = location.hostname === "localhost" || location.hostname === "127.0.0.1";

  // Contract relay (T2): background asks an open Learn tab to run a GET with
  // the page's own session cookie and answer a contract FetchResult.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
        let text = "";
        try {
          text = await res.text();
        } catch {
          /* no body */
        }
        sendResponse({
          status: res.status,
          url: res.url,
          contentType: res.headers.get("content-type") || "",
          text,
          loginRedirect: /\/d2l\/login/i.test(res.url || ""),
        });
      } catch (e) {
        sendResponse({ status: 0, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  });

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

  document.addEventListener("learn-mock:submit", (e) => {
    let d;
    try {
      d = JSON.parse(e.detail);
    } catch {
      return;
    }
    chrome.runtime.sendMessage({ type: "learn:submitted", orgUnitId: d.ou, itemId: d.itemId, kind: d.kind });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.catalog) sendData();
  });

  sendData();
})();
