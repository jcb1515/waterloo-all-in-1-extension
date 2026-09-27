// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { effectiveItem, isVisible } from "../../extension/src/core/effective.js";

const NOW = new Date("2026-10-01T16:00:00.000Z");

const item = (over = {}) => ({
  id: "learn:x",
  source: "learn",
  type: "deadline",
  title: "Quiz #3",
  status: "open",
  confidence: "exact",
  review: "auto",
  dueAt: "2026-10-14T20:00:00Z",
  ...over,
});

test("effectiveItem returns a copy; the stored item is untouched", () => {
  const it = item();
  const eff = effectiveItem(it, { done: true });
  assert.equal(eff.status, "done");
  assert.equal(it.status, "open");
  assert.notEqual(eff, it);
});

test("userState.review overrides the item's review", () => {
  assert.equal(effectiveItem(item({ review: "pending" }), { review: "accepted" }).review, "accepted");
  assert.equal(effectiveItem(item({ review: "auto" }), { review: "dismissed" }).review, "dismissed");
  // A cleared verdict falls back to the item's own review.
  assert.equal(effectiveItem(item({ review: "pending" }), { review: null }).review, "pending");
});

test("userState.done forces status done", () => {
  assert.equal(effectiveItem(item(), { done: true }).status, "done");
});

test("userState.override replaces the listed fields only", () => {
  const eff = effectiveItem(item(), {
    override: {
      title: "Quiz #3 (rescheduled)",
      type: "quiz",
      dueAt: "2026-10-20T20:00:00Z",
      location: "nope", // not an overridable field
    },
  });
  assert.equal(eff.title, "Quiz #3 (rescheduled)");
  assert.equal(eff.type, "quiz");
  assert.equal(eff.dueAt, "2026-10-20T20:00:00Z");
  assert.equal(eff.location, undefined);
});

test("acceptPending treats pending as accepted; dismissed still hides", () => {
  const pending = item({ review: "pending" });
  assert.equal(effectiveItem(pending, {}, { acceptPending: true }).review, "accepted");
  assert.equal(effectiveItem(pending, { review: "dismissed" }, { acceptPending: true }).review, "dismissed");
});

test("isVisible: pending, dismissed, hidden and snoozed are out", () => {
  assert.equal(isVisible(effectiveItem(item(), {}), NOW), true);
  assert.equal(isVisible(effectiveItem(item({ review: "pending" }), {}), NOW), false);
  assert.equal(isVisible(effectiveItem(item(), { review: "dismissed" }), NOW), false);
  assert.equal(isVisible(effectiveItem(item(), { hidden: true }), NOW), false);
  const snoozed = effectiveItem(item(), { snoozedUntil: "2026-10-02T00:00:00Z" });
  assert.equal(isVisible(snoozed, NOW), false);
  // Snooze in the past no longer hides.
  const woken = effectiveItem(item(), { snoozedUntil: "2026-09-30T00:00:00Z" });
  assert.equal(isVisible(woken, NOW), true);
});

test("an edited pending item publishes at the edited time once accepted", () => {
  const it = item({ review: "pending", dueAt: "2026-10-14T20:00:00Z" });
  const eff = effectiveItem(it, {
    review: "accepted",
    override: { dueAt: "2026-10-21T20:00:00Z" },
  });
  assert.equal(eff.dueAt, "2026-10-21T20:00:00Z");
  assert.equal(isVisible(eff, NOW), true);
});
