// @ts-check
// Portal adapter: passive observe of portalapi2.uwaterloo.ca JSON responses.
// Fixtures are synthetic (the real payloads need a live session), built on the
// field names in captures/discovery/portal-discovery-2026-09-27.json.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import adapter from "../../extension/src/sources/portal/index.js";
import { portalInstant, torontoDay } from "../../extension/src/sources/portal/map.js";
import { recompute } from "../../extension/src/core/merge.js";
import { buildFeedPayload } from "../../extension/src/calendar/payload.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "portal");
const NOW = new Date("2026-09-27T16:00:00Z");
const json = (name) => fs.readFileSync(path.join(DIR, `${name}.json`), "utf8");

const URLS = {
  schedule: "https://portalapi2.uwaterloo.ca/v2/student/CourseSchedule/",
  exams: "https://portalapi2.uwaterloo.ca/v2/student/ExamSchedule/",
  enrollments: "https://portalapi2.uwaterloo.ca/v2/student/CourseEnrollments/",
  enrollmentCourse: "https://portalapi2.uwaterloo.ca/v2/student/CourseEnrollments/12345678/ECE-150",
  events: "https://portalapi2.uwaterloo.ca/v2/Calendar/DailyEventsV2?start=2026-09-01&end=2026-12-31",
};

const payload = (url, body, extra = {}) => ({
  source: "portal",
  kind: /** @type {const} */ ("net"),
  url,
  status: 200,
  body,
  at: NOW.toISOString(),
  ...extra,
});

const ctx = (state = {}, terms = []) => ({
  now: NOW,
  settings: {},
  state,
  courses: [],
  terms,
  log: () => {},
  textDates: () => [],
  fetch: async () => ({ status: 0 }),
  relay: async () => ({ status: 0 }),
  parseHtml: async () => null,
});

/** No item anywhere may carry a pre-2000 (or post-2100) start/end. */
const assertSaneDates = (items) => {
  for (const i of items) {
    for (const at of [i.startAt, i.endAt, i.dueAt]) {
      if (!at) continue;
      const y = Number(String(at).slice(0, 4));
      assert.ok(y >= 2000 && y <= 2100, `${i.id} has ${at}`);
    }
  }
};

test("portalInstant reads bare strings as Toronto wall time", () => {
  assert.equal(portalInstant("2026-09-10T13:00:00"), "2026-09-10T17:00:00.000Z"); // EDT
  assert.equal(portalInstant("2026-11-02T13:00:00"), "2026-11-02T18:00:00.000Z"); // EST
  assert.equal(portalInstant("2026-09-10T17:00:00Z"), "2026-09-10T17:00:00.000Z");
  assert.equal(portalInstant("2026-09-10T13:00:00-04:00"), "2026-09-10T17:00:00.000Z");
  assert.equal(portalInstant("2026-09-10T13:00:00-0400"), "2026-09-10T17:00:00.000Z");
  assert.equal(torontoDay("2026-12-18T19:30:00"), "2026-12-18");
  assert.equal(torontoDay("2026-12-19T01:00:00Z"), "2026-12-18"); // offset -> Toronto day
});

test("portalInstant rejects implausible years (.NET MinValue)", () => {
  assert.equal(portalInstant("0001-01-01T00:00:00"), null);
  assert.equal(portalInstant("0001-01-01T00:00:00Z"), null);
  assert.equal(portalInstant("2101-01-01T00:00:00"), null);
  assert.equal(portalInstant("1999-06-15T12:00:00"), null);
  assert.equal(torontoDay("0001-01-01"), null);
  assert.equal(torontoDay("0001-01-01T00:00:00"), null);
});

test("CourseSchedule -> meeting items, TST midterm, course sections", async () => {
  const res = await adapter.observe.parse(payload(URLS.schedule, json("schedule")), ctx());
  assert.equal(res.complete, true);
  assert.ok(!("session" in res)); // success must not set session — it stalls the tile
  assert.equal(res.scope, "portal:schedule");
  assert.deepEqual(res.readOk, ["portal:schedule"]);
  assert.equal(res.items.length, 4);

  const lec = res.items.find((i) => i.id.startsWith("portal:sched:ECE150:LEC002:"));
  assert.equal(lec.type, "class");
  assert.equal(lec.title, "Lecture");
  assert.equal(lec.startAt, "2026-09-10T12:30:00.000Z");
  assert.equal(lec.endAt, "2026-09-10T13:20:00.000Z");
  assert.equal(lec.section, "LEC 002");
  assert.equal(lec.location, "E7 5343");
  assert.equal(lec.review, "auto");
  assert.equal(lec.confidence, "exact");
  assert.equal(lec.seenIn[0].scope, "portal:schedule");
  assert.equal(lec.evidence.method, "api");

  const tut = res.items.find((i) => i.section === "TUT 102");
  assert.equal(tut.type, "tutorial");
  const lab = res.items.find((i) => i.section === "LAB 203");
  assert.equal(lab.type, "lab");

  const tst = res.items.find((i) => i.org === "MATH 117");
  assert.equal(tst.type, "exam");
  assert.equal(tst.category, "midterm");
  assert.equal(tst.title, "Midterm");
  assert.equal(tst.section, "TST 101");
  assert.equal(tst.startAt, "2026-10-22T20:30:00.000Z"); // same instant as the outline midterm

  const ece = res.courses.find((c) => c.code === "ECE 150");
  assert.deepEqual(ece.sections, ["LEC 002", "TUT 102", "LAB 203"]);
  assert.equal(ece.name, "Fundamentals of Engineering");
  assert.equal(ece.term, 1269);
  const math = res.courses.find((c) => c.code === "MATH 117");
  assert.deepEqual(math.sections, ["TST 101"]);
});

test("ExamSchedule -> exam items with seat info, ids survive a moved date", async () => {
  const res = await adapter.observe.parse(payload(URLS.exams, json("exams")), ctx());
  assert.equal(res.scope, "portal:exams");
  assert.equal(res.items.length, 2); // the null-startDate row is skipped

  const ece = res.items.find((i) => i.org === "ECE 150");
  assert.equal(ece.title, "Final exam");
  assert.equal(ece.category, "final");
  assert.equal(ece.startAt, "2026-12-14T14:00:00.000Z"); // 09:00 EST
  assert.equal(ece.endAt, "2026-12-14T16:30:00.000Z");
  assert.equal(ece.location, "PAC 1-12 · Seat A12");
  assert.equal(ece.meta.rawTitle, "ECE 150 Final");

  const math = res.items.find((i) => i.org === "MATH 117");
  assert.equal(math.category, "final");
  assert.equal(math.title, "Final exam");
  assert.equal(math.startAt, "2026-12-19T00:30:00.000Z"); // 19:30 EST
  assert.equal(math.location, undefined);
  assertSaneDates(res.items);

  // Move ECE 150 a day: the id (no date) is stable.
  const moved = JSON.parse(json("exams"));
  moved.data[0].startDate = "2026-12-15T09:00:00";
  moved.data[0].endDate = "2026-12-15T11:30:00";
  const res2 = await adapter.observe.parse(payload(URLS.exams, JSON.stringify(moved)), ctx());
  assert.equal(res2.items.find((i) => i.org === "ECE 150").id, ece.id);
});

test("CourseEnrollments list shape -> course patches, dropped rows skipped", async () => {
  const res = await adapter.observe.parse(payload(URLS.enrollments, json("enrollments")), ctx());
  assert.equal(res.scope, "portal:enrollments");
  assert.deepEqual(res.items, []);
  const ece = res.courses.find((c) => c.code === "ECE 150");
  assert.deepEqual(ece.sections, ["LEC 002", "TUT 102"]);
  assert.equal(ece.outlineUrl, "https://outline.uwaterloo.ca/viewer/view/npch7t");
  assert.equal(ece.name, "Fundamentals of Engineering");
  assert.equal(ece.term, 1269);
  assert.ok(!res.courses.some((c) => c.code === "CHE 102"));

  // The per-course endpoint returns data as a bare array.
  const res2 = await adapter.observe.parse(payload(URLS.enrollmentCourse, json("enrollments-course")), ctx());
  const ece2 = res2.courses.find((c) => c.code === "ECE 150");
  assert.deepEqual(ece2.sections, ["LEC 002", "TUT 102"]);
  assert.equal(ece2.outlineUrl, "https://outline.uwaterloo.ca/viewer/view/npch7t");
});

test("enrollments carry instructors onto the course and schedule facts", async () => {
  const enr = await adapter.observe.parse(payload(URLS.enrollments, json("enrollments")), ctx());
  const ece = enr.courses.find((c) => c.code === "ECE 150");
  assert.deepEqual(ece.instructors, [
    { name: "Jane Smith", email: "jsmith@uwaterloo.ca", section: "LEC 002" },
  ]);

  // Schedule observed after enrollments picks the Instructor fact up.
  const res = await adapter.observe.parse(
    payload(URLS.schedule, json("schedule")),
    ctx(enr.state),
  );
  const lec = res.items.find((i) => i.id.startsWith("portal:sched:ECE150:LEC002:"));
  assert.deepEqual(lec.meta.facts, [
    { label: "Instructor", value: "Jane Smith" },
    { label: "Room", value: "E7 5343" },
    { label: "Section", value: "LEC 002" },
  ]);
  const tut = res.items.find((i) => i.section === "TUT 102");
  assert.ok(!tut.meta.facts.some((f) => f.label === "Instructor"));

  // Without enrollments state there is no Instructor fact.
  const bare = await adapter.observe.parse(payload(URLS.schedule, json("schedule")), ctx());
  const lecBare = bare.items.find((i) => i.id.startsWith("portal:sched:ECE150:LEC002:"));
  assert.ok(!lecBare.meta.facts.some((f) => f.label === "Instructor"));
});

test("exam items carry room, seat and duration facts", async () => {
  const res = await adapter.observe.parse(payload(URLS.exams, json("exams")), ctx());
  const ece = res.items.find((i) => i.org === "ECE 150");
  assert.deepEqual(ece.meta.facts, [
    { label: "Room", value: "PAC 1-12" },
    { label: "Seat", value: "A12" },
    { label: "Duration", value: "2 h 30 min" },
  ]);
  const math = res.items.find((i) => i.org === "MATH 117");
  assert.deepEqual(math.meta.facts, [{ label: "Duration", value: "2 h 30 min" }]);
});

test("a matched TST slot stays in tstIndex so the midterm keeps its facts", async () => {
  // Live order is CourseSchedule then ExamSchedule every round. With an
  // examIndex from the previous round the second schedule read matched the
  // slot but dropped it from tstIndex, so the following exams read emitted
  // a bare midterm (no section/room/Test slot) that overwrote the merge.
  const exams = JSON.stringify({
    meta: { status: 200, type: "success" },
    data: [
      {
        title: "MATH 117 Midterm",
        startDate: "2026-10-22T16:30:00", // overlaps TST 101 (16:30-18:20)
        endDate: "2026-10-22T18:30:00",
        location: "",
        seatCode: null,
        seatInstructions: null,
      },
    ],
  });
  const midtermOf = (/** @type {any} */ res) =>
    res.items.filter((i) => i.type === "exam" && i.org === "MATH 117");
  const assertMerged = (/** @type {any} */ res, /** @type {string} */ step) => {
    const m = midtermOf(res);
    assert.equal(m.length, 1, `${step}: one midterm`);
    const item = m[0];
    assert.equal(item.id, "portal:exam:MATH117:midterm", step);
    assert.equal(item.section, "TST 101", step);
    const facts = Object.fromEntries(
      (item.meta.facts || []).map((/** @type {any} */ f) => [f.label, f.value]),
    );
    return facts;
  };

  // Round 1, schedule first: the TST row is an unmatched midterm — section
  // and room already known, no exam facts yet.
  const r1 = await adapter.observe.parse(payload(URLS.schedule, json("schedule")), ctx());
  assertMerged(r1, "r1 schedule");
  // Round 1, exams: the slot folds in — Section/Test slot/Room facts land.
  const r2 = await adapter.observe.parse(payload(URLS.exams, exams), ctx(r1.state));
  let facts = assertMerged(r2, "r1 exams");
  assert.equal(facts["Section"], "TST 101");
  assert.equal(facts["Room"], "MC 4020"); // exam location empty -> slot room
  assert.ok(facts["Test slot"], "slot window fact");
  assert.ok(facts["Duration"], "exam duration fact");

  // Round 2, schedule with the examIndex in state: matched — and the slot
  // must STILL be in tstIndex.
  const r3 = await adapter.observe.parse(
    payload(URLS.schedule, json("schedule")),
    ctx(r2.state),
  );
  facts = assertMerged(r3, "r2 schedule");
  assert.equal(facts["Section"], "TST 101");
  assert.ok(facts["Test slot"], "matched schedule keeps the Test slot fact");
  assert.deepEqual(
    r3.state.tstIndex["MATH 117"].map((/** @type {any} */ t) => t.section),
    ["TST 101"],
  );

  // Round 2, exams: same merged item — no bare-midterm regression.
  const r4 = await adapter.observe.parse(payload(URLS.exams, exams), ctx(r3.state));
  facts = assertMerged(r4, "r2 exams");
  assert.equal(facts["Section"], "TST 101");
  assert.equal(facts["Room"], "MC 4020");
  assert.ok(facts["Test slot"]);
  assertSaneDates(r4.items);
});

test("MinValue finals become a tentative exam-period window when known", async () => {
  // DailyEventsV2 carries the term's exam period (Dec 10-23).
  const r1 = await adapter.observe.parse(payload(URLS.events, json("events")), ctx());
  const res = await adapter.observe.parse(
    payload(URLS.exams, json("exams-merge")),
    ctx(r1.state),
  );

  const tba = res.items.filter((i) => i.title === "Final exam (date TBA)");
  assert.equal(tba.length, 2); // MATH 135 + ECE 105, both MinValue
  const m135 = tba.find((i) => i.org === "MATH 135");
  assert.equal(m135.id, "portal:exam:MATH135:final"); // same id the exact final would get
  assert.equal(m135.type, "exam");
  assert.equal(m135.category, "final");
  assert.equal(m135.allDay, true);
  assert.equal(m135.confidence, "tentative");
  assert.equal(m135.review, "auto");
  assert.equal(m135.startAt, "2026-12-10T05:00:00.000Z"); // Toronto midnight Dec 10 (EST)
  assert.equal(m135.endAt, "2026-12-24T05:00:00.000Z"); // inclusive Dec 23 -> exclusive
  assertSaneDates(res.items);

  // Once the same final is scheduled, the item upgrades in place.
  const scheduled = JSON.parse(json("exams-merge"));
  scheduled.data[2].startDate = "2026-12-15T12:30:00";
  scheduled.data[2].endDate = "2026-12-15T15:00:00";
  const res2 = await adapter.observe.parse(
    payload(URLS.exams, JSON.stringify(scheduled)),
    ctx(r1.state),
  );
  const exact = res2.items.find((i) => i.org === "MATH 135");
  assert.equal(exact.id, "portal:exam:MATH135:final");
  assert.equal(exact.title, "Final exam");
  assert.equal(exact.confidence, "exact");
  assert.equal(exact.startAt, "2026-12-15T17:30:00.000Z");
});

test("MinValue finals without a known exam period emit nothing", async () => {
  const res = await adapter.observe.parse(payload(URLS.exams, json("exams-merge")), ctx());
  assert.ok(!res.items.some((i) => i.org === "MATH 135"));
  assert.ok(!res.items.some((i) => i.org === "ECE 105"));
  assertSaneDates(res.items);
});

test("the exam period can also come from ctx.terms", async () => {
  const terms = [
    {
      termCode: 1269,
      start: "2026-09-09",
      end: "2026-12-07",
      examPeriod: { start: "2026-12-10", end: "2026-12-23" },
    },
  ];
  const res = await adapter.observe.parse(payload(URLS.exams, json("exams-merge")), ctx({}, terms));
  const m135 = res.items.find((i) => i.org === "MATH 135");
  assert.equal(m135.title, "Final exam (date TBA)");
  assert.equal(m135.startAt, "2026-12-10T05:00:00.000Z");
  assert.equal(m135.endAt, "2026-12-24T05:00:00.000Z");
});

test("ExamSchedule + CourseSchedule TST merge, schedule read first", async () => {
  const r1 = await adapter.observe.parse(payload(URLS.schedule, json("schedule-merge")), ctx());
  // Before exams are read the TST slot stands on its own (booked times/room).
  const tst = r1.items.find((i) => i.org === "ECE 150");
  assert.equal(tst.id, "portal:exam:ECE150:midterm");
  assert.equal(tst.type, "exam");
  assert.equal(tst.category, "midterm");
  assert.equal(tst.title, "Midterm");
  assert.equal(tst.section, "TST 101");
  assert.equal(tst.startAt, "2026-10-22T18:30:00.000Z"); // 14:30 EDT
  assert.equal(tst.endAt, "2026-10-22T20:20:00.000Z");
  assert.equal(tst.location, "RCH 301");
  // The MinValue LEC row yields no item.
  assert.ok(!r1.items.some((i) => i.org === "ECE 105"));
  assertSaneDates(r1.items);

  const r2 = await adapter.observe.parse(
    payload(URLS.exams, json("exams-merge")),
    ctx(r1.state),
  );
  const mid = r2.items.find((i) => i.org === "ECE 150");
  assert.equal(mid.id, "portal:exam:ECE150:midterm"); // replaced in place
  assert.equal(mid.startAt, "2026-10-22T19:00:00.000Z"); // ExamSchedule wins: 15:00-16:00 EDT
  assert.equal(mid.endAt, "2026-10-22T20:00:00.000Z");
  // Exam location was "": the TST room is used, seat/seat-instructions carried.
  assert.equal(mid.location, "RCH 301 · Seat B07");
  assert.equal(mid.details, "Use odd-numbered seats");
  assert.equal(mid.section, "TST 101"); // slot section lands on the item
  assert.deepEqual(mid.meta.facts, [
    { label: "Room", value: "RCH 301" },
    { label: "Seat", value: "B07" },
    { label: "Seat instructions", value: "Use odd-numbered seats" },
    { label: "Duration", value: "1 h" },
    { label: "Section", value: "TST 101" },
    { label: "Test slot", value: "2:30–4:20 PM" },
  ]);
  assertSaneDates(r2.items);
});

test("ExamSchedule + CourseSchedule TST merge, exams read first", async () => {
  const r1 = await adapter.observe.parse(payload(URLS.exams, json("exams-merge")), ctx());
  const exam = r1.items.find((i) => i.org === "ECE 150");
  assert.equal(exam.id, "portal:exam:ECE150:midterm");
  assert.equal(exam.startAt, "2026-10-22T19:00:00.000Z");
  assert.equal(exam.location, "Seat B07"); // no room known yet, seat only

  const r2 = await adapter.observe.parse(
    payload(URLS.schedule, json("schedule-merge")),
    ctx(r1.state),
  );
  // The TST row folds into the exam item instead of adding a second one.
  const eceItems = r2.items.filter((i) => i.org === "ECE 150" && i.category === "midterm");
  assert.equal(eceItems.length, 1);
  const mid = eceItems[0];
  assert.equal(mid.id, "portal:exam:ECE150:midterm");
  assert.equal(mid.startAt, "2026-10-22T19:00:00.000Z"); // exam writing time, not the slot
  assert.equal(mid.endAt, "2026-10-22T20:00:00.000Z");
  assert.equal(mid.location, "RCH 301 · Seat B07");
  assert.equal(mid.details, "Use odd-numbered seats");
  assert.deepEqual(mid.meta.facts, [
    { label: "Room", value: "RCH 301" },
    { label: "Seat", value: "B07" },
    { label: "Seat instructions", value: "Use odd-numbered seats" },
    { label: "Duration", value: "1 h" },
    { label: "Section", value: "TST 101" },
    { label: "Test slot", value: "2:30–4:20 PM" },
  ]);
  assertSaneDates(r2.items);
});

test("exam-only midterm and TST-only midterm stay separate items", async () => {
  // PHYS 121 has no TST row; MATH 117's TST (schedule.json) has no exam.
  const r1 = await adapter.observe.parse(payload(URLS.exams, json("exams-merge")), ctx());
  const phys = r1.items.find((i) => i.org === "PHYS 121");
  assert.equal(phys.id, "portal:exam:PHYS121:midterm");
  assert.equal(phys.title, "Midterm");
  assert.equal(phys.location, "PHY 145");
  assert.equal(phys.startAt, "2026-10-23T23:00:00.000Z"); // 19:00 EDT

  const r2 = await adapter.observe.parse(payload(URLS.schedule, json("schedule")), ctx());
  const math = r2.items.find((i) => i.org === "MATH 117");
  assert.equal(math.id, "portal:exam:MATH117:midterm");
  assert.equal(math.section, "TST 101");
  assert.equal(math.location, "MC 4020");
  assertSaneDates([...r1.items, ...r2.items]);
});

test("DailyEventsV2 -> term-dates, campus events, TermInfo, skips", async () => {
  const res = await adapter.observe.parse(payload(URLS.events, json("events")), ctx());
  assert.equal(res.scope, "portal:events:2026-09-01..2026-12-31");
  assert.deepEqual(res.readOk, ["portal:events:2026-09-01..2026-12-31"]);

  const byTitle = (t) => res.items.find((i) => i.title === t);
  assert.equal(res.items.length, 6); // cancelled + class echo skipped

  const begin = byTitle("Lectures begin");
  assert.equal(begin.type, "term-date");
  assert.equal(begin.review, "auto");
  assert.equal(begin.allDay, true);
  assert.equal(begin.startAt, "2026-09-09T04:00:00.000Z"); // Toronto midnight Sep 9
  assert.equal(begin.endAt, undefined);

  const rw = byTitle("Reading Week");
  assert.equal(rw.type, "term-date");
  assert.equal(rw.startAt, "2026-10-12T04:00:00.000Z");
  assert.equal(rw.endAt, "2026-10-17T04:00:00.000Z"); // inclusive end -> next midnight

  const exams = byTitle("Final examination period");
  assert.equal(exams.startAt, "2026-12-10T05:00:00.000Z");
  assert.equal(exams.endAt, "2026-12-24T05:00:00.000Z"); // 00:00 end is already exclusive

  const mid = byTitle("Midterm week");
  assert.equal(mid.type, "term-date");
  assert.equal(mid.startAt, "2026-10-19T04:00:00.000Z");
  assert.equal(mid.endAt, "2026-10-24T04:00:00.000Z"); // inclusive Oct 23 -> next midnight

  const karaoke = byTitle("Bomber Karaoke Night");
  assert.equal(karaoke.type, "event");
  assert.equal(karaoke.category, "campus");
  assert.equal(karaoke.review, "pending");
  assert.equal(karaoke.startAt, "2026-09-19T01:00:00.000Z"); // 21:00 EDT
  assert.equal(karaoke.endAt, "2026-09-19T03:00:00.000Z");
  assert.equal(karaoke.location, "Bombshelter");
  assert.equal(karaoke.details, "Weekly karaoke at the Bombshelter pub.");
  assert.equal(karaoke.meta.feed, "WUSA Events");
  assert.equal(karaoke.evidence.url, "https://portal.uwaterloo.ca/calendar");

  assert.equal(res.terms.length, 1);
  const { weeks, ...fields } = res.terms[0];
  assert.deepEqual(fields, {
    termCode: 1269,
    start: "2026-09-09",
    end: "2026-12-07",
    readingWeek: { start: "2026-10-12", end: "2026-10-16" },
    midtermWeek: { start: "2026-10-19", end: "2026-10-23" },
    examPeriod: { start: "2026-12-10", end: "2026-12-23" },
  });
  // UW week numbering: week 1 starts mid-week, reading week is week 6.
  assert.equal(weeks.length, 14);
  assert.deepEqual(weeks[0], { n: 1, start: "2026-09-09", end: "2026-09-13" });
  assert.deepEqual(weeks[5], { n: 6, start: "2026-10-12", end: "2026-10-18" });
  assert.deepEqual(weeks[13], { n: 14, start: "2026-12-07", end: "2026-12-07" });
});

test("a pre-exam study day never overwrites the reading week", async () => {
  // Live bug: DailyEventsV2 also carries a 1-day pre-exam "Study day"; it
  // matched the reading-week regex and overwrote the real Oct 10-18 break.
  /** @param {string} summary @param {string} startDate @param {string} endDate @param {string} key */
  const row = (summary, startDate, endDate, key) => ({
    summary,
    name: "Important dates",
    allDay: true,
    startDate,
    endDate,
    key,
    isEventCancelled: false,
  });
  const readingWeek = row(
    "Reading Week",
    "2026-10-10T00:00:00",
    "2026-10-19T00:00:00", // 00:00 end is already exclusive -> Oct 18
    "cal-term-reading-week-1269",
  );
  const studyDay = row(
    "Study day",
    "2026-12-09T00:00:00",
    "2026-12-09T23:59:00",
    "cal-term-study-day-1269",
  );
  const eventsBody = (/** @type {any[]} */ data) =>
    JSON.stringify({ meta: { status: 200, type: "success" }, data });

  for (const data of [
    [readingWeek, studyDay],
    [studyDay, readingWeek],
  ]) {
    const res = await adapter.observe.parse(payload(URLS.events, eventsBody(data)), ctx());
    const term = res.terms.find((t) => t.termCode === 1269);
    assert.deepEqual(term.readingWeek, { start: "2026-10-10", end: "2026-10-18" });
  }

  // Across observes too: a later payload's 1-day break row can't shrink it.
  const r1 = await adapter.observe.parse(
    payload(URLS.events, eventsBody([readingWeek])),
    ctx(),
  );
  const r2 = await adapter.observe.parse(
    payload(URLS.events, eventsBody([studyDay])),
    ctx(r1.state),
  );
  const term = r2.terms.find((t) => t.termCode === 1269);
  assert.deepEqual(term.readingWeek, { start: "2026-10-10", end: "2026-10-18" });
});

test("DailyEventsV2: class/exam feeds are skipped, Learn mirrors become items", async () => {
  /** @param {string} summary @param {any} extra */
  const row = (summary, extra = {}) => ({
    summary,
    name: "Classes",
    key: "class",
    allDay: false,
    startDate: "2026-10-20T08:30:00",
    endDate: "2026-10-20T09:20:00",
    isEventCancelled: false,
    ...extra,
  });
  const body = JSON.stringify({ meta: { status: 200, type: "success" }, data: [
    row("MATH 115 LEC 001"),
    row("MATH 115 Midterm", { key: "exam", name: "Exams", startDate: "2026-10-22T19:00:00", endDate: "2026-10-22T20:30:00" }),
    // Parenthesised TST title under a third-party feed: CLASS_ECHO safety net.
    row("MATH 115 (TST)", { key: "other", name: "Other", startDate: "2026-10-22T19:00:00", endDate: "2026-10-22T20:30:00" }),
    { summary: "Reading Week", name: "Important dates", key: "importantDate", allDay: true,
      startDate: "2026-10-12T00:00:00", endDate: "2026-10-16T23:59:00", isEventCancelled: false },
  ] });
  const res = await adapter.observe.parse(payload(URLS.events, body), ctx());
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].title, "Reading Week");
  assert.equal(res.items[0].type, "term-date");
});

const learnRow = (/** @type {string} */ summary, /** @type {string} */ startDate, /** @type {string} */ endDate, /** @type {any} */ extra = {}) => ({
  summary, name: "Learn", key: "learn", allDay: false, startDate, endDate,
  isEventCancelled: false, feedId: 4, ...extra,
});
const eventsJson = (/** @type {any[]} */ data) =>
  JSON.stringify({ meta: { status: 200, type: "success" }, data });
const eventsParse = (/** @type {any[]} */ data, state = {}) =>
  adapter.observe.parse(payload(URLS.events, eventsJson(data)), ctx(state));

test("DailyEventsV2 Learn feed: same-day zero-duration rows get distinct ids", async () => {
  const res = await eventsParse([
    learnRow("WHMIS Completion", "2026-09-30T08:30:00", "2026-09-30T08:30:00"),
    learnRow("Syllabus & Assignment Outline Quiz", "2026-09-30T23:59:00", "2026-09-30T23:59:00"),
    learnRow("Lab safety acknowledgement", "2026-09-30T12:00:00", "2026-09-30T12:00:00"),
  ]);
  assert.equal(res.items.length, 3);
  const ids = res.items.map((i) => i.id);
  assert.equal(new Set(ids).size, 3);
  for (const id of ids) {
    assert.ok(id.startsWith("portal:learn:"));
    assert.ok(id.endsWith(":2026-09-30"));
  }
  const whmis = res.items.find((i) => i.title === "WHMIS Completion");
  assert.equal(whmis.type, "deadline");
  assert.equal(whmis.dueAt, "2026-09-30T12:30:00.000Z"); // 8:30 EDT
  assert.equal(whmis.startAt, undefined);
  assert.equal(whmis.endAt, undefined);
  assert.equal(whmis.confidence, "tentative");
  assert.equal(whmis.review, "auto");
  assert.equal(whmis.meta.feed, "Learn");
  const quiz = res.items.find((i) => /Quiz/.test(i.title));
  assert.equal(quiz.type, "quiz");
  const lab = res.items.find((i) => /safety/.test(i.title));
  assert.equal(lab.type, "deadline");
});

test("DailyEventsV2 Learn feed: a single-day allDay row dues at 23:59 Toronto", async () => {
  const res = await eventsParse([
    learnRow("Online orientation module", "2026-10-05T00:00:00", "2026-10-05T23:59:00", { allDay: true }),
  ]);
  assert.equal(res.items.length, 1);
  const it = res.items[0];
  assert.equal(it.type, "deadline");
  assert.equal(it.dueAt, "2026-10-06T03:59:00.000Z"); // Oct 5 23:59 EDT
  assert.equal(it.allDay, true);
  assert.equal(it.startAt, undefined);
});

test("DailyEventsV2 Learn feed: a timed exam title maps to a tentative exam", async () => {
  const res = await eventsParse([
    learnRow("ECE190 midterm test", "2026-10-21T15:00:00", "2026-10-21T16:00:00"),
  ]);
  assert.equal(res.items.length, 1);
  const it = res.items[0];
  assert.equal(it.type, "exam");
  assert.equal(it.category, "midterm");
  assert.equal(it.title, "Midterm");
  assert.equal(it.org, "ECE 190");
  assert.equal(it.meta.rawTitle, "ECE190 midterm test");
  assert.equal(it.meta.feed, "Learn");
  assert.equal(it.startAt, "2026-10-21T19:00:00.000Z"); // 15:00 EDT
  assert.equal(it.endAt, "2026-10-21T20:00:00.000Z");
  assert.equal(it.confidence, "tentative");
  assert.equal(it.review, "auto");
});

test("DailyEventsV2 Learn feed: a timed non-exam row stays a pending event", async () => {
  const res = await eventsParse([
    learnRow("Co-op panel booth", "2026-10-05T14:00:00", "2026-10-05T15:00:00"),
  ]);
  assert.equal(res.items.length, 1);
  const it = res.items[0];
  assert.equal(it.type, "event");
  assert.equal(it.review, "pending");
  assert.ok(it.id.startsWith("portal:learn:"));
});

test("DailyEventsV2 Learn feed: a trailing/leading 'due' is stripped to match Learn titles", async () => {
  const res = await eventsParse([
    learnRow("Assignment #3 due", "2026-10-04T00:00:00", "2026-10-04T23:59:00", { allDay: true }),
    learnRow("Due: Lab report", "2026-10-05T17:00:00", "2026-10-05T17:00:00"),
    learnRow("Due date extension request", "2026-10-06T12:00:00", "2026-10-06T12:00:00"),
  ]);
  assert.equal(res.items.length, 3);
  const a3 = res.items.find((i) => /assignment/i.test(i.title));
  assert.equal(a3.title, "Assignment #3");
  assert.equal(a3.meta.rawTitle, "Assignment #3 due");
  assert.equal(a3.dueAt, "2026-10-05T03:59:00.000Z"); // Oct 4 23:59 EDT
  const lab = res.items.find((i) => /lab/i.test(i.title));
  assert.equal(lab.title, "Lab report");
  assert.equal(lab.meta.rawTitle, "Due: Lab report");
  const ext = res.items.find((i) => /extension/i.test(i.title));
  assert.equal(ext.title, "Due date extension request"); // no mid-title strip
  assert.equal(ext.meta.rawTitle, undefined);
});

test("merge: a portal Learn-mirror deadline joins the Learn item", async () => {
  const res = await eventsParse([
    learnRow("WHMIS Completion", "2026-09-30T08:30:00", "2026-09-30T08:30:00"),
  ]);
  const mirror = res.items[0];
  const learnItem = {
    id: "learn:ECE198:dropbox:whmis",
    source: "learn",
    type: "deadline",
    title: "WHMIS Completion",
    org: "ECE 198",
    dueAt: mirror.dueAt,
    status: "open",
    confidence: "exact",
    review: "auto",
    seenIn: [{ source: "learn", key: "k", scope: "learn:ece198", at: NOW.toISOString() }],
    evidence: { method: "api" },
  };
  const out = recompute({
    raws: {
      portal: { items: [mirror], updatedAt: NOW.toISOString() },
      learn: { items: [learnItem], updatedAt: NOW.toISOString() },
    },
    now: NOW,
  });
  assert.equal(Object.keys(out.items).length, 1);
  const canon = Object.values(out.items)[0];
  assert.equal(canon.title, "WHMIS Completion");
});

test("merge: with examIndex the Learn-mirror exam is never emitted — 1 canonical", async () => {
  const exams = await adapter.observe.parse(payload(URLS.exams, eventsJson([
    { title: "ECE 190 Midterm", startDate: "2026-10-21T15:00:00", endDate: "2026-10-21T16:00:00",
      location: "MC 2034", seatCode: null, seatInstructions: null },
  ])), ctx());
  const portalExam = exams.items.find((i) => i.org === "ECE 190");
  assert.equal(portalExam.id, "portal:exam:ECE190:midterm");
  // Events observed after exams: examIndex names the ECE 190 midterm, so the
  // same-day overlapping Learn row is dropped instead of duplicating it.
  const res = await eventsParse(
    [learnRow("ECE190 midterm test", "2026-10-21T15:00:00", "2026-10-21T16:00:00")],
    exams.state,
  );
  assert.equal(res.items.length, 0);
  const out = recompute({
    raws: { portal: { items: [portalExam], updatedAt: NOW.toISOString() } },
    now: NOW,
  });
  assert.equal(Object.keys(out.items).length, 1);
  const feed = buildFeedPayload(out.items, {}, {}, NOW, { acceptPending: true });
  assert.equal(feed.count, 1);
  assert.equal(feed.collapsed, 0);
});

test("merge: a 'due'-suffixed mirror still joins the Learn item", async () => {
  const res = await eventsParse([
    learnRow("Assignment #3 due", "2026-10-04T00:00:00", "2026-10-04T23:59:00", { allDay: true }),
  ]);
  const mirror = res.items[0];
  const learnItem = {
    id: "learn:MATH117:dropbox:a3",
    source: "learn",
    type: "deadline",
    title: "Assignment #3",
    org: "MATH 117",
    dueAt: mirror.dueAt, // Oct 4 23:59 Toronto
    status: "open",
    confidence: "exact",
    review: "auto",
    seenIn: [{ source: "learn", key: "k", scope: "learn:math117", at: NOW.toISOString() }],
    evidence: { method: "api" },
  };
  const out = recompute({
    raws: {
      portal: { items: [mirror], updatedAt: NOW.toISOString() },
      learn: { items: [learnItem], updatedAt: NOW.toISOString() },
    },
    now: NOW,
  });
  assert.equal(Object.keys(out.items).length, 1);
  assert.equal(Object.values(out.items)[0].title, "Assignment #3");
});

test("merge: a Learn-mirror exam starting within the hour is still suppressed", async () => {
  const exams = await adapter.observe.parse(payload(URLS.exams, eventsJson([
    { title: "ECE 190 Midterm", startDate: "2026-10-21T15:00:00", endDate: "2026-10-21T16:00:00",
      location: "MC 2034", seatCode: null, seatInstructions: null },
  ])), ctx());
  // A disjoint interval 45 min after the exam's start: no overlap, but the
  // start sits inside the 60-minute window -> same exam, not emitted.
  const res = await eventsParse(
    [learnRow("ECE190 midterm test", "2026-10-21T15:45:00", "2026-10-21T16:45:00")],
    exams.state,
  );
  assert.equal(res.items.length, 0);
  // A mirror on a different day (or an unlisted course) still emits.
  const other = await eventsParse(
    [
      learnRow("ECE190 midterm test", "2026-10-22T15:00:00", "2026-10-22T16:00:00"),
      learnRow("MATH117 midterm test", "2026-10-21T15:00:00", "2026-10-21T16:00:00"),
    ],
    exams.state,
  );
  assert.equal(other.items.length, 2);
});

test("DailyEventsV2: same-day Important Dates rows get distinct ids and both feed terms", async () => {
  // Live bug: row.key is the feed key ("importantDate"), so "Classes begin"
  // and a second term row on 2027-01-11 collided on one id and the later
  // row was silently lost.
  const row = (/** @type {string} */ summary) => ({
    summary,
    name: "Important dates",
    key: "importantDate",
    allDay: true,
    startDate: "2027-01-11T00:00:00",
    endDate: "2027-01-11T23:59:00",
    isEventCancelled: false,
  });
  const res = await eventsParse([
    row("Classes begin"),
    row("Co-operative work term begins"),
    row("Final examinations end"),
  ]);
  assert.equal(res.items.length, 3);
  const ids = res.items.map((i) => i.id);
  assert.equal(new Set(ids).size, 3);
  for (const id of ids) {
    assert.ok(id.startsWith("portal:event:importantDate:"));
    assert.ok(id.endsWith(":2027-01-11"));
  }
  const term = res.terms.find((t) => t.start === "2027-01-11");
  assert.ok(term, "the 'Classes begin' row reached collectTerm");
  assert.equal(term.examPeriod && term.examPeriod.end, "2027-01-11"); // 'examinations end' row too
});

test("DailyEventsV2: the same row read twice keeps the same id", async () => {
  const rows = [{
    summary: "Bomber Karaoke Night",
    name: "WUSA Events",
    key: "wusa-events",
    allDay: false,
    startDate: "2026-09-18T21:00:00",
    endDate: "2026-09-18T23:00:00",
    isEventCancelled: false,
  }];
  const a = await eventsParse(rows);
  const b = await eventsParse(rows);
  assert.equal(a.items.length, 1);
  assert.equal(a.items[0].id, b.items[0].id);
  assert.match(a.items[0].id, /^portal:event:wusa-events:[0-9a-f]+:2026-09-18$/);
});

test("an exact reading-week title wins over a vaguer break row", async () => {
  const row = (/** @type {string} */ summary, /** @type {string} */ startDate, /** @type {string} */ endDate) => ({
    summary,
    name: "Important dates",
    allDay: true,
    startDate,
    endDate,
    isEventCancelled: false,
  });
  const fallBreak = row("Fall break", "2026-10-10T00:00:00", "2026-10-10T23:59:00");
  const readingWeek = row("Reading Week", "2026-10-10T00:00:00", "2026-10-19T00:00:00");
  const body = JSON.stringify({ meta: { status: 200, type: "success" }, data: [fallBreak, readingWeek] });
  const res = await adapter.observe.parse(payload(URLS.events, body), ctx());
  const term = res.terms.find((t) => t.termCode === 1269);
  assert.deepEqual(term.readingWeek, { start: "2026-10-10", end: "2026-10-18" });
});

test("courses and terms accumulate across observes", async () => {
  const r1 = await adapter.observe.parse(payload(URLS.enrollments, json("enrollments")), ctx());
  const r2 = await adapter.observe.parse(payload(URLS.exams, json("exams")), ctx(r1.state));
  const ece = r2.courses.find((c) => c.code === "ECE 150");
  assert.equal(ece.outlineUrl, "https://outline.uwaterloo.ca/viewer/view/npch7t"); // carried, not wiped
  assert.ok(r2.items.length > 0);

  const r3 = await adapter.observe.parse(payload(URLS.events, json("events")), ctx(r2.state));
  const r4 = await adapter.observe.parse(payload(URLS.schedule, json("schedule")), ctx(r3.state));
  assert.equal(r4.terms.length, 1);
  assert.equal(r4.terms[0].termCode, 1269);
  assert.ok(r4.courses.length >= 2);
});

test("failure paths: 401 signs out, junk/error bodies complete false", async () => {
  const r401 = await adapter.observe.parse(payload(URLS.schedule, "{}", { status: 401 }), ctx());
  assert.equal(r401.session, "signed-out");
  assert.equal(r401.complete, false);
  assert.equal(r401.scope, "portal:none");

  const junk = await adapter.observe.parse(payload(URLS.schedule, "<html>oops</html>"), ctx());
  assert.equal(junk.complete, false);
  assert.equal(junk.session, undefined);

  const err = await adapter.observe.parse(
    payload(URLS.schedule, JSON.stringify({ meta: { type: "error" }, data: null })),
    ctx(),
  );
  assert.equal(err.complete, false);
  assert.equal(err.session, undefined);
});

test("sync is a no-tab stub carrying accumulated state", async () => {
  const res = await adapter.sync(ctx());
  assert.equal(res.complete, false);
  assert.equal(res.session, "no-tab");
  assert.deepEqual(res.items, []);
  const withState = await adapter.sync(ctx({ courses: { "ECE 150": { code: "ECE 150", term: 1269 } } }));
  assert.deepEqual(withState.courses.map((c) => c.code), ["ECE 150"]);
});

test("urlPatterns match the four endpoints and nothing else", () => {
  const re = adapter.observe.urlPatterns.map((p) => new RegExp(p));
  const match = (u) => re.some((r) => r.test(u));
  assert.ok(match(URLS.schedule));
  assert.ok(match(URLS.exams));
  assert.ok(match(URLS.enrollments));
  assert.ok(match(URLS.enrollmentCourse));
  assert.ok(match(URLS.events));
  assert.ok(match("https://portalapi2.uwaterloo.ca/v2/student/CourseSchedule?term=1269"));
  assert.ok(!match("https://portalapi2.uwaterloo.ca/v2/Weather"));
  assert.ok(!match("https://portalapi2.uwaterloo.ca/v2/learn/CategorizedGrades/"));
  assert.ok(!match("https://portalapi2.uwaterloo.ca/v2/Card/"));
  assert.ok(!match("https://portalapi2.uwaterloo.ca/v2/student/CourseScheduleFake/"));
});
