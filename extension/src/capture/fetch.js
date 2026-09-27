// @ts-check
/*
  The two ways adapters read a site:
    T1 t1Fetch(url, init)   direct fetch from the service worker, cookies on
    T2 relayFetch(origin, path, init)  runs the fetch inside an open tab of the
       site (recorder.content.js answers MSG.RELAY_FETCH), for hosts whose
       cookies never reach the worker.

  Both return contract FetchResult: {status, url, contentType, text?,
  loginRedirect?, noTab?, error?}. Body text is kept only for 2xx answers.
*/

import { MSG } from "../core/contract.js";

const TIMEOUT_MS = 20000;
const LOGIN_URL_RE = /login|signin|sso|cas|idp/i;

/**
 * Direct fetch with the browser's cookies.
 * @param {string} url
 * @param {{method?: string, headers?: Record<string,string>, body?: string}} [init]
 * @returns {Promise<import("../core/contract.js").FetchResult>}
 */
export async function t1Fetch(url, init = {}) {
  /** @type {Response} */
  let res;
  try {
    res = await fetch(url, {
      method: init.method || "GET",
      headers: init.headers,
      body: init.body,
      credentials: "include",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const err = /** @type {any} */ (e);
    return { status: 0, error: err && err.name === "TimeoutError" ? "timeout" : String((err && err.message) || err) };
  }
  const out = {
    status: res.status,
    url: res.url || url,
    contentType: res.headers.get("content-type") || "",
  };
  if (res.status === 401 || LOGIN_URL_RE.test(out.url || "")) out.loginRedirect = true;
  if (res.ok) {
    try {
      out.text = await res.text();
    } catch {
      /* body unreadable */
    }
  }
  return out;
}

/**
 * Runs the fetch inside an open tab of `origin` (the site's own cookies).
 * Tabs are tried active-first, then most recently used; discarded tabs are
 * skipped. Resolves {status:0, noTab:true} when no tab answers.
 * @param {string} origin e.g. "https://waterlooworks.uwaterloo.ca"
 * @param {string} path site-relative path starting with "/"
 * @param {{method?: string, headers?: Record<string,string>, body?: string}} [init]
 * @returns {Promise<import("../core/contract.js").FetchResult>}
 */
export async function relayFetch(origin, path, init = {}) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: `${origin}/*` });
  } catch {
    return { status: 0, noTab: true };
  }
  tabs = tabs
    .filter((t) => !t.discarded)
    .sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
  for (const tab of tabs) {
    if (tab.id == null) continue;
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: MSG.RELAY_FETCH, path, init });
      if (res && typeof res === "object") return res;
    } catch {
      /* no recorder in this tab */
    }
  }
  return { status: 0, noTab: true };
}
