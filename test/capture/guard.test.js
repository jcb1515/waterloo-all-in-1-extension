// @ts-check
// capture/guard.js — the wa1:ping/pong/supersede handshake that keeps two
// recorder copies from running in one isolated world. Uses a minimal fake
// document with synchronous dispatchEvent (matching the DOM contract).
import test from "node:test";
import assert from "node:assert/strict";
import { guardInstance } from "../../extension/src/capture/guard.js";

// Node lacks the DOM CustomEvent global on older versions — a plain
// type/detail stand-in is all the handshake needs.
if (typeof globalThis.CustomEvent !== "function") {
  // @ts-ignore minimal stand-in
  globalThis.CustomEvent = class CustomEvent {
    /** @param {string} type @param {any} [init] */
    constructor(type, init) {
      this.type = type;
      this.detail = init && init.detail;
    }
  };
}

/** Minimal EventTarget: synchronous dispatch, per-type listener sets. */
function fakeDoc() {
  /** @type {Record<string, Set<Function>>} */
  const map = {};
  return {
    addEventListener(/** @type {string} */ t, /** @type {Function} */ fn) {
      (map[t] = map[t] || new Set()).add(fn);
    },
    removeEventListener(/** @type {string} */ t, /** @type {Function} */ fn) {
      if (map[t]) map[t].delete(fn);
    },
    dispatchEvent(/** @type {any} */ e) {
      for (const fn of [...(map[e.type] || [])]) fn(e);
      return true;
    },
  };
}

/** Install a stub `chrome` global for the duration of fn, then restore. */
async function withChromeRuntime(id, fn) {
  const g = /** @type {any} */ (globalThis);
  const prev = g.chrome;
  g.chrome = { runtime: { id } };
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete g.chrome;
    else g.chrome = prev;
  }
}

test("live instance answers: a second instance skips", async () => {
  await withChromeRuntime("ext-1", async () => {
    const doc = fakeDoc();
    let torn1 = false;
    assert.equal(guardInstance("rec", () => (torn1 = true), doc), true);
    // A second injection in the same world sees the pong and stays out.
    assert.equal(guardInstance("rec", () => {}, doc), false);
    assert.equal(torn1, false);
  });
});

test("orphaned instance (dead chrome.runtime) is superseded and torn down", async () => {
  const doc = fakeDoc();
  let torn1 = false;
  // First instance installs while its runtime is alive.
  await withChromeRuntime("ext-1", async () => {
    assert.equal(guardInstance("rec", () => (torn1 = true), doc), true);
  });
  // The extension reloaded: the first copy's runtime.id is now undefined,
  // so it can't pong — the new copy supersedes it and it tears down.
  delete /** @type {any} */ (globalThis).chrome; // orphan sees no usable runtime
  let torn2 = false;
  assert.equal(guardInstance("rec", () => (torn2 = true), doc), true);
  assert.equal(torn1, true, "first instance's teardown ran");
  // And the new instance is now the live one.
  await withChromeRuntime("ext-2", async () => {
    assert.equal(guardInstance("rec", () => {}, doc), false);
  });
  assert.equal(torn2, false);
});

test("different names don't interact", async () => {
  await withChromeRuntime("ext-1", async () => {
    const doc = fakeDoc();
    assert.equal(guardInstance("a", () => {}, doc), true);
    assert.equal(guardInstance("b", () => {}, doc), true);
  });
});

test("no document -> runs (non-DOM contexts can't coordinate)", () => {
  assert.equal(guardInstance("rec", () => {}, null), true);
});
