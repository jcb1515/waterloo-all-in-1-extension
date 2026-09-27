// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { digestText, DIGEST_DAYS } from "../../extension/src/core/remind.js";

const NOW = new Date("2026-10-01T16:00:00.000Z"); // Thu Oct 1, 12:00 EDT
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

const item = (id, over = {}) => ({
  id,
  source: "learn",
  type: "deadline",
  title: id,
  status: "open",
  confidence: "exact",
  review: "auto",
  ...over,
});

test("digestText counts dues, heavy items, exams and interviews", () => {
  const items = {
    a: item("a", { dueAt: iso(NOW.getTime() + DAY) }),
    b: item("b", { dueAt: iso(NOW.getTime() + DAY), weight: 15 }),
    c: item("c", { type: "quiz", dueAt: iso(NOW.getTime() + 2 * DAY), weight: 25 }),
    d: item("d", { type: "exam", startAt: iso(NOW.getTime() + 3 * DAY), endAt: iso(NOW.getTime() + 3 * DAY + H) }),
    e: item("e", { type: "interview", startAt: iso(NOW.getTime() + 4 * DAY) }),
    f: item("f", { type: "interview", startAt: iso(NOW.getTime() + 4 * DAY) }),
    g: item("g", { type: "class", startAt: iso(NOW.getTime() + DAY) }), // not counted
    past: item("past", { dueAt: iso(NOW.getTime() - DAY) }), // not counted
    far: item("far", { dueAt: iso(NOW.getTime() + 8 * DAY) }), // beyond the week
    done: item("done", { dueAt: iso(NOW.getTime() + DAY), status: "done" }),
  };
  const text = digestText(items, {}, NOW, {});
  // Fri gets a+b (2), Sat c (1), Sun d (1), Mon e+f (2). Fri vs Mon tie -> first wins.
  assert.equal(text, "This week: 3 due (2 worth ≥10%), 1 exam, 2 interviews · busiest: Fri");
});

test("digestText returns null on an empty week", () => {
  assert.equal(digestText({}, {}, NOW, {}), null);
  const items = { a: item("a", { dueAt: iso(NOW.getTime() + 9 * DAY) }) };
  assert.equal(digestText(items, {}, NOW, {}), null);
});

test("digestText omits zero segments and busiest when only one kind", () => {
  const items = { a: item("a", { dueAt: iso(NOW.getTime() + DAY) }) };
  assert.equal(digestText(items, {}, NOW, {}), "This week: 1 due · busiest: Fri");
});

test("hidden/snoozed/done items are excluded", () => {
  const items = { a: item("a", { dueAt: iso(NOW.getTime() + DAY) }) };
  assert.equal(
    digestText(items, { a: { hidden: true } }, NOW, {}),
    null,
  );
});

test("DIGEST_DAYS maps the day codes", () => {
  assert.equal(DIGEST_DAYS.sun, 0);
  assert.equal(DIGEST_DAYS.sat, 6);
});

const H = 3600000;
