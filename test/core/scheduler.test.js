// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { nextBackoff, shouldRun } from "../../extension/src/core/scheduler.js";

const MIN = 60000;
const NOW = Date.parse("2025-09-15T16:00:00.000Z");

test("nextBackoff doubles from 5 minutes and caps at 6 hours", () => {
  assert.equal(nextBackoff(1), 5 * MIN);
  assert.equal(nextBackoff(2), 10 * MIN);
  assert.equal(nextBackoff(3), 20 * MIN);
  assert.equal(nextBackoff(4), 40 * MIN);
  assert.equal(nextBackoff(8), 6 * 3600000, "640m would exceed the 6h cap");
  assert.equal(nextBackoff(20), 6 * 3600000);
  assert.equal(nextBackoff(0), 5 * MIN, "zero/undefined treated as first failure");
});

test("shouldRun: manual overrides everything", () => {
  const future = new Date(NOW + 3600000).toISOString();
  assert.equal(shouldRun({ backoffUntil: future }, NOW, "manual", 30), true);
  assert.equal(shouldRun(null, NOW, "manual", 30), true);
});

test("shouldRun: backoff blocks non-manual runs until it expires", () => {
  const st = { backoffUntil: new Date(NOW + 60000).toISOString(), lastRunAt: new Date(0).toISOString() };
  assert.equal(shouldRun(st, NOW, "alarm", 30), false);
  assert.equal(shouldRun(st, NOW, "tab", 30), false);
  const past = { backoffUntil: new Date(NOW - 1).toISOString(), lastRunAt: new Date(0).toISOString() };
  assert.equal(shouldRun(past, NOW, "alarm", 30), true);
});

test("shouldRun: tab runs at most every 2 minutes", () => {
  assert.equal(shouldRun({ lastRunAt: new Date(NOW - 30000).toISOString() }, NOW, "tab", 30), false);
  assert.equal(shouldRun({ lastRunAt: new Date(NOW - 3 * MIN).toISOString() }, NOW, "tab", 30), true);
  assert.equal(shouldRun(null, NOW, "tab", 30), true, "never ran -> run");
});

test("shouldRun: alarm/startup follow the adapter interval", () => {
  const recent = { lastRunAt: new Date(NOW - 10 * MIN).toISOString() };
  assert.equal(shouldRun(recent, NOW, "alarm", 30), false);
  assert.equal(shouldRun(recent, NOW, "startup", 30), false);
  const old = { lastRunAt: new Date(NOW - 31 * MIN).toISOString() };
  assert.equal(shouldRun(old, NOW, "alarm", 30), true);
  assert.equal(shouldRun(null, NOW, "alarm", 30), true, "never ran -> run");
});
