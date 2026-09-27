// @ts-check
/*
  Offscreen document (reasons: ["DOM_PARSER"]). The background has no DOM, so
  HTML bodies are parsed here: {target:"offscreen", type:"parse",
  parser:"<source>/<name>", html, opts} -> {ok, result} | {ok:false, error}.
  Parsers are pure (doc, opts) functions registered in src/sources/parsers.js.
*/

import { PARSERS } from "../sources/parsers.js";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen" || msg.type !== "parse") return false;
  (async () => {
    try {
      const [source, name] = String(msg.parser || "").split("/");
      const table = source ? PARSERS[/** @type {keyof typeof PARSERS} */ (source)] : null;
      const fn = table && name ? table[name] : null;
      if (typeof fn !== "function") {
        sendResponse({ ok: false, error: `unknown parser "${msg.parser}"` });
        return;
      }
      const doc = new DOMParser().parseFromString(String(msg.html ?? ""), "text/html");
      const result = await fn(doc, msg.opts || {});
      sendResponse({ ok: true, result });
    } catch (e) {
      const err = /** @type {any} */ (e);
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
  })();
  return true;
});
