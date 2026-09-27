// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseHTML } from "linkedom";
import * as parsers from "../../extension/src/sources/waterlooworks/parsers.js";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "waterlooworks"
);
const doc = (name) => parseHTML(readFileSync(path.join(FIXTURES, name), "utf8")).document;

// --- detectPage -------------------------------------------------------------

test("detectPage identifies each page kind", () => {
  assert.equal(parsers.detectPage(doc("applications.html")), "applications");
  assert.equal(parsers.detectPage(doc("interviews.html")), "interviews");
  assert.equal(parsers.detectPage(doc("events.html")), "events");
  assert.equal(parsers.detectPage(doc("messages.html")), "messages");
  assert.equal(parsers.detectPage(doc("posting.html")), "posting");
  assert.equal(parsers.detectPage(doc("posting-divs.html")), "posting");
  assert.equal(
    parsers.detectPage(doc("interview-detail-booked.html")),
    "interview-detail"
  );
  assert.equal(parsers.detectPage(doc("message-detail.html")), "message-detail");
  assert.equal(parsers.detectPage(doc("rankings-closed.html")), "rankings");
  assert.equal(
    parsers.detectPage(doc("not-logged-in.html"), {
      url: "https://waterlooworks.uwaterloo.ca/notLoggedIn.htm",
    }),
    "logged-out"
  );
  assert.equal(parsers.detectPage(doc("applications-missing.html")), "unknown");
});

// --- applications grid ------------------------------------------------------

test("parseApplications maps columns by label, not position", () => {
  const { ok, rows } = parsers.parseApplications(doc("applications.html"));
  assert.equal(ok, true);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    jobId: "488135",
    jobTitle: "Analog/Mixed-Signal Engineering Co-op",
    employer: "Globex",
    division: "Hardware",
    term: "2027 - Winter",
    appStatusText: "Applied",
    jobStatusText: "Interview Selections Complete",
    location: "San Jose",
    city: "San Jose",
    openings: "2",
    appDeadline: "2026-09-29T13:00:00.000Z",
    submittedOn: "2026-09-15T20:12:00.000Z",
  });
  // Date-only and MM/DD/YYYY values both parse.
  assert.equal(rows[1].appDeadline, "2026-10-02");
  assert.equal(rows[1].submittedOn, "2026-09-25T16:01:00.000Z");
  assert.equal(rows[1].appStatusText, "Not Selected");
  assert.equal(rows[2].appStatusText, "Selected for Interview");
  // EST deadline crosses midnight UTC.
  assert.equal(rows[2].appDeadline, "2026-12-01T04:59:00.000Z");
});

test("parseApplications: ok:true with zero rows vs ok:false with no table", () => {
  assert.deepEqual(parsers.parseApplications(doc("applications-empty.html")), {
    ok: true,
    rows: [],
  });
  assert.equal(parsers.parseApplications(doc("not-logged-in.html")).ok, false);
  assert.equal(parsers.parseApplications(doc("applications-missing.html")).ok, false);
});

// --- interviews / events / messages -----------------------------------------

test("parseInterviews reads the rendered list", () => {
  const { ok, rows } = parsers.parseInterviews(doc("interviews.html"));
  assert.equal(ok, true);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    jobId: "488135",
    jobTitle: "Analog/Mixed-Signal Engineering Co-op",
    employer: "Globex",
    division: "Hardware",
    term: "2027 - Winter",
    scheduleStatus: "Scheduled",
    confirmationStatus: "Confirmed",
    startAt: "2026-10-02T20:00:00.000Z",
    type: "In-Person",
    location: "TC 2218",
    method: "On Campus",
  });
  assert.equal(rows[1].scheduleStatus, "Cancelled");
  assert.equal(rows[2].jobId, "488135"); // second interview, same job
});

test("parseEventRegistrations reads the dashboard table", () => {
  const { ok, rows } = parsers.parseEventRegistrations(doc("events.html"));
  assert.equal(ok, true);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].module, "Career Development");
  assert.equal(rows[0].event, "Resume Critiques");
  assert.equal(rows[0].startAt, "2026-09-29T14:00:00.000Z");
  assert.equal(rows[0].registrationStatus, "Attended");
  assert.equal(rows[2].registrationStatus, "Cancelled");
});

test("parseMessages reads the inbox table without bodies", () => {
  const { ok, rows } = parsers.parseMessages(doc("messages.html"));
  assert.equal(ok, true);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].subject, "Cycle 1 applications due on WaterlooWorks");
  assert.equal(rows[0].from, "Casey Advisor");
  assert.equal(rows[0].priority, "High");
  assert.equal(rows[0].receivedAt, "2026-09-25T16:01:00.000Z");
  assert.equal(rows[1].respondedAt, "2026-09-21T12:00:00.000Z");
});

// --- posting ----------------------------------------------------------------

test("parsePosting reads label/value tables and skips long-text fields", () => {
  const posting = parsers.parsePosting(doc("posting.html"));
  assert.equal(posting.ok, true);
  assert.equal(posting.jobId, "488135");
  assert.equal(posting.jobTitle, "Analog/Mixed-Signal Engineering Co-op");
  assert.equal(posting.employer, "Globex");
  assert.equal(posting.division, "Hardware");
  assert.equal(posting.deadline, "2026-09-30T13:00:00.000Z");
  assert.equal(posting.jobPostingStatus, "Active");
  assert.equal(posting.internalStatus, "Interview Selections Complete");
  assert.equal(posting.fields["Work Term"], "2027 - Winter");
  assert.equal(posting.fields["Job - City"], "San Jose");
  assert.ok(!("Job Summary" in posting.fields));
});

test("parsePosting works when label/value pairs are divs", () => {
  const posting = parsers.parsePosting(doc("posting-divs.html"));
  assert.equal(posting.ok, true);
  assert.equal(posting.jobId, "488200");
  assert.equal(posting.employer, "Contoso Ltd");
  assert.equal(posting.division, "Embedded");
  assert.equal(posting.deadline, "2026-10-06T03:59:00.000Z"); // Oct 5 11:59 PM EDT
  assert.equal(posting.jobPostingStatus, "Expired");
  assert.equal(posting.internalStatus, "Interview Complete");
});

// --- interview detail ---------------------------------------------------------

test("parseInterviewDetail reads a booked interview", () => {
  const detail = parsers.parseInterviewDetail(doc("interview-detail-booked.html"));
  assert.equal(detail.ok, true);
  assert.equal(detail.jobId, "488135");
  assert.equal(detail.jobTitle, "Analog/Mixed-Signal Engineering Co-op");
  assert.equal(detail.employer, "Globex");
  assert.equal(detail.division, "Hardware");
  assert.equal(detail.interviewType, "Individual");
  assert.equal(detail.bookingPermission, "Either you or the staff can book your interview.");
  assert.ok(detail.instructions.includes("Please have your ID ready."));
  assert.equal(detail.booked, true);
  assert.equal(detail.confirmedAt, "2026-09-26T22:53:00.000Z");
  assert.equal(detail.interviewer, "Pat Example");
  assert.equal(detail.method, "Employer Arranged Webcam");
  assert.equal(detail.webcamId, "pat.example@globex.example");
  assert.equal(detail.startAt, "2026-10-02T20:00:00.000Z");
  assert.equal(detail.endAt, "2026-10-02T20:30:00.000Z");
  assert.equal(detail.where, "Virtual Room 106");
  assert.equal(detail.slots.length, 2);
  assert.deepEqual(detail.slots[0], {
    startAt: "2026-10-01T16:30:00.000Z",
    endAt: "2026-10-01T17:00:00.000Z",
    room: "Virtual Room 120",
    state: "Reserved",
  });
});

test("parseInterviewDetail reads an unbooked interview with open slots", () => {
  const detail = parsers.parseInterviewDetail(doc("interview-detail-unbooked.html"));
  assert.equal(detail.ok, true);
  assert.equal(detail.jobId, "400001");
  assert.equal(detail.jobTitle, "Hardware Co-op");
  assert.equal(detail.booked, false);
  assert.equal(detail.startAt, undefined);
  assert.equal(detail.slots.length, 3);
  assert.deepEqual(
    detail.slots.map((s) => s.state),
    ["Available", "Reserved", "Available"]
  );
  assert.equal(detail.slots[0].room, "Virtual Room 120");
});

// --- message detail / rankings ------------------------------------------------

test("parseMessageDetail keeps metadata but never the body", () => {
  const detail = parsers.parseMessageDetail(doc("message-detail.html"));
  assert.equal(detail.ok, true);
  assert.equal(detail.subject, "Cycle 1 applications due on WaterlooWorks");
  assert.equal(detail.category, "Interview - Student");
  assert.equal(detail.subCategory, "Schedule Open - Pick Time Slot (2039)");
  assert.equal(detail.attachedTo, "Interview Schedule");
  assert.equal(detail.createdAt, "2026-09-25T16:01:00.000Z");
  assert.equal(detail.linkedJobId, "488135");
  assert.equal(detail.linkedJobTitle, "Analog/Mixed-Signal Engineering Co-op");
  const serialized = JSON.stringify(detail);
  assert.ok(!serialized.includes("confidential"));
  assert.ok(!serialized.includes("A Student")); // "To" never extracted
  assert.ok(!serialized.includes("Casey Advisor")); // "Created By" never extracted
});

test("parseRankings reads the closed state", () => {
  const rankings = parsers.parseRankings(doc("rankings-closed.html"));
  assert.equal(rankings.ok, true);
  assert.equal(rankings.term, "2027 - Winter");
  assert.equal(rankings.open, false);
  assert.match(rankings.note, /not open at this time/);
});

// --- parseAll -----------------------------------------------------------------

test("parseAll returns every section present in one fragment", () => {
  const result = parsers.parseAll(doc("dashboard.html"), {
    url: "https://waterlooworks.uwaterloo.ca/myAccount/dashboard.htm",
  });
  assert.equal(result.page, "events");
  assert.equal(result.events.rows.length, 1);
  assert.equal(result.messages.rows.length, 1);
  assert.equal(result.posting, undefined);
});
