// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseWeekLabel, termYear, termSeason, termCodeFor, inferYear, zonedIso, zonedParts, weekdayOf,
} from "../../extension/src/lib/textdates/index.js";

const O = { now: new Date("2026-09-26T16:00:00Z"), termCode: 1269 };

test("parseWeekLabel reads the outline week-table formats (inclusive YYYY-MM-DD dates)", () => {
  // MATH 117
  assert.deepEqual(parseWeekLabel("Week 5: October 5 - 9", O), { n: 5, start: "2026-10-05", end: "2026-10-09" });
  assert.deepEqual(parseWeekLabel("Week 4: September 28 - October 2", O), { n: 4, start: "2026-09-28", end: "2026-10-02" });
  // ECE 190
  assert.deepEqual(parseWeekLabel("Week 5(Oct 5-11)", O), { n: 5, start: "2026-10-05", end: "2026-10-11" });
  assert.deepEqual(parseWeekLabel("Week 8(Oct 26 - Nov 1)", O), { n: 8, start: "2026-10-26", end: "2026-11-01" });
  assert.deepEqual(parseWeekLabel("Week 1 (Sep 9-13)", O), { n: 1, start: "2026-09-09", end: "2026-09-13" });
  // GENE 119: a number only
  assert.deepEqual(parseWeekLabel("Week 3", O), { n: 3, start: null, end: null });
});

test("parseWeekLabel rejects things that are not a week label", () => {
  assert.equal(parseWeekLabel("Week 3-4.5", O), null); // ECE 105 spans half weeks
  assert.equal(parseWeekLabel("Week (2026)", O), null);
  assert.equal(parseWeekLabel("Chapter 3 Matrices", O), null);
  assert.equal(parseWeekLabel("", O), null);
});

test("term codes", () => {
  assert.equal(termYear(1269), 2026);
  assert.equal(termYear(1271), 2027);
  assert.equal(termSeason(1269), "fall");
  assert.equal(termSeason(1271), "winter");
  assert.equal(termSeason(1275), "spring");
  assert.equal(termCodeFor(new Date("2026-09-26T16:00:00Z")), 1269);
  assert.equal(termCodeFor(new Date("2027-02-01T17:00:00Z")), 1271);
  assert.equal(termCodeFor(new Date("2027-06-01T16:00:00Z")), 1275);
});

test("inferYear picks the year closest to the term midpoint, or to now", () => {
  assert.equal(inferYear(10, 5, { now: O.now, termCode: 1269 }), 2026);
  assert.equal(inferYear(12, 18, { now: O.now, termCode: 1271 }), 2026);
  assert.equal(inferYear(1, 15, { now: O.now, termCode: 1271 }), 2027);
  assert.equal(inferYear(1, 15, { now: O.now }), 2027);
});

test("zonedIso converts Toronto wall time to a UTC instant", () => {
  assert.equal(zonedIso(2026, 10, 22, 16, 30), "2026-10-22T20:30:00.000Z");
  assert.equal(zonedIso(2026, 12, 10), "2026-12-10T05:00:00.000Z");
  // Ambiguous hour on Nov 1 2026: the earlier (EDT) instant.
  assert.equal(zonedIso(2026, 11, 1, 1, 30), "2026-11-01T05:30:00.000Z");
  // Nonexistent 02:30 on Mar 14 2027: moved forward by the gap to 03:30 EDT.
  assert.equal(zonedIso(2027, 3, 14, 2, 30), "2027-03-14T07:30:00.000Z");
  assert.equal(zonedIso(2026, 7, 1, 9, 0, "America/Vancouver"), "2026-07-01T16:00:00.000Z");
});

test("zonedParts and weekdayOf", () => {
  assert.deepEqual(zonedParts(new Date("2026-09-21T03:30:00Z")), { y: 2026, m: 9, d: 20, h: 23, mi: 30, weekday: 0 });
  assert.equal(weekdayOf(2026, 10, 27), 2); // Tuesday
  assert.equal(weekdayOf(2026, 10, 22), 4); // Thursday
});
