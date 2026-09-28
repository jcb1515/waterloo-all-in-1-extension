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

test("detectPage recognises the dashboard by URL and by structure", () => {
  const url = "https://waterlooworks.uwaterloo.ca/myAccount/dashboard.htm";
  assert.equal(
    parsers.detectPage(doc("dashboard-live.html"), { url }),
    "dashboard"
  );
  // The suffix-less URL and the /myAccount root render the same page.
  assert.equal(
    parsers.detectPage(doc("dashboard-live.html"), {
      url: "https://waterlooworks.uwaterloo.ca/myAccount/dashboard",
    }),
    "dashboard"
  );
  assert.equal(
    parsers.detectPage(doc("dashboard-live.html"), {
      url: "https://waterlooworks.uwaterloo.ca/myAccount/",
    }),
    "dashboard"
  );
  // Structure alone detects it too — the live module markers are unique.
  assert.equal(parsers.detectPage(doc("dashboard-live.html")), "dashboard");
  assert.equal(parsers.detectPage(doc("dashboard-snapshot.html")), "dashboard");
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

test("parseMessageDetail keeps metadata; bodyText is transient only", () => {
  const detail = parsers.parseMessageDetail(doc("message-detail.html"));
  assert.equal(detail.ok, true);
  assert.equal(detail.subject, "Cycle 1 applications due on WaterlooWorks");
  assert.equal(detail.category, "Interview - Student");
  assert.equal(detail.subCategory, "Schedule Open - Pick Time Slot (2039)");
  assert.equal(detail.attachedTo, "Interview Schedule");
  assert.equal(detail.createdAt, "2026-09-25T16:01:00.000Z");
  assert.equal(detail.linkedJobId, "488135");
  assert.equal(detail.linkedJobTitle, "Analog/Mixed-Signal Engineering Co-op");
  // bodyText is returned for one-shot date extraction; the adapter must
  // never persist it (asserted at the adapter level).
  assert.match(detail.bodyText, /private and must never be stored/);
  assert.ok(!detail.bodyText.includes("Priority")); // admin block excluded
  const serialized = JSON.stringify(detail);
  assert.ok(!serialized.includes("A Student")); // "To" never extracted
  assert.ok(!serialized.includes("Casey Advisor")); // "Created By" never extracted
});

test("parseMessageDetail bodyText is whitespace-collapsed plain text", () => {
  const detail = parsers.parseMessageDetail(doc("message-detail-dates.html"));
  assert.equal(detail.ok, true);
  assert.match(detail.bodyText, /book your slot by Friday, October 2 at 4:00 PM/);
  assert.match(detail.bodyText, /mentioned on September 10/);
});

test("parseRankings reads the closed state", () => {
  const rankings = parsers.parseRankings(doc("rankings-closed.html"));
  assert.equal(rankings.ok, true);
  assert.equal(rankings.term, "2027 - Winter");
  assert.equal(rankings.open, false);
  assert.match(rankings.note, /not open at this time/);
});

// --- dashboard ---------------------------------------------------------------

test("parseDashboard reads schedule, events, counts and the rankings notice", () => {
  // The full-page module markup and the flattened content.js snapshot parse
  // identically — the day scan is document-order based.
  for (const name of ["dashboard-live.html", "dashboard-snapshot.html"]) {
    const res = parsers.parseDashboard(doc(name));
    assert.equal(res.ok, true, name);
    // "Your Upcoming Schedule": the day lives in the <strong> above the table.
    assert.equal(res.schedule.tables, 1);
    assert.equal(res.schedule.rows.length, 2);
    assert.deepEqual(res.schedule.rows[0], {
      dayText: "Friday, October 2, 2026",
      date: "2026-10-02",
      startAt: "2026-10-02T20:00:00.000Z", // 4:00 PM Toronto (EDT)
      endAt: "2026-10-02T20:30:00.000Z",
      entryType: "Interview",
      name: "Interview for Analog/Mixed-Signal Engineering Co-op (488135)",
      jobId: "488135",
      jobTitle: "Analog/Mixed-Signal Engineering Co-op",
      status: "Confirmed",
      conflicts: "0",
    });
    assert.equal(res.schedule.rows[1].entryType, "Appointment");
    assert.equal(res.schedule.rows[1].startAt, "2026-10-02T15:00:00.000Z");
    assert.equal(res.schedule.rows[1].jobId, undefined);
    // "Upcoming Events / Workshops": the day is each table's colspan'd th.
    assert.equal(res.events.tables, 2);
    assert.equal(res.events.rows.length, 6);
    assert.deepEqual(res.events.rows[0], {
      dayText: "Monday, September 28, 2026",
      date: "2026-09-28",
      startAt: "2026-09-28T15:30:00.000Z", // 11:30 AM Toronto (EDT)
      endAt: "2026-09-28T17:30:00.000Z",
      category: "Employer Information Sessions",
      name: "Initech Corp | - IN-PERSON Information Session with Initech",
      location: "Tatham Centre 2218",
      registration: "Registration Required",
    });
    assert.equal(res.events.rows[4].startAt, "2026-09-29T20:00:00.000Z");
    assert.equal(res.events.rows[4].location, undefined);
    // The synthetic "Registered" row — the only dashboard event the calendar
    // should keep (map.js filters the public listing).
    assert.equal(res.events.rows[5].name, "Mock Interview Workshop");
    assert.equal(res.events.rows[5].registration, "Registered");
    assert.equal(res.events.rows[5].startAt, "2026-09-29T22:00:00.000Z");
    assert.equal(res.events.rows[5].endAt, "2026-09-29T23:30:00.000Z");
    assert.equal(res.newMessages, 2);
    assert.equal(res.webcamAppointments, 0);
    assert.deepEqual(res.rankings, {
      term: "2027 - Winter",
      open: false,
      note: "Rankings are not open at this time. Visit the calendar to see when rankings will be open.",
    });
  }
});

test("an interview detail page is not mistaken for dashboard events", () => {
  // Slot tables also open with a single-th date row; the colspan guard plus
  // the interview-detail check keep them out of parseDashboard.
  const res = parsers.parseDashboard(doc("interview-detail-unbooked.html"));
  assert.equal(res.events, undefined);
  assert.equal(res.ok, false);
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

test("parseAll emits the dashboard section for the live module markup", () => {
  for (const name of ["dashboard-live.html", "dashboard-snapshot.html"]) {
    const result = parsers.parseAll(doc(name), {
      url: "https://waterlooworks.uwaterloo.ca/myAccount/dashboard.htm",
    });
    assert.equal(result.page, "dashboard", name);
    assert.equal(result.dashboard.ok, true, name);
  }
});

test("a snapshot containing the same table twice yields no duplicates", () => {
  // content.js can capture a table standalone AND inside a .label parent.
  const html = readFileSync(
    path.join(FIXTURES, "interview-detail-unbooked.html"),
    "utf8"
  );
  const doubled = parseHTML(`<div>${html}${html}</div>`).document;
  const detail = parsers.parseInterviewDetail(doubled);
  assert.equal(detail.slots.length, 3); // not 6
  const apps = parsers.parseAll(
    parseHTML(
      `<div>${readFileSync(path.join(FIXTURES, "applications.html"), "utf8")}` +
        `${readFileSync(path.join(FIXTURES, "applications.html"), "utf8")}</div>`
    ).document
  );
  assert.equal(apps.applications.rows.length, 3); // not 6
});

// --- co-op important-dates page ------------------------------------------

test("parseCoopDates reads month calendars into dated entries", () => {
  const res = parsers.parseCoopDates(doc("coop-important-dates.html"));
  assert.equal(res.ok, true);
  assert.equal(res.entries.length, 35);

  const find = (date, text) =>
    res.entries.find((e) => e.date === date && e.text.includes(text));

  // Timed posting open/close carry the cycle label and a 24 h time.
  assert.deepEqual(find("2026-09-05", "Jobs posted"), {
    date: "2026-09-05",
    cycle: "Cycle 1 Posting A", // <strong> spans a <br>
    text: "Jobs posted 9 a.m. (ET)",
    time: "09:00",
    endOfDay: false,
  });
  assert.deepEqual(find("2026-09-17", "Job postings close"), {
    date: "2026-09-17",
    cycle: "Cycle 1 Posting A",
    text: "Job postings close 9 a.m. (ET)",
    time: "09:00",
    endOfDay: false,
  });

  // Bare-text day cells and <p>-wrapped days both work; interviews get the
  // plain "Cycle 1" label, and the label survives a second event paragraph.
  const sep22 = res.entries.filter((e) => e.date === "2026-09-22");
  assert.deepEqual(
    sep22.map((e) => `${e.cycle}: ${e.text}`),
    ["Cycle 1 Posting B: Job postings close 9 a.m. (ET)", "Cycle 1: Interviews"]
  );

  // "Application limit" lines inside event paragraphs are skipped.
  assert.ok(!res.entries.some((e) => /application limit/i.test(e.text)));

  // Non-co-op lines are still entries (the mapper excludes them).
  assert.ok(find("2026-09-07", "Holiday - university closed"));
  assert.ok(find("2026-09-09", "Start of classes"));
  assert.equal(find("2026-09-07", "Holiday").cycle, null);

  // Second month table: work-term start and the January interview run.
  assert.ok(find("2027-01-11", "Winter 2027 co-op work term starts"));
  assert.equal(
    res.entries.filter((e) => e.text === "Interviews" && e.date.startsWith("2027-01")).length,
    6
  );

  // Live markup: a <br> inside a phrase ("…request removal<br />from
  // Cycle 2 Match") is a wrap, not an event boundary — the continuation
  // joins back instead of becoming its own fragment entry.
  assert.deepEqual(find("2027-01-31", "Due date to request removal from Cycle 2 Match"), {
    date: "2027-01-31",
    cycle: "Cycle 2",
    text: "Due date to request removal from Cycle 2 Match, 12 p.m. (ET)",
    time: "12:00",
    endOfDay: false,
  });
  assert.ok(!res.entries.some((e) => /^from Cycle/.test(e.text)));
  // The ranking lines parse too — consults and close are distinct rows.
  assert.ok(find("2027-01-31", "Student ranking consults"));
  assert.ok(find("2027-01-31", "Student rankings close"));
});

test("parseCoopDates reports ok:false when no month tables exist", () => {
  const res = parsers.parseCoopDates(
    parseHTML("<html><body><h2>Important dates</h2></body></html>").document
  );
  assert.equal(res.ok, false);
  assert.deepEqual(res.entries, []);
});
