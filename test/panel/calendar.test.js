// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import {
  weekModel,
  monthModel,
  weekStartOf,
  heatBucket,
  dayKeyOf,
  shortLabel,
} from "../../extension/src/panel/model/calendar.js";
import { zonedIso } from "../../extension/src/lib/textdates/index.js";

const NOW = new Date("2026-10-05T16:00:00.000Z"); // Mon Oct 5, 12:00 Toronto (EDT)
const WEEK = weekStartOf(NOW); // Mon Oct 5, 2026

const timed = (id, day, h1, m1, h2, m2, over = {}) => ({
  id,
  source: "learn",
  type: "class",
  title: id,
  org: "ECE 105",
  status: "open",
  startAt: zonedIso(2026, 10, day, h1, m1),
  endAt: zonedIso(2026, 10, day, h2, m2),
  ...over,
});

const due = (id, day, weight, over = {}) => ({
  id,
  source: "learn",
  type: "deadline",
  title: id,
  org: "MATH 117",
  status: "open",
  dueAt: zonedIso(2026, 10, day, 23, 59),
  weight,
  ...over,
});

test("weekStartOf lands on a Monday, Toronto time", () => {
  assert.equal(dayKeyOf(WEEK), "2026-10-05");
  // Sunday still belongs to the same week.
  assert.equal(dayKeyOf(weekStartOf("2026-10-11T20:00:00Z")), "2026-10-05");
});

test("heat buckets: 0 / 1-9 / 10-24 / 25+", () => {
  assert.equal(heatBucket(0), 0);
  assert.equal(heatBucket(5), 1);
  assert.equal(heatBucket(9.9), 1);
  assert.equal(heatBucket(10), 2);
  assert.equal(heatBucket(24), 2);
  assert.equal(heatBucket(25), 3);
});

test("overlapping blocks split into two columns; disjoint ones don't", () => {
  const items = {
    a: timed("a", 5, 10, 0, 11, 0),
    b: timed("b", 5, 10, 30, 11, 30),
    c: timed("c", 5, 12, 0, 13, 0),
  };
  const { days } = weekModel(items, {}, {}, WEEK, NOW);
  const mon = days[0].timed;
  const a = mon.find((e) => e.item.id === "a");
  const b = mon.find((e) => e.item.id === "b");
  const c = mon.find((e) => e.item.id === "c");
  assert.equal(a.cols, 2);
  assert.equal(b.cols, 2);
  assert.equal(c.cols, 1);
  assert.notEqual(a.col, b.col);
});

test("hour range extends beyond 8-22 to cover early/late items", () => {
  const items = {
    early: timed("early", 6, 7, 15, 8, 15),
    late: timed("late", 7, 21, 0, 23, 30),
  };
  const { range } = weekModel(items, {}, {}, WEEK, NOW);
  assert.equal(range.startHour, 7);
  assert.equal(range.endHour, 24);
});

test("the due strip collects deadlines and the day's heat sums their weights", () => {
  const items = {
    d1: due("d1", 6, 15),
    d2: due("d2", 6, 12),
    d3: due("d3", 8, 5),
  };
  const { days } = weekModel(items, {}, {}, WEEK, NOW);
  assert.deepEqual(days[1].due.map((d) => d.id), ["d1", "d2"]);
  assert.equal(days[1].heat, 3); // 27 -> 25+
  assert.equal(days[3].heat, 1); // 5 -> 1-9
});

test("showClasses hides classish blocks but keeps exams", () => {
  const items = {
    lec: timed("lec", 5, 10, 0, 11, 0, { type: "class" }),
    exam: timed("exam", 5, 14, 0, 16, 0, { type: "exam" }),
  };
  const all = weekModel(items, {}, {}, WEEK, NOW, { showClasses: true });
  const none = weekModel(items, {}, {}, WEEK, NOW, { showClasses: false });
  assert.equal(all.days[0].timed.length, 2);
  assert.deepEqual(
    none.days[0].timed.map((e) => e.item.id),
    ["exam"]
  );
});

test("fall-back DST week (Nov 1 2026) produces seven real Toronto days", () => {
  // Nov 1 2026 is the Sunday DST ends (02:00 EDT -> 01:00 EST).
  const start = weekStartOf("2026-11-01T12:00:00Z");
  const items = {
    sun: timed("sun", 26, 9, 0, 10, 0, {
      startAt: zonedIso(2026, 11, 1, 9, 0),
      endAt: zonedIso(2026, 11, 1, 10, 0),
    }),
  };
  const { days } = weekModel(items, {}, {}, start, new Date("2026-10-28T16:00:00Z"));
  assert.deepEqual(
    days.map((d) => d.date),
    [
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
    ]
  );
  const sun = days[6].timed.find((e) => e.item.id === "sun");
  assert.equal(sun.startMin, 9 * 60); // wall time, not shifted by the fallback
  assert.equal(sun.endMin, 10 * 60);
});

test("month cells cap at 3 markers and report the overflow", () => {
  const items = {};
  for (let i = 0; i < 5; i++) {
    items[`m${i}`] = due(`m${i}`, 15, 0, { title: `Item ${i}` });
  }
  const { cells } = monthModel(items, {}, {}, new Date("2026-10-10T12:00:00Z"), NOW);
  const cell = cells.find((c) => c.date === "2026-10-15");
  assert.equal(cell.markers.length, 3);
  assert.equal(cell.more, 2);
  // 42 cells, Mon-first: Oct 2026 starts Thursday -> first cell is Mon Sep 28.
  assert.equal(cells.length, 42);
  assert.equal(cells[0].date, "2026-09-28");
  assert.equal(cells[0].inMonth, false);
  assert.equal(cells[3].date, "2026-10-01");
});

test("month: classes are counted, not marked; weights drive cell heat", () => {
  const items = {
    lec: timed("lec", 20, 10, 0, 11, 0),
    tut: timed("tut", 20, 14, 0, 15, 0, { type: "tutorial" }),
    big: due("big", 20, 30),
  };
  const { cells } = monthModel(items, {}, {}, new Date("2026-10-10T12:00:00Z"), NOW);
  const cell = cells.find((c) => c.date === "2026-10-20");
  assert.equal(cell.classCount, 2);
  assert.equal(cell.markers.length, 1);
  assert.equal(cell.heat, 3); // weight 30
});

test("shortLabel splits course orgs and first-words everything else", () => {
  assert.deepEqual(shortLabel({ org: "MATH 117" }), { sub: "MATH", main: "117" });
  assert.deepEqual(shortLabel({ org: "ECE 105" }), { sub: "ECE", main: "105" });
  assert.deepEqual(shortLabel({ org: "CS 136L" }), { sub: "CS", main: "136L" });
  assert.deepEqual(shortLabel({ org: "WaterlooWorks" }), { sub: "", main: "WaterlooWorks" });
  assert.deepEqual(shortLabel({ org: "Co-op Interview" }), { sub: "", main: "Co-op" });
  assert.deepEqual(
    shortLabel({ title: "Plan review" }),
    { sub: "", main: "Plan" },
    "falls back to the title's first word"
  );
});
