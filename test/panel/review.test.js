// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { pendingReviewItems } from "../../extension/src/panel/model/review.js";

const NOW = new Date("2026-10-01T16:00:00.000Z");

const item = (id, over = {}) => ({
  id,
  source: "learn",
  type: "deadline",
  title: id,
  status: "open",
  review: "pending",
  ...over,
});

test("only pending items without a verdict are queued", () => {
  const items = {
    a: item("a", { dueAt: "2026-10-05T00:00:00Z" }),
    autoItem: item("autoItem", { review: "auto", dueAt: "2026-10-05T00:00:00Z" }),
    accepted: item("accepted", { dueAt: "2026-10-05T00:00:00Z" }),
    dismissed: item("dismissed", { dueAt: "2026-10-05T00:00:00Z" }),
  };
  const us = {
    accepted: { review: "accepted" },
    dismissed: { review: "dismissed" },
  };
  const { upcoming, past } = pendingReviewItems(items, us, NOW);
  assert.deepEqual(upcoming.map((i) => i.id), ["a"]);
  assert.equal(past.length, 0);
});

test("sorted by anchor; past-dated items split into the collapsed group", () => {
  const items = {
    later: item("later", { dueAt: "2026-10-08T00:00:00Z" }),
    sooner: item("sooner", { dueAt: "2026-10-03T00:00:00Z" }),
    old: item("old", { dueAt: "2026-09-28T00:00:00Z" }),
    undated: item("undated"),
  };
  const { upcoming, past } = pendingReviewItems(items, {}, NOW);
  assert.deepEqual(upcoming.map((i) => i.id), ["sooner", "later", "undated"]);
  assert.deepEqual(past.map((i) => i.id), ["old"]);
});
