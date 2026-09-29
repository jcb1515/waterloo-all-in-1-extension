// @ts-check
/*
  Learn content script: answers MSG.RELAY_FETCH by fetching a /d2l/api/ path
  inside the open Learn tab, so the read uses the tab's session cookies. GET
  only, path allowlisted, 20 s cap. The double-injection guard keeps one live
  listener per isolated world across reinjects.
*/

import { MSG } from "../../core/contract.js";
import { guardInstance } from "../../capture/guard.js";
import { readBodyInto } from "../../capture/fetch.js";

const TIMEOUT_MS = 20000;
const PATH_RE = /^\/d2l\/api\//;

/** @param {any} msg */
async function relayFetch(msg) {
  const init = (msg && msg.init) || {};
  const method = String(init.method || "GET").toUpperCase();
  const path = String((msg && msg.path) || "");
  if (method !== "GET" || !PATH_RE.test(path) || path.includes("..")) {
    return { status: 0, error: "path not allowed" };
  }
  /** @type {Response} */
  let res;
  try {
    res = await fetch(location.origin + path, {
      method: "GET",
      credentials: "same-origin",
      headers: init.headers || { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return { status: 0, error: String(e instanceof Error ? e.message : e) };
  }
  const out = {
    status: res.status,
    url: res.url || "",
    contentType: res.headers.get("content-type") || "",
    loginRedirect: /\/d2l\/login/i.test(res.url || ""),
  };
  if (res.ok) await readBodyInto(res, out, !!init.binary);
  return out;
}

/** @param {any} msg */
const onMessage = (msg, _sender, reply) => {
  if (!msg || msg.type !== MSG.RELAY_FETCH) return undefined;
  relayFetch(msg).then(reply);
  return true;
};

function teardown() {
  try {
    chrome.runtime.onMessage.removeListener(onMessage);
  } catch {
    /* context already gone */
  }
}

if (guardInstance("learn-content", teardown)) {
  chrome.runtime.onMessage.addListener(onMessage);
}
