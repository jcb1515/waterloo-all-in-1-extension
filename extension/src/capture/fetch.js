// @ts-check
/*
  The two ways adapters read a site:
    T1 t1Fetch(url, init)   direct fetch from the service worker, cookies on
    T2 relayFetch(origin, path, init)  runs the fetch inside an open tab of the
       site (recorder.content.js answers MSG.RELAY_FETCH), for hosts whose
       cookies never reach the worker.

  Both return contract FetchResult: {status, url, contentType, text?,
  base64?, loginRedirect?, noTab?, error?}. A body is kept only for 2xx
  answers — text normally, chunked base64 when init.binary is true.
*/

import { MSG } from "../core/contract.js";

const TIMEOUT_MS = 20000;
const LOGIN_URL_RE = /login|signin|sso|cas|idp/i;
/** Binary bodies larger than this answer {error:"too-large"} instead. */
export const BINARY_CAP_BYTES = 10 * 1024 * 1024;

/**
 * Uint8Array -> base64 in 32 KiB chunks, safe for multi-MB bodies (a
 * String.fromCharCode spread would blow the argument limit).
 * @param {Uint8Array} bytes
 */
export function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, /** @type {any} */ (bytes.subarray(i, i + 0x8000)));
  }
  return btoa(bin);
}

/**
 * Read a 2xx response body into the FetchResult being built: `text`
 * normally, chunked base64 when binary (10 MB cap -> error "too-large").
 * Shared by t1Fetch and the recorder's RELAY_FETCH handler.
 * @param {Response} res
 * @param {Record<string, any>} out
 * @param {boolean} [binary]
 */
export async function readBodyInto(res, out, binary) {
  try {
    if (binary) {
      const declared = Number(res.headers.get("content-length") || 0);
      if (declared > BINARY_CAP_BYTES) {
        out.error = "too-large";
        return;
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > BINARY_CAP_BYTES) {
        out.error = "too-large";
        return;
      }
      out.base64 = bytesToBase64(buf);
    } else {
      out.text = await res.text();
    }
  } catch {
    /* body unreadable */
  }
}

/**
 * Direct fetch with the browser's cookies.
 * @param {string} url
 * @param {{method?: string, headers?: Record<string,string>, body?: string, binary?: boolean}} [init]
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
  if (res.ok) await readBodyInto(res, out, init.binary === true);
  return out;
}

/**
 * Runs the fetch inside an open tab of `origin` (the site's own cookies).
 * Tabs are tried active-first, then most recently used; discarded tabs are
 * skipped. Resolves {status:0, noTab:true} when no tab answers.
 * @param {string} origin e.g. "https://waterlooworks.uwaterloo.ca"
 * @param {string} path site-relative path starting with "/"
 * @param {{method?: string, headers?: Record<string,string>, body?: string, binary?: boolean}} [init]
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
