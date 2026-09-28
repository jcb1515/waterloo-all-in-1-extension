// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { dateBlockFor, dateBlockText, fmtCompactDay, KEY_TYPES } from "../../extension/src/ui/dateLabel.js";

const timed = { id: "i1", type: "meeting", title: "Sync", startAt: "2026-10-08T23:00:00.000Z", source: "portal" };
// 2026-10-08 23:00 UTC = 19:00 EDT (Toronto) on Thu Oct 8.
const allDay = { id: "i2", type: "term-date", title: "Reading week", startAt: "2026-10-13", allDay: true, source: "portal" };
const exam = {
  id: "i3",
  type: "exam",
  title: "Midterm",
  startAt: "2026-10-08T23:00:00.000Z",
  location: "MC 2034",
  source: "portal",
};

test("compact day is weekday + short date", () => {
  assert.equal(fmtCompactDay("2026-10-08T23:00:00.000Z"), "Thu Oct 8");
});

test("timed item renders date and time together", () => {
  const b = dateBlockFor(timed);
  assert.equal(b?.date, "Thu Oct 8");
  assert.equal(b?.time, "7:00 pm");
  assert.equal(dateBlockText(b), "Thu Oct 8 · 7:00 pm");
});

test("all-day item renders the date only", () => {
  const b = dateBlockFor(allDay);
  assert.equal(b?.date, "Tue Oct 13");
  assert.equal(b?.time, null);
  assert.equal(dateBlockText(b), "Tue Oct 13");
});

test("dueAt-only items anchor on the due time", () => {
  const b = dateBlockFor({ id: "i4", type: "task", title: "x", dueAt: "2026-10-09T03:59:00.000Z" });
  assert.ok(b);
  assert.match(dateBlockText(b), /^Thu Oct 8 · \d{1,2}:\d{2} [ap]m$/);
});

test("exam/interview/deadline get the key block with the room", () => {
  for (const type of ["exam", "interview", "deadline"]) {
    const b = dateBlockFor({ ...exam, type });
    assert.equal(b?.key, true, type);
    assert.equal(b?.room, "MC 2034");
    assert.equal(dateBlockText(b), "Thu Oct 8 · 7:00 pm · MC 2034");
  }
  assert.equal(KEY_TYPES.has("meeting"), false);
});

test("key types without a location still render date + time", () => {
  const b = dateBlockFor({ ...exam, location: undefined });
  assert.equal(dateBlockText(b), "Thu Oct 8 · 7:00 pm");
});

test("undated or unparseable items yield no block", () => {
  assert.equal(dateBlockFor({ id: "x", type: "task", title: "?" }), null);
  assert.equal(dateBlockFor({ id: "x", type: "task", title: "?", startAt: "not-a-date" }), null);
});

test("INVARIANT: a rendered block never contains a time without a date", () => {
  const samples = [
    timed,
    allDay,
    exam,
    { id: "s", type: "deadline", title: "d", dueAt: "2026-10-09T03:59:00.000Z", location: "DC" },
    { id: "s2", type: "exam", title: "e", startAt: "2026-10-13", allDay: true },
    { id: "s3", type: "meeting", title: "m", startAt: "bogus" },
  ];
  const monthRe = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}/;
  const timeRe = /\d{1,2}:\d{2} [ap]m/;
  for (const s of samples) {
    const text = dateBlockText(dateBlockFor(s));
    if (timeRe.test(text)) {
      // the date must appear before the time, in the same string
      const m = monthRe.exec(text);
      const t = timeRe.exec(text);
      assert.ok(m, `bare time in "${text}"`);
      assert.ok(m.index < t.index, `date after time in "${text}"`);
    }
  }
});
