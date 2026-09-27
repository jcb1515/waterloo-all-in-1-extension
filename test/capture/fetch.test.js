// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { t1Fetch, bytesToBase64, BINARY_CAP_BYTES } from "../../extension/src/capture/fetch.js";

/** @param {Uint8Array|string} body @param {Record<string,string>} [headers] */
function fakeResponse(body, headers = {}) {
  return new Response(body, { status: 200, headers });
}

test("bytesToBase64 encodes multi-chunk input identically to one-shot btoa", () => {
  const bytes = new Uint8Array(70000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const expect = btoa(String.fromCharCode(...bytes.subarray(0, 0x8000)));
  // one-shot on the whole buffer would overflow; compare via chunk joins
  let join = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    join += String.fromCharCode.apply(null, /** @type {any} */ (bytes.subarray(i, i + 0x8000)));
  }
  assert.equal(bytesToBase64(bytes), btoa(join));
  assert.ok(bytesToBase64(bytes).startsWith(expect.slice(0, 40)));
});

test("t1Fetch returns text by default", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => fakeResponse("hello", { "content-type": "text/plain" });
  try {
    const r = await t1Fetch("https://x.test/a");
    assert.equal(r.status, 200);
    assert.equal(r.text, "hello");
    assert.equal(r.base64, undefined);
  } finally {
    globalThis.fetch = orig;
  }
});

test("t1Fetch binary:true returns chunked base64 and no text", async () => {
  const bytes = new Uint8Array(70000); // > one 32 KiB chunk
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const orig = globalThis.fetch;
  /** @type {any[]} */
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(init);
    return fakeResponse(bytes, { "content-type": "application/pdf" });
  };
  try {
    const r = await t1Fetch("https://x.test/f.pdf", { binary: true });
    assert.equal(r.status, 200);
    assert.equal(r.text, undefined);
    assert.equal(r.base64, bytesToBase64(bytes));
    // round-trip: the decoder sees the same bytes
    const back = Uint8Array.from(atob(/** @type {string} */ (r.base64)), (c) => c.charCodeAt(0));
    assert.deepEqual(back, bytes);
  } finally {
    globalThis.fetch = orig;
  }
});

test("t1Fetch binary over the cap returns error too-large", async () => {
  const orig = globalThis.fetch;
  // Declared content-length over the cap: no body read needed.
  globalThis.fetch = async () =>
    fakeResponse(new Uint8Array(4), {
      "content-type": "application/pdf",
      "content-length": String(BINARY_CAP_BYTES + 1),
    });
  try {
    const r = await t1Fetch("https://x.test/big.pdf", { binary: true });
    assert.equal(r.error, "too-large");
    assert.equal(r.base64, undefined);
    assert.equal(r.text, undefined);
  } finally {
    globalThis.fetch = orig;
  }
});

test("t1Fetch binary body over the cap without a declared length returns too-large", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => fakeResponse(new Uint8Array(BINARY_CAP_BYTES + 1));
  try {
    const r = await t1Fetch("https://x.test/big.pdf", { binary: true });
    assert.equal(r.error, "too-large");
    assert.equal(r.base64, undefined);
  } finally {
    globalThis.fetch = orig;
  }
});

test("t1Fetch surfaces network errors as status 0", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("boom");
  };
  try {
    const r = await t1Fetch("https://x.test/a");
    assert.equal(r.status, 0);
    assert.equal(r.error, "boom");
  } finally {
    globalThis.fetch = orig;
  }
});
