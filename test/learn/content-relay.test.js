// @ts-check
// learn/content.js RELAY_FETCH handler: binary answers base64 via readBodyInto,
// text otherwise, and bodies are only read on 2xx.

import test from "node:test";
import assert from "node:assert/strict";
import { MSG } from "../../extension/src/core/contract.js";

const REALS = {
  location: globalThis.location,
  chrome: globalThis.chrome,
  fetch: globalThis.fetch,
};

/** Install fakes and load content.js once, capturing the onMessage listener. */
let listener = /** @type {any} */ (null);
globalThis.location = new URL("https://learn.uwaterloo.ca/d2l/home");
globalThis.chrome = {
  runtime: { onMessage: { addListener: (fn) => (listener = fn) } },
};
await import("../../extension/src/sources/learn/content.js");
assert.ok(listener, "content.js registered an onMessage listener");

const call = (msg) =>
  new Promise((resolve, reject) => {
    const keepOpen = listener(msg, {}, resolve);
    assert.equal(keepOpen, true);
    setTimeout(() => reject(new Error("no response")), 3000);
  });

test.after(() => {
  globalThis.location = REALS.location;
  globalThis.chrome = REALS.chrome;
  globalThis.fetch = REALS.fetch;
});

test("RELAY_FETCH answers base64 when init.binary, text otherwise", async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  globalThis.fetch = async () => new Response(bytes, { status: 200 });

  const bin = /** @type {any} */ (
    await call({ type: MSG.RELAY_FETCH, path: "/d2l/api/le/1.0/x", init: { binary: true } })
  );
  assert.equal(bin.status, 200);
  assert.equal(bin.base64, Buffer.from(bytes).toString("base64"));
  assert.equal(bin.text, undefined);

  globalThis.fetch = async () => new Response("hello world", { status: 200 });
  const txt = /** @type {any} */ (
    await call({ type: MSG.RELAY_FETCH, path: "/d2l/api/le/1.0/x" })
  );
  assert.equal(txt.status, 200);
  assert.equal(txt.text, "hello world");
  assert.equal(txt.base64, undefined);
});

test("RELAY_FETCH reads no body on non-2xx", async () => {
  globalThis.fetch = async () => new Response("denied body", { status: 403 });
  const res = /** @type {any} */ (
    await call({ type: MSG.RELAY_FETCH, path: "/d2l/api/le/1.0/x", init: { binary: true } })
  );
  assert.equal(res.status, 403);
  assert.equal(res.text, undefined);
  assert.equal(res.base64, undefined);
});
