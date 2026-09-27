// @ts-check
// Race coverage: a slow adapter sync() that resolves after an observe landed
// must not write back stale state or items. doSync folds inside the same
// per-source ingest queue as observes, and re-runs sync once when the
// sourceState version moved underneath it.

import test from "node:test";
import assert from "node:assert/strict";

// Minimal chrome.storage stub — the scheduler's store helpers go through it.
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
});

const { runSync, handleObserved } = await import(
  "../../extension/src/core/scheduler.js"
);
const { ADAPTERS } = await import("../../extension/src/core/registry.js");

// "manual" is a declared source id with no shipped adapter — a stub adapter is
// pushed onto the registry per test and removed afterwards.
const SOURCE = "manual";
const rawKey = `raw:${SOURCE}`;
const seen = async () => (await chrome.storage.local.get("sourceState")).sourceState;

test("a sync that resolves after an observe keeps the observe's state and items", async () => {
  let calls = 0;
  /** @type {any[]} */
  const syncStates = [];
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((r) => {
    release = /** @type {any} */ (r);
  });

  const adapter = {
    id: SOURCE,
    intervalMinutes: 0,
    async sync(/** @type {any} */ ctx) {
      calls++;
      syncStates.push(ctx.state);
      if (calls === 1) await gate; // held until the observe has landed
      // Mimic a real adapter folding its private cache: items previously
      // observed into state ride along with the sync items.
      const cached = (ctx.state && ctx.state.cached) || [];
      return {
        items: [
          ...cached,
          { id: "m:sync-1", type: "event", title: "Synced", org: "M", source: SOURCE, startAt: "2026-10-02T13:00:00.000Z" },
        ],
        complete: true,
        session: "signed-in",
        state: { from: `sync${calls}`, cached },
      };
    },
    observe: {
      async parse() {
        return {
          items: [{ id: "m:obs-1", type: "deadline", title: "Observed", org: "M", source: SOURCE, dueAt: "2026-10-03T23:59:00.000Z" }],
          scope: "m",
          complete: true,
          session: "signed-in",
          state: { from: "obs", cached: [{ id: "m:obs-1", type: "deadline", title: "Observed", org: "M", source: SOURCE, dueAt: "2026-10-03T23:59:00.000Z" }] },
        };
      },
    },
  };
  ADAPTERS.push(/** @type {any} */ (adapter));
  try {
    const syncP = runSync(SOURCE, "manual");
    while (!calls) await new Promise((r) => setTimeout(r, 0));

    // Observe lands while sync() is still in flight.
    await handleObserved({ source: SOURCE, url: "https://x/", status: 200 });
    release();
    await syncP;

    assert.equal(calls, 2, "sync re-ran once on the fresh state");
    assert.deepEqual(syncStates[1] && syncStates[1].from, "obs");

    const raw = (await chrome.storage.local.get(rawKey))[rawKey];
    const ids = raw.items.map((/** @type {any} */ i) => i.id).sort();
    assert.deepEqual(ids, ["m:obs-1", "m:sync-1"]);

    const st = (await seen())[SOURCE];
    assert.equal(st.state.from, "sync2", "folded the re-run result, not the stale one");
    assert.equal(st.error, null);
  } finally {
    ADAPTERS.splice(ADAPTERS.indexOf(/** @type {any} */ (adapter)), 1);
    store.clear();
  }
});

test("a sync with no intervening observe folds once, in the ingest queue", async () => {
  let calls = 0;
  const adapter = {
    id: SOURCE,
    intervalMinutes: 0,
    async sync(/** @type {any} */ ctx) {
      calls++;
      assert.deepEqual(ctx.state, {});
      return {
        items: [{ id: "m:sync-1", type: "event", title: "Synced", org: "M", source: SOURCE, startAt: "2026-10-02T13:00:00.000Z" }],
        complete: true,
        session: "signed-in",
        state: { from: "sync1" },
      };
    },
  };
  ADAPTERS.push(/** @type {any} */ (adapter));
  try {
    const res = await runSync(SOURCE, "manual");
    assert.equal(calls, 1, "no stale state — no re-run");
    assert.deepEqual(res, { ok: true });
    const raw = (await chrome.storage.local.get(rawKey))[rawKey];
    assert.deepEqual(raw.items.map((/** @type {any} */ i) => i.id), ["m:sync-1"]);
    const st = (await seen())[SOURCE];
    assert.equal(st.state.from, "sync1");
  } finally {
    ADAPTERS.splice(ADAPTERS.indexOf(/** @type {any} */ (adapter)), 1);
    store.clear();
  }
});
