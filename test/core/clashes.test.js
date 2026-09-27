// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { findClashes } from "../../extension/src/core/clashes.js";

const NOW = new Date("2026-10-01T16:00:00.000Z"); // Thursday

const item = (id, over = {}) => ({
  id,
  source: "learn",
  type: "class",
  title: id,
  status: "open",
  confidence: "exact",
  review: "auto",
  ...over,
});

const timed = (id, startIso, endIso, over = {}) =>
  item(id, { type: "class", startAt: startIso, endAt: endIso, ...over });

test("overlapping timed items clash; touching endpoints do not", () => {
  const items = {
    a: timed("a", "2026-10-02T14:00:00Z", "2026-10-02T15:00:00Z"),
    b: timed("b", "2026-10-02T14:30:00Z", "2026-10-02T15:30:00Z"),
    c: timed("c", "2026-10-02T15:30:00Z", "2026-10-02T16:30:00Z"), // starts as b ends
  };
  const clashes = findClashes(items, {}, NOW);
  assert.equal(clashes.length, 1);
  assert.equal(clashes[0].kind, "overlap");
  assert.deepEqual([...clashes[0].itemIds].sort(), ["a", "b"]);
  assert.equal(clashes[0].severity, "warn");
});

test("a timed item with no endAt lasts 60 minutes", () => {
  const items = {
    a: timed("a", "2026-10-02T14:00:00Z", null, { endAt: undefined }),
    b: timed("b", "2026-10-02T14:30:00Z", "2026-10-02T15:30:00Z"),
  };
  const clashes = findClashes(items, {}, NOW);
  assert.equal(clashes.length, 1);
});

test("an exam or interview overlap is severe", () => {
  const items = {
    exam: timed("exam", "2026-10-02T14:00:00Z", "2026-10-02T16:00:00Z", { type: "exam" }),
    meet: timed("meet", "2026-10-02T15:00:00Z", "2026-10-02T16:00:00Z", { type: "meeting" }),
  };
  const [c] = findClashes(items, {}, NOW);
  assert.equal(c.severity, "severe");
});

test("three weighted deliverables in 24 h make a crunch; spread out do not", () => {
  const del = (id, dueAt, weight = 10) =>
    item(id, { type: "deadline", dueAt, weight });
  const crunch = findClashes(
    {
      a: del("a", "2026-10-03T03:59:00Z"),
      b: del("b", "2026-10-03T20:00:00Z"),
      c: del("c", "2026-10-04T03:00:00Z"),
    },
    {},
    NOW
  );
  assert.equal(crunch.length, 1);
  assert.equal(crunch[0].kind, "crunch");
  assert.equal(crunch[0].itemIds.length, 3);

  const spread = findClashes(
    {
      a: del("a", "2026-10-03T03:59:00Z"),
      b: del("b", "2026-10-05T03:59:00Z"),
      c: del("c", "2026-10-07T03:59:00Z"),
    },
    {},
    NOW
  );
  assert.equal(spread.filter((c) => c.kind === "crunch").length, 0);
});

test("unweighted, done, hidden and review-pending items never count", () => {
  const items = {
    a: item("a", { type: "deadline", dueAt: "2026-10-03T03:59:00Z", weight: 10 }),
    b: item("b", { type: "deadline", dueAt: "2026-10-03T05:00:00Z", weight: 10 }),
    light: item("light", { type: "deadline", dueAt: "2026-10-03T06:00:00Z", weight: 2 }),
    done: item("done", { type: "deadline", dueAt: "2026-10-03T07:00:00Z", weight: 10, status: "done" }),
    pending: item("pending", { type: "deadline", dueAt: "2026-10-03T08:00:00Z", weight: 10, review: "pending" }),
    hidden: item("hidden", { type: "deadline", dueAt: "2026-10-03T09:00:00Z", weight: 10 }),
  };
  const clashes = findClashes(items, { hidden: { hidden: true } }, NOW);
  assert.equal(clashes.length, 0, "only 2 eligible items remain");
});

test("overlaps beyond the horizon are ignored", () => {
  const items = {
    a: timed("a", "2026-11-01T14:00:00Z", "2026-11-01T15:00:00Z"),
    b: timed("b", "2026-11-01T14:30:00Z", "2026-11-01T15:30:00Z"),
  };
  assert.equal(findClashes(items, {}, NOW, { horizonDays: 14 }).length, 0);
});
