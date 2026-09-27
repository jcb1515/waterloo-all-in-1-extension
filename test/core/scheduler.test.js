// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { nextBackoff, nextSourceState, shouldRun } from "../../extension/src/core/scheduler.js";

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

/* ------------------------- nextSourceState ------------------------- */

test("observe: signed-out then a good read -> signed-in with a fresh lastOkAt", () => {
  const bad = nextSourceState(
    {},
    { items: [], complete: false, scope: "waterlooworks", session: "signed-out", state: { a: 1 } },
    new Date(NOW),
    "observe",
    0
  );
  assert.equal(bad.session, "signed-out");
  assert.equal(bad.lastOkAt, undefined, "no successful read yet");
  assert.deepEqual(bad.state, { a: 1 });

  const good = nextSourceState(
    bad,
    { items: [{ id: "w1" }], complete: true, scope: "waterlooworks", readOk: ["waterlooworks"], state: { a: 2 } },
    new Date(NOW + 60000),
    "observe",
    1
  );
  assert.equal(good.session, "signed-in");
  assert.equal(good.lastOkAt, new Date(NOW + 60000).toISOString());
  assert.equal(good.complete, true);
  assert.equal(good.error, null);
  assert.equal(good.itemCount, 1);
  assert.deepEqual(good.state, { a: 2 });
});

test("observe: an incomplete DOM snapshot with no readOk changes nothing but state", () => {
  const prev = {
    state: { x: 1 },
    lastOkAt: new Date(NOW - 60000).toISOString(),
    session: "signed-in",
    complete: true,
    error: null,
    itemCount: 5,
  };
  const next = nextSourceState(
    prev,
    { items: [{ id: "w1" }], complete: false, scope: "waterlooworks", state: { x: 2 } },
    new Date(NOW),
    "observe",
    6
  );
  assert.equal(next.lastOkAt, prev.lastOkAt);
  assert.equal(next.session, "signed-in");
  assert.equal(next.complete, true);
  assert.equal(next.itemCount, 5);
  assert.deepEqual(next.state, { x: 2 }, "private state still moves forward");
});

test("sync: a no-tab result keeps the previous lastOkAt and complete", () => {
  const prev = {
    lastOkAt: new Date(NOW - 3600000).toISOString(),
    session: "signed-in",
    complete: true,
    failures: 0,
    itemCount: 3,
  };
  const next = nextSourceState(
    prev,
    { items: [], complete: false, session: "no-tab", state: {} },
    new Date(NOW),
    "sync",
    3
  );
  assert.equal(next.session, "no-tab");
  assert.equal(next.lastRunAt, new Date(NOW).toISOString());
  assert.equal(next.lastOkAt, prev.lastOkAt, "no read happened");
  assert.equal(next.complete, true, "kept");
});

test("sync: signed-out keeps lastOkAt/complete; a clean read refreshes both", () => {
  const prev = { lastOkAt: new Date(NOW - 3600000).toISOString(), complete: true, itemCount: 4 };
  const out = nextSourceState(
    prev,
    { items: [], complete: false, session: "signed-out", error: { code: "signed-out", message: "x" } },
    new Date(NOW),
    "sync",
    4
  );
  assert.equal(out.session, "signed-out");
  assert.equal(out.lastOkAt, prev.lastOkAt);
  assert.equal(out.complete, true);
  assert.equal(out.failures, 1);
  assert.ok(out.backoffUntil);

  const good = nextSourceState(
    out,
    { items: [{ id: "a" }], complete: true, session: "signed-in" },
    new Date(NOW + 60000),
    "sync",
    5
  );
  assert.equal(good.session, "signed-in");
  assert.equal(good.lastOkAt, new Date(NOW + 60000).toISOString());
  assert.equal(good.complete, true);
  assert.equal(good.failures, 0);
  assert.equal(good.backoffUntil, null);
});
