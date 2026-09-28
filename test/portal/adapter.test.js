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
  assert.equal(res.session, "signed-in");
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
  assert.equal(mid.section, undefined);
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
