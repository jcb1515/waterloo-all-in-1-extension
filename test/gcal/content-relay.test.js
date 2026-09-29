// @ts-check
// gcal/content.js RELAY_FETCH handler: GET-only allowlist for the export zip
// and subscribed .ics paths, same-origin credentials, binary -> base64 via
// readBodyInto, and no body on non-2xx.

import test from "node:test";
import assert from "node:assert/strict";
import { MSG } from "../../extension/src/core/contract.js";

const REALS = {
  location: globalThis.location,
  chrome: globalThis.chrome,
  fetch: globalThis.fetch,
  document: /** @type {any} */ (globalThis).document,
  MutationObserver: /** @type {any} */ (globalThis).MutationObserver,
  addEventListener: /** @type {any} */ (globalThis).addEventListener,
  removeEventListener: /** @type {any} */ (globalThis).removeEventListener,
};

/** Install fakes and load content.js once, capturing the onMessage listener. */
let listener = /** @type {any} */ (null);
globalThis.location = new URL("https://calendar.google.com/calendar/u/0/r/week");
globalThis.chrome = /** @type {any} */ ({
  runtime: {
    id: "test",
    onMessage: { addListener: (/** @type {any} */ fn) => (listener = fn) },
    sendMessage: async () => {},
  },
});
/** @type {any} */ (globalThis).document = {
  readyState: "loading", // start() defers on "load" — the DOM reader never runs
  documentElement: {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
  querySelectorAll: () => [],
};
/** @type {any} */ (globalThis).addEventListener = () => {};
/** @type {any} */ (globalThis).removeEventListener = () => {};
/** @type {any} */ (globalThis).MutationObserver = class {
  observe() {}
  disconnect() {}
};
await import("../../extension/src/sources/gcal/content.js");
assert.ok(listener, "content.js registered an onMessage listener");

const call = (/** @type {any} */ msg) =>
  new Promise((resolve, reject) => {
    const keepOpen = listener(msg, {}, resolve);
    assert.equal(keepOpen, true);
    setTimeout(() => reject(new Error("no response")), 3000);
  });

test.after(() => {
  globalThis.location = REALS.location;
  globalThis.chrome = REALS.chrome;
  globalThis.fetch = REALS.fetch;
  /** @type {any} */ (globalThis).document = REALS.document;
  /** @type {any} */ (globalThis).MutationObserver = REALS.MutationObserver;
  /** @type {any} */ (globalThis).addEventListener = REALS.addEventListener;
  /** @type {any} */ (globalThis).removeEventListener = REALS.removeEventListener;
});

test("non-relay messages are ignored so other listeners still work", () => {
  assert.equal(listener({ type: "wa1:other" }, {}, () => {}), undefined);
  assert.equal(listener(null, {}, () => {}), undefined);
});

test("export path allowed: same-origin GET on location.origin + path", async () => {
  /** @type {any[]} */
  const calls = [];
  globalThis.fetch = async (/** @type {any} */ url, /** @type {any} */ init) => {
    calls.push({ url: String(url), credentials: init && init.credentials });
    return new Response(new Uint8Array([0x50, 0x4b, 3, 4, 1, 2]), { status: 200 });
  };
  const res = /** @type {any} */ (
    await call({
      type: MSG.RELAY_FETCH,
      path: "/calendar/u/0/exporticalzip",
      init: { binary: true },
    })
  );
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://calendar.google.com/calendar/u/0/exporticalzip");
  assert.equal(calls[0].credentials, "same-origin");
  assert.equal(res.base64, Buffer.from([0x50, 0x4b, 3, 4, 1, 2]).toString("base64"));
  assert.equal(res.text, undefined);
});

test("ical path allowed; text body without init.binary", async () => {
  /** @type {any[]} */
  const calls = [];
  globalThis.fetch = async (/** @type {any} */ url, /** @type {any} */ init) => {
    calls.push({ url: String(url), credentials: init && init.credentials });
    return new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", { status: 200 });
  };
  const res = /** @type {any} */ (
    await call({ type: MSG.RELAY_FETCH, path: "/calendar/ical/u/private-k/basic.ics" })
  );
  assert.equal(res.status, 200);
  assert.equal(res.text, "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
  assert.equal(res.base64, undefined);
  assert.equal(calls[0].credentials, "same-origin");
});

test("disallowed paths and non-GET are refused before any fetch", async () => {
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    return new Response("x", { status: 200 });
  };
  for (const msg of [
    { type: MSG.RELAY_FETCH, path: "/calendar/u/0/settings" },
    { type: MSG.RELAY_FETCH, path: "/calendar/u/123/exporticalzip" }, // >2 digit account
    { type: MSG.RELAY_FETCH, path: "/calendar/ical/foo" }, // no .ics
    { type: MSG.RELAY_FETCH, path: "/calendar/ical/x.ics?secret=1" }, // query not allowed
    { type: MSG.RELAY_FETCH, path: "/calendar/../x/exporticalzip" },
    { type: MSG.RELAY_FETCH, path: "https://evil.example.com/calendar/u/0/exporticalzip" },
    { type: MSG.RELAY_FETCH, path: "/calendar/u/0/exporticalzip", init: { method: "POST" } },
    { type: MSG.RELAY_FETCH },
  ]) {
    const res = /** @type {any} */ (await call(msg));
    assert.equal(res.status, 0, JSON.stringify(msg));
    assert.equal(res.error, "path not allowed", JSON.stringify(msg));
  }
  assert.equal(fetches, 0);
});

test("non-2xx reads no body; failure returns status 0 + error", async () => {
  globalThis.fetch = async () => new Response("denied", { status: 403 });
  const res = /** @type {any} */ (
    await call({ type: MSG.RELAY_FETCH, path: "/calendar/u/1/exporticalzip", init: { binary: true } })
  );
  assert.equal(res.status, 403);
  assert.equal(res.base64, undefined);
  assert.equal(res.text, undefined);

  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  const err = /** @type {any} */ (
    await call({ type: MSG.RELAY_FETCH, path: "/calendar/u/0/exporticalzip" })
  );
  assert.equal(err.status, 0);
  assert.equal(err.error, "Failed to fetch");
});
