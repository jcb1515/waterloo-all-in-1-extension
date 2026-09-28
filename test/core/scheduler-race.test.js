// @ts-check
// Race coverage: the whole of doSync — state read, adapter call, fold, and
// status writes — runs inside the source's ingest queue, so an observe for
// the same source queues behind an in-flight sync and a slow sync can never
// overwrite a newer observe.

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

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

test("an observe fired during a sync parses only after the sync's fold", async () => {
  /** @type {string[]} */
  const order = [];
  /** @type {any[]} */
  const parseStates = [];
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((r) => {
    release = /** @type {any} */ (r);
  });

  const adapter = {
    id: SOURCE,
    intervalMinutes: 0,
    async sync(/** @type {any} */ ctx) {
      order.push("sync-call");
      await gate; // held until the observe is already queued behind us
      order.push("sync-return");
      return {
        items: [
          { id: "m:sync-1", type: "event", title: "Synced", org: "M", source: SOURCE, startAt: "2026-10-02T13:00:00.000Z" },
        ],
        complete: true,
        session: "signed-in",
        state: { from: "sync1" },
      };
    },
    observe: {
      async parse(/** @type {any} */ payload, /** @type {any} */ ctx) {
        order.push("observe-parse");
        parseStates.push(ctx.state);
        return {
          items: [{ id: "m:obs-1", type: "deadline", title: "Observed", org: "M", source: SOURCE, dueAt: "2026-10-03T23:59:00.000Z" }],
          scope: "m",
          complete: true,
          session: "signed-in",
          state: { from: "obs" },
        };
      },
    },
  };
  ADAPTERS.push(/** @type {any} */ (adapter));
  try {
    const syncP = runSync(SOURCE, "manual");
    while (!order.includes("sync-call")) await sleep(0);

    // The observe queues behind the whole sync — it must not parse while
    // the adapter call is still held.
    const obsP = handleObserved({ source: SOURCE, url: "https://x/", status: 200 });
    await sleep(30);
    assert.deepEqual(order, ["sync-call"], "observe did not interleave mid-sync");

    release();
    await Promise.all([syncP, obsP]);
    assert.deepEqual(order, ["sync-call", "sync-return", "observe-parse"]);

    // The parse ran against the state the sync had just written.
    assert.equal(parseStates[0] && parseStates[0].from, "sync1");

    const raw = (await chrome.storage.local.get(rawKey))[rawKey];
    const ids = raw.items.map((/** @type {any} */ i) => i.id).sort();
    assert.deepEqual(ids, ["m:obs-1", "m:sync-1"]);

    // The observe's write is the later one, so it wins the stored state.
    const st = (await seen())[SOURCE];
    assert.equal(st.state.from, "obs");
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

test("the sync context carries the slim applications view", async () => {
  /** @type {any} */
  let seenCtx = null;
  const adapter = {
    id: SOURCE,
    intervalMinutes: 0,
    async sync(/** @type {any} */ ctx) {
      seenCtx = ctx;
      return { items: [], complete: true, session: "signed-in" };
    },
  };
  // Applications live in the merged view, so seed the stored map directly.
  store.set("applications", {
    "waterlooworks:1": {
      id: "waterlooworks:1",
      employer: "Acme Analog",
      jobTitle: "Hardware Engineer",
      jobId: "1",
      status: "offer",
      privateNote: "adapters must not see this",
    },
  });
  ADAPTERS.push(/** @type {any} */ (adapter));
  try {
    await runSync(SOURCE, "manual");
    assert.ok(Array.isArray(seenCtx.applications), "ctx.applications is an array");
    assert.equal(seenCtx.applications.length, 1);
    assert.deepEqual(
      Object.keys(seenCtx.applications[0]).sort(),
      ["employer", "id", "jobId", "jobTitle", "status"],
      "slim record only — no private fields"
    );
  } finally {
    ADAPTERS.splice(ADAPTERS.indexOf(/** @type {any} */ (adapter)), 1);
    store.clear();
  }
});
