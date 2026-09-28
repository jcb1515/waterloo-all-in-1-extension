// @ts-check
// Hang guards: a parseHtml call that the offscreen document never answers and
// a sync() that never resolves must fail fast instead of freezing the
// source's ingest queue. __setTimeoutsForTest shrinks both timeouts.

import test from "node:test";
import assert from "node:assert/strict";

// Minimal chrome stub — storage plus the offscreen-parse plumbing. The
// offscreen document pretends to exist; its parse answer never arrives.
const store = new Map();
globalThis.chrome = /** @type {any} */ ({
  storage: {
    local: {
      get: async (keys) => {
        if (typeof keys === "string") return { [keys]: store.get(keys) };
        const out = /** @type {Record<string, any>} */ ({});
        for (const k of keys) out[k] = store.get(k);
        return out;
      },
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) store.set(k, v);
      },
      remove: async (keys) => {
        for (const k of [].concat(keys)) store.delete(k);
      },
    },
    onChanged: { addListener() {}, removeListener() {} },
  },
  action: { setBadgeText: async () => {} },
  alarms: { create() {}, clear() {}, get: async () => undefined },
  runtime: {
    getURL: (p) => `chrome-extension://fake/${p}`,
    getContexts: async () => [{}], // pretend the offscreen doc exists
    sendMessage: () => new Promise(() => {}), // the parse answer never comes
  },
});

const { runSync, handleObserved, __setTimeoutsForTest } = await import(
  "../../extension/src/core/scheduler.js"
);
const { ADAPTERS } = await import("../../extension/src/core/registry.js");

__setTimeoutsForTest({ parseMs: 30, syncMs: 30 });

const SOURCE = "manual";
const rawKey = `raw:${SOURCE}`;
const readStats = async () =>
  ((await chrome.storage.local.get("readStats")).readStats) || [];
const logs = async () =>
  ((await chrome.storage.local.get(`log:${SOURCE}`))[`log:${SOURCE}`]) || [];

test("a hanging parseHtml fails with 'parse timeout' and frees the queue", async () => {
  let calls = 0;
  const adapter = {
    id: SOURCE,
    intervalMinutes: 0,
    observe: {
      async parse(/** @type {any} */ payload, /** @type {any} */ ctx) {
        calls++;
        if (calls === 1) {
          // The offscreen parse never resolves — the wrapper must time out.
          await ctx.parseHtml("<html><body>x</body></html>", "x/y");
          return { items: [] };
        }
        return {
          items: [{ id: "m:ok-1", type: "deadline", title: "After", org: "M", source: SOURCE, dueAt: "2026-10-03T23:59:00.000Z" }],
          scope: "m",
          session: "signed-in",
        };
      },
    },
  };
  ADAPTERS.push(/** @type {any} */ (adapter));
  try {
    await handleObserved({ source: SOURCE, url: "https://x/", status: 200 });
    const stats = await readStats();
    const errStat = stats.find((s) => s.kind === "observe" && s.error);
    assert.ok(errStat, "an observe readStat recorded the failure");
    assert.match(errStat.error, /parse timeout/);
    assert.ok(
      (await logs()).some((l) => /observe failed: parse timeout/.test(l.message)),
      "the failure was logged",
    );

    // The source queue is still alive: a later observe folds normally.
    await handleObserved({ source: SOURCE, url: "https://x/2", status: 200 });
    const raw = (await chrome.storage.local.get(rawKey))[rawKey];
    assert.deepEqual(raw.items.map((/** @type {any} */ i) => i.id), ["m:ok-1"]);
  } finally {
    ADAPTERS.splice(ADAPTERS.indexOf(/** @type {any} */ (adapter)), 1);
    store.clear();
  }
});

test("a hanging sync records error code 'timeout' and frees the queue", async () => {
  const adapter = {
    id: SOURCE,
    intervalMinutes: 0,
    async sync() {
      return new Promise(() => {}); // never resolves
    },
    observe: {
      async parse() {
        return {
          items: [{ id: "m:obs-1", type: "event", title: "Obs", org: "M", source: SOURCE, startAt: "2026-10-02T13:00:00.000Z" }],
          scope: "m",
          session: "signed-in",
        };
      },
    },
  };
  ADAPTERS.push(/** @type {any} */ (adapter));
  try {
    const res = await runSync(SOURCE, "manual");
    assert.deepEqual(res, { ok: true });

    const st = ((await chrome.storage.local.get("sourceState")).sourceState || {})[SOURCE];
    assert.equal(st.error && st.error.code, "timeout");
    assert.ok(
      (await logs()).some((l) => /error timeout/.test(l.message)),
      "the timeout was logged",
    );

    // The source queue still works afterwards.
    await handleObserved({ source: SOURCE, url: "https://x/", status: 200 });
    const raw = (await chrome.storage.local.get(rawKey))[rawKey];
    assert.ok(raw.items.some((/** @type {any} */ i) => i.id === "m:obs-1"));
  } finally {
    ADAPTERS.splice(ADAPTERS.indexOf(/** @type {any} */ (adapter)), 1);
    store.clear();
  }
});
