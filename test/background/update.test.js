// @ts-check
// Post-update adapter re-sync selection.
import test from "node:test";
import assert from "node:assert/strict";
import { adaptersToSyncOnUpdate } from "../../extension/src/background/update.js";
import { ADAPTERS } from "../../extension/src/core/registry.js";

test("adaptersToSyncOnUpdate returns every registry adapter with sync + interval", () => {
  const expected = ADAPTERS.filter(
    (a) => typeof a.sync === "function" && a.intervalMinutes > 0
  ).map((a) => a.id);
  assert.deepEqual(
    adaptersToSyncOnUpdate(ADAPTERS).map((a) => a.id),
    expected
  );
});

test("adaptersToSyncOnUpdate skips observe-only, interval-less and nulls", () => {
  const syncable = { id: "a", sync: async () => ({}), intervalMinutes: 60 };
  const observeOnly = { id: "b", intervalMinutes: 60, observe: {} };
  const noInterval = { id: "c", sync: async () => ({}), intervalMinutes: 0 };
  const noSync = { id: "d", intervalMinutes: 30 };
  assert.deepEqual(
    adaptersToSyncOnUpdate([syncable, observeOnly, noInterval, noSync, null]).map(
      (a) => a.id
    ),
    ["a"]
  );
  assert.deepEqual(adaptersToSyncOnUpdate(undefined), []);
});
