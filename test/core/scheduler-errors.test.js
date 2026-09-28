// @ts-check
// No silent failures: a storage read throwing inside handleObserved (before
// parse is ever reached) must still leave a log line and an error readStat —
// the reads inside failObserve are themselves best-effort so a dead store
// can't rethrow. Same for the capture path.

import test from "node:test";
import assert from "node:assert/strict";

const store = new Map();
/** Throw once on the next array-keys get (getMergedView's shape), then heal. */
let throwOnce = false;
globalThis.chrome = /** @type {any} */ ({
  storage: {
    local: {
      get: async (keys) => {
        if (throwOnce && Array.isArray(keys)) {
          throwOnce = false;
          throw new Error("storage read dead");
        }
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

const { handleObserved, handleCapture } = await import(
  "../../extension/src/core/scheduler.js"
);
const { ADAPTERS } = await import("../../extension/src/core/registry.js");

const SOURCE = "manual";

const adapter = {
  id: SOURCE,
  intervalMinutes: 0,
  observe: {
    async parse() {
      throw new Error("unreachable — the storage read failed first");
    },
  },
};

test("a storage failure inside handleObserved is logged and stat-recorded", async () => {
  ADAPTERS.push(/** @type {any} */ (adapter));
  try {
    throwOnce = true;
    await handleObserved({ source: SOURCE, url: "https://x/", status: 200 });

    const logs =
      (await chrome.storage.local.get(`log:${SOURCE}`))[`log:${SOURCE}`] || [];
    assert.ok(
      logs.some((/** @type {any} */ l) => /observe failed: storage read dead/.test(l.message)),
      "log line recorded the failure",
    );

    const stats = ((await chrome.storage.local.get("readStats")).readStats) || [];
    const errStat = stats.find((s) => s.kind === "observe" && s.error);
    assert.ok(errStat, "an error readStat was recorded");
    assert.match(errStat.error, /storage read dead/);
  } finally {
    ADAPTERS.splice(ADAPTERS.indexOf(/** @type {any} */ (adapter)), 1);
    store.clear();
  }
});

test("a storage failure inside handleCapture is logged as a capture error", async () => {
  try {
    throwOnce = true;
    await handleCapture({
      source: SOURCE,
      scope: "m",
      items: [{ id: "m:1", type: "event", title: "x", source: SOURCE }],
    });

    const logs =
      (await chrome.storage.local.get(`log:${SOURCE}`))[`log:${SOURCE}`] || [];
    assert.ok(
      logs.some((/** @type {any} */ l) => /capture failed: storage read dead/.test(l.message)),
      "capture failure was logged",
    );
    const stats = ((await chrome.storage.local.get("readStats")).readStats) || [];
    assert.ok(
      stats.some((s) => s.kind === "capture" && /storage read dead/.test(s.error)),
      "a capture error readStat was recorded",
    );
  } finally {
    store.clear();
  }
});
