// @ts-check
// Sentences are copied from the real Fall 2026 outlines and the ENGL 192 syllabus
// (captures/outlines/*.txt). All expected instants are America/Toronto wall times
// converted to UTC: EDT (UTC-4) until Nov 1 2026 02:00, EST (UTC-5) after.
import test from "node:test";
import assert from "node:assert/strict";
import { extractDates } from "../../extension/src/lib/textdates/index.js";

const NOW = new Date("2026-09-26T16:00:00Z"); // Sat Sep 26 2026, 12:00 EDT
const O = { now: NOW, termCode: 1269 };

/** Runs extractDates and checks invariants every result must satisfy. */
function run(text, opts = O) {
  const hits = extractDates(text, opts);
  let prevEnd = -1;
  for (const h of hits) {
    assert.equal(text.slice(h.index, h.index + h.text.length), h.text, "index/text must point into the original input");
    assert.ok(h.index >= prevEnd, "hits are sorted and non-overlapping");
    prevEnd = h.index + h.text.length;
    assert.ok(h.confidence >= 0 && h.confidence <= 1);
    assert.equal(h.confidence, Math.round(h.confidence * 100) / 100, "confidence is rounded to 2 decimals");
    assert.equal(typeof h.allDay, "boolean");
    assert.ok(!Number.isNaN(Date.parse(h.startAt)));
    if (h.endAt) assert.ok(Date.parse(h.endAt) > Date.parse(h.startAt));
  }
  return hits;
}

function one(text, opts = O) {
  const hits = run(text, opts);
  assert.equal(hits.length, 1, `expected one hit in ${JSON.stringify(text)}, got ${JSON.stringify(hits)}`);
  return hits[0];
}

/* ------------------------------ single days ------------------------------ */

test("ECE 105 class plan: 'due Sunday Sept 20' is an all-day date with a matching weekday", () => {
  const h = one("Assignment #1 due Sunday Sept 20");
  assert.equal(h.startAt, "2026-09-20T04:00:00.000Z");
  assert.equal(h.endAt, undefined);
  assert.equal(h.allDay, true);
  assert.ok(h.text.includes("Sept 20"));
  assert.ok(!h.weekdayMismatch);
  assert.equal(h.confidence, 0.85); // 0.8 month+day, +0.05 weekday matches
});

test("ECE 105 class plan: 'Quiz #1 Friday Sept 18'", () => {
  const h = one("Quiz #1 Friday Sept 18");
  assert.equal(h.startAt, "2026-09-18T04:00:00.000Z");
  assert.equal(h.allDay, true);
});

test("ENGL 192: 'Sept. 20 (3%)' inside parentheses; the percentage is not a date", () => {
  const h = one("Complete Worksheet: \u201cDe\ufb01ning an Engineering Problem\u201d (Sept. 20 (3%))");
  assert.equal(h.startAt, "2026-09-20T04:00:00.000Z");
  assert.equal(h.allDay, true);
  assert.equal(h.confidence, 0.8);
});

test("ENGL 192: two dates in one line come back in order", () => {
  const hits = run("Complete: Technical Manual Analysis (Assigned Oct. 19, Due Oct. 31 (3%))");
  assert.deepEqual(hits.map((h) => h.startAt), ["2026-10-19T04:00:00.000Z", "2026-10-31T04:00:00.000Z"]);
});

test("ENGL 192: ordinal suffix 'Dec. 6th'", () => {
  const h = one("Complete: Posters (Submit electronically & print by/before Dec. 6th (5%))");
  assert.equal(h.startAt, "2026-12-06T05:00:00.000Z");
});

test("explicit year wins over the term year and raises confidence", () => {
  const h = one("Registered on October 5, 2025.");
  assert.equal(h.startAt, "2025-10-05T04:00:00.000Z");
  assert.equal(h.confidence, 0.85); // 0.8 + 0.05 explicit year
});

/* ------------------------------ times ------------------------------ */

test("MATH 117 assessments: 'Thursday, October 22, 4:30 - 6:20 pm' is a timed range", () => {
  const h = one("Midterm Exam | Thursday, October 22, 4:30 - 6:20 pm | In-person, various rooms across campus | 33%");
  assert.equal(h.startAt, "2026-10-22T20:30:00.000Z");
  assert.equal(h.endAt, "2026-10-22T22:20:00.000Z");
  assert.equal(h.allDay, false);
  assert.ok(!h.weekdayMismatch);
  assert.equal(h.confidence, 0.95); // 0.8 + 0.1 time + 0.05 weekday
});

test("ECE 105: 'Thursday, October 27th' is flagged: Oct 27 2026 is a Tuesday", () => {
  const h = one("The midterm exam (ME) will be held on Thursday, October 27th, 4:30pm \u2013 6:20 pm, in person.");
  assert.equal(h.startAt, "2026-10-27T20:30:00.000Z"); // the written date wins, not the weekday
  assert.equal(h.endAt, "2026-10-27T22:20:00.000Z");
  assert.equal(h.weekdayMismatch, true);
  assert.equal(h.confidence, 0.35);
});

test("ECE 190: a time in parentheses after the date joins it: 'Wed Sep 9 (8:30am)'", () => {
  const h = one("(I) Find schedule, join piazza page | n/a | Wed Sep 9 (8:30am) | 0%");
  assert.equal(h.startAt, "2026-09-09T12:30:00.000Z");
  assert.equal(h.allDay, false);
});

test("ENGL 192: 'December 9, 2026 (before 11:59pm)' is a timed deadline", () => {
  const h = one("*Last chance to submit outstanding assignments: December 9, 2026 (before 11:59pm)");
  assert.equal(h.startAt, "2026-12-10T04:59:00.000Z");
  assert.equal(h.allDay, false);
  assert.equal(h.confidence, 0.95); // 0.8 + 0.1 time + 0.05 year
});

test("after the DST change: 'Nov 2 at 10:00am' is EST", () => {
  const h = one("Office hours Nov 2 at 10:00am");
  assert.equal(h.startAt, "2026-11-02T15:00:00.000Z");
});

/* ------------------------------ ranges ------------------------------ */

test("ENGL 192: 'Oct. 5-8' is an all-day range with an exclusive end", () => {
  const h = one("Assignment 1: Project Pitch & Presentation\u201415% (Individual) | Due: Oct. 5-8");
  assert.equal(h.startAt, "2026-10-05T04:00:00.000Z");
  assert.equal(h.endAt, "2026-10-09T04:00:00.000Z");
  assert.equal(h.allDay, true);
  assert.ok(h.text.includes("Oct. 5-8"));
});

test("ENGL 192: 'Nov. 30-Dec. 6' crosses a month (and the DST change)", () => {
  const h = one("Assignment 3: Engineering Presentation\u201410% (Group, in class) | Due: Nov. 30-Dec. 6");
  assert.equal(h.startAt, "2026-11-30T05:00:00.000Z");
  assert.equal(h.endAt, "2026-12-07T05:00:00.000Z");
  assert.equal(h.allDay, true);
});

test("MATH 117: 'December 10 - 23' exam window", () => {
  const h = one("Final Exam | During the exam period December 10 - 23 | In-person, location TBD | 53%");
  assert.equal(h.startAt, "2026-12-10T05:00:00.000Z");
  assert.equal(h.endAt, "2026-12-24T05:00:00.000Z");
});

test("ENGL 192: 'September 28 through October 4'", () => {
  const h = one("For September 28 through October 4, complete the following tasks:");
  assert.equal(h.startAt, "2026-09-28T04:00:00.000Z");
  assert.equal(h.endAt, "2026-10-05T04:00:00.000Z");
});

test("ENGL 192: 'October 21 through 27' (second end is a bare day)", () => {
  const h = one("For October 21 through 27: Midterms\u2014No classes");
  assert.equal(h.startAt, "2026-10-21T04:00:00.000Z");
  assert.equal(h.endAt, "2026-10-28T04:00:00.000Z");
});

test("ENGL 192: 'October 19 & 20' covers both days", () => {
  const h = one("For October 19 & 20, complete the following tasks:");
  assert.equal(h.startAt, "2026-10-19T04:00:00.000Z");
  assert.equal(h.endAt, "2026-10-21T04:00:00.000Z");
});

test("ENGL 192: 'Dec 7/8' is one of two days: a two-day range with lower confidence", () => {
  const h = one("Poster Design & Showcase (10%): poster design (5%) + (5%) for winter showcase (Dec 7/8).");
  assert.equal(h.startAt, "2026-12-07T05:00:00.000Z");
  assert.equal(h.endAt, "2026-12-09T05:00:00.000Z");
  assert.equal(h.allDay, true);
  assert.equal(h.confidence, 0.6);
});

/* ------------------------------ group rows ------------------------------ */

test("ECE 190: glued group deadlines 'Tue Oct 6Grp 21-40: Wed Oct 7' split into two dates", () => {
  const hits = run("Grp 1-20: Tue Oct 6Grp 21-40: Wed Oct 7");
  assert.deepEqual(hits.map((h) => h.startAt), ["2026-10-06T04:00:00.000Z", "2026-10-07T04:00:00.000Z"]);
  assert.ok(hits.every((h) => h.allDay && !h.weekdayMismatch));
});

test("ECE 190: 'Thur' is a weekday abbreviation", () => {
  const hits = run("Grp 1-20: Wed Oct 28Grp 21-40: Thur Oct 29");
  assert.deepEqual(hits.map((h) => h.startAt), ["2026-10-28T04:00:00.000Z", "2026-10-29T04:00:00.000Z"]);
  assert.ok(hits.every((h) => !h.weekdayMismatch));
});

/* ------------------------------ noise ------------------------------ */

test("numbers that only look like dates are ignored", () => {
  assert.deepEqual(run("Course Notes, pp 11-26 Guichard \u00a71.1.5, 7.5"), []);
  assert.deepEqual(run("Tutorial Assignments (best 7 of 9) | Near Weekly | In-person, due at end of tutorial | 14%"), []);
  assert.deepEqual(run("(G) Submit Deliverable 1 (Part 1) | LEARN dropbox | 8%"), []);
  assert.deepEqual(run("Grp 1-20 and Grp 21-40"), []);
  assert.deepEqual(run("Midterm test | Date TBD | Location TBD | 20%"), []);
  assert.deepEqual(run("You may submit late work."), []);
});

test("a time with no date is not a hit", () => {
  assert.deepEqual(run("see you at 6pm"), []);
});

/* ------------------------------ year inference ------------------------------ */

test("a Winter term puts December in the previous year and January in the term year", () => {
  const w = { now: new Date("2026-12-20T17:00:00Z"), termCode: 1271 };
  assert.equal(one("due Dec 18", w).startAt, "2026-12-18T05:00:00.000Z");
  assert.equal(one("due Jan 15", w).startAt, "2027-01-15T05:00:00.000Z");
});

test("without a term code the year closest to now is used", () => {
  assert.equal(one("due Jan 15", { now: NOW }).startAt, "2027-01-15T05:00:00.000Z");
  assert.equal(one("due Sept 20", { now: NOW }).startAt, "2026-09-20T04:00:00.000Z");
});

/* ------------------------------ relative (Discord, quick-add) ------------------------------ */

test("relative dates resolve against now in Toronto time", () => {
  const t = one("meeting tomorrow at 6pm");
  assert.equal(t.startAt, "2026-09-27T22:00:00.000Z");
  assert.equal(t.allDay, false);
  assert.equal(t.confidence, 0.65); // 0.55 relative + 0.1 time
  const f = one("electrical sync friday 6pm");
  assert.equal(f.startAt, "2026-10-02T22:00:00.000Z"); // the coming Friday
});

test("results do not depend on the machine time zone", () => {
  // The whole suite is also run with TZ=UTC and TZ=Asia/Tokyo; this spot-checks a late-evening instant.
  const h = one("due Sun Sep 20 at 11:30pm");
  assert.equal(h.startAt, "2026-09-21T03:30:00.000Z");
});

/* ------------------------------ review fixes ------------------------------ */

test("review: a comma or 'and' before a count is not a range", () => {
  let h = one("Due Oct 4, 3 attempts allowed");
  assert.equal(h.startAt, "2026-10-04T04:00:00.000Z");
  assert.equal(h.endAt, undefined);
  h = one("Quiz Oct 5 and 12 students per room");
  assert.equal(h.startAt, "2026-10-05T04:00:00.000Z");
  assert.equal(h.endAt, undefined);
  h = one("Lab on Oct 5 & 10% penalty per day late");
  assert.equal(h.endAt, undefined);
});

test("review: an en dash in the original text still extends a bare end day", () => {
  const h = one("For October 21 \u2013 27: Midterms\u2014No classes");
  assert.equal(h.startAt, "2026-10-21T04:00:00.000Z");
  assert.equal(h.endAt, "2026-10-28T04:00:00.000Z");
});

test("review: 'Dec 7/8' followed by a word is still the two-day alternative", () => {
  const h = one("showcase on Dec 7/8 in E7");
  assert.equal(h.startAt, "2026-12-07T05:00:00.000Z");
  assert.equal(h.endAt, "2026-12-09T05:00:00.000Z");
  assert.equal(h.confidence, 0.6);
});

test("review: the end of a range takes the start's explicit year", () => {
  let h = one("Winter break December 28, 2025 - Jan 3");
  assert.equal(h.startAt, "2025-12-28T05:00:00.000Z");
  assert.equal(h.endAt, "2026-01-04T05:00:00.000Z");
  h = one("Exams December 9, 2025 - 12");
  assert.equal(h.startAt, "2025-12-09T05:00:00.000Z");
  assert.equal(h.endAt, "2025-12-13T05:00:00.000Z");
});

test("review: a bare end day before the start day rolls into the next month", () => {
  const h = one("Break Dec 30 - 2");
  assert.equal(h.startAt, "2026-12-30T05:00:00.000Z");
  assert.equal(h.endAt, "2027-01-03T05:00:00.000Z");
});

/* --------------------- casual meridiem guess (mail text) --------------------- */

// now = Tue Sep 29 2026, 11:00 EDT.
const MAIL = { now: new Date("2026-09-29T15:00:00Z") };

test("meridiem guess: 'Thursday at 2' is 2 PM, not 2 AM", () => {
  const h = one("can we meet Thursday at 2?", MAIL);
  assert.equal(h.startAt, "2026-10-01T18:00:00.000Z");
  assert.equal(h.allDay, false);
});

test("meridiem guess: hours 8-11 stay AM ('call at 9 on Friday')", () => {
  const h = one("call at 9 on Friday", MAIL);
  assert.equal(h.startAt, "2026-10-02T13:00:00.000Z");
});

test("meridiem guess: 'lunch at 12' stays noon", () => {
  const h = one("lunch at 12 on Friday", MAIL);
  assert.equal(h.startAt, "2026-10-02T16:00:00.000Z");
});

test("meridiem guess: a 24-hour '13:00' is untouched", () => {
  const h = one("13:00 on Oct 5", MAIL);
  assert.equal(h.startAt, "2026-10-05T17:00:00.000Z");
});
