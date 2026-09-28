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

test("all-day windows never overlap timed items (cycle-dates, term-dates)", () => {
  // A multi-day all-day cycle window spanning a week of classes.
  const items = {
    cycle: item("cycle", {
      type: "cycle-date",
      title: "Cycle 1: Interviews",
      startAt: "2026-10-05T04:00:00Z",
      endAt: "2026-10-10T04:00:00Z",
      allDay: true,
    }),
    c1: timed("c1", "2026-10-06T13:00:00Z", "2026-10-06T14:20:00Z"),
    c2: timed("c2", "2026-10-07T15:00:00Z", "2026-10-07T16:20:00Z", { type: "tutorial" }),
    c3: timed("c3", "2026-10-08T09:00:00Z", "2026-10-08T10:20:00Z", { type: "lab" }),
  };
  assert.equal(findClashes(items, {}, NOW).filter((c) => c.kind === "overlap").length, 0);
});

test("cycle-date/term-date stay out of timed overlaps even with a time", () => {
  const items = {
    cycle: item("cycle", {
      type: "cycle-date",
      startAt: "2026-10-06T13:30:00Z",
      endAt: "2026-10-06T15:00:00Z",
    }),
    term: item("term", {
      type: "term-date",
      startAt: "2026-10-06T14:00:00Z",
      endAt: "2026-10-06T16:00:00Z",
    }),
    cls: timed("cls", "2026-10-06T14:00:00Z", "2026-10-06T15:20:00Z"),
  };
  assert.equal(findClashes(items, {}, NOW).filter((c) => c.kind === "overlap").length, 0);
});

test("two all-day term-dates on the same day do not overlap", () => {
  const items = {
    t1: item("t1", { type: "term-date", title: "Classes begin", startAt: "2026-10-06", allDay: true }),
    t2: item("t2", { type: "term-date", title: "Fees due", startAt: "2026-10-06", allDay: true }),
  };
  assert.equal(findClashes(items, {}, NOW).filter((c) => c.kind === "overlap").length, 0);
});

test("a timed interview during a class is one severe overlap", () => {
  const items = {
    iv: timed("iv", "2026-10-06T14:00:00Z", "2026-10-06T14:30:00Z", { type: "interview" }),
    cls: timed("cls", "2026-10-06T13:30:00Z", "2026-10-06T14:20:00Z"),
  };
  const overlaps = findClashes(items, {}, NOW).filter((c) => c.kind === "overlap");
  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0].severity, "severe");
  assert.deepEqual([...overlaps[0].itemIds].sort(), ["cls", "iv"]);
});

test("overlaps beyond the horizon are ignored", () => {
  const items = {
    a: timed("a", "2026-11-01T14:00:00Z", "2026-11-01T15:00:00Z"),
    b: timed("b", "2026-11-01T14:30:00Z", "2026-11-01T15:30:00Z"),
  };
  assert.equal(findClashes(items, {}, NOW, { horizonDays: 14 }).length, 0);
});
