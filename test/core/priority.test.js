// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { priorityOf } from "../../extension/src/core/priority.js";

const NOW = new Date("2026-10-01T16:00:00.000Z");

const item = (over = {}) => ({
  id: "x",
  type: "deadline",
  title: "x",
  status: "open",
  confidence: "exact",
  review: "auto",
  ...over,
});

test("high: heavy deadline within 24 h", () => {
  assert.equal(
    priorityOf(item({ dueAt: "2026-10-02T12:00:00Z", weight: 12 }), NOW),
    "high"
  );
  // Under 10% doesn't qualify.
  assert.equal(
    priorityOf(item({ dueAt: "2026-10-02T12:00:00Z", weight: 4 }), NOW),
    "normal"
  );
});

test("high: exam or interview within 3 days", () => {
  assert.equal(priorityOf(item({ type: "exam", startAt: "2026-10-03T14:00:00Z" }), NOW), "high");
  assert.equal(
    priorityOf(item({ type: "interview", startAt: "2026-10-04T14:00:00Z" }), NOW),
    "high"
  );
  assert.equal(
    priorityOf(item({ type: "exam", startAt: "2026-10-10T14:00:00Z" }), NOW),
    "normal"
  );
});

test("high: overdue with weight >= 5", () => {
  assert.equal(
    priorityOf(item({ dueAt: "2026-09-29T23:59:00Z", weight: 8 }), NOW),
    "high"
  );
  assert.equal(
    priorityOf(item({ dueAt: "2026-09-29T23:59:00Z", weight: 2 }), NOW),
    "normal"
  );
});

test("low: tentative, or unweighted non-urgent types", () => {
  assert.equal(priorityOf(item({ confidence: "tentative", dueAt: "2026-10-05T00:00:00Z" }), NOW), "low");
  assert.equal(priorityOf(item({ type: "class", startAt: "2026-10-02T14:00:00Z" }), NOW), "low");
  assert.equal(priorityOf(item({ type: "meeting", startAt: "2026-10-02T14:00:00Z" }), NOW), "low");
});

test("normal: an unweighted deadline ahead", () => {
  assert.equal(priorityOf(item({ dueAt: "2026-10-10T23:59:00Z" }), NOW), "normal");
});

test("done items are never high", () => {
  assert.notEqual(
    priorityOf(item({ status: "done", dueAt: "2026-09-29T23:59:00Z", weight: 10 }), NOW),
    "high"
  );
});
