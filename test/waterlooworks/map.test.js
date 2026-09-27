// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseHTML } from "linkedom";
import { extractDates } from "../../extension/src/lib/textdates/index.js";
import * as parsers from "../../extension/src/sources/waterlooworks/parsers.js";
import {
  toApplications,
  interviewItems,
  eventItems,
  postingItems,
  interviewDetailItems,
  linkItems,
  mergeInterviewScopes,
  messageDateItems,
  coopDateItems,
} from "../../extension/src/sources/waterlooworks/map.js";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "waterlooworks"
);
const doc = (name) => parseHTML(readFileSync(path.join(FIXTURES, name), "utf8")).document;
const NOW = new Date("2026-09-20T12:00:00.000Z");
const NOW_ISO = NOW.toISOString();

test("toApplications normalizes statuses into the contract shape", () => {
  const rows = parsers.parseApplications(doc("applications.html")).rows;
  const apps = toApplications(rows);
  assert.equal(apps.length, 3);
  assert.deepEqual(apps[0], {
    id: "waterlooworks:488135",
    employer: "Globex",
    jobTitle: "Analog/Mixed-Signal Engineering Co-op",
    jobId: "488135",
    cycle: "2027 - Winter",
    status: "applied",
    history: [],
    itemIds: [],
  });
  assert.equal(apps[1].status, "not-selected");
  assert.equal(apps[2].status, "selected-for-interview");
});

test("interviewItems builds interview Items with contract fields", () => {
  const rows = parsers.parseInterviews(doc("interviews.html")).rows;
  const items = interviewItems(rows, NOW);
  assert.equal(items.length, 3);

  const first = items[0];
  assert.equal(first.id, "waterlooworks:interview:488135");
  assert.equal(first.source, "waterlooworks");
  assert.equal(first.type, "interview");
  assert.equal(first.title, "Interview: Analog/Mixed-Signal Engineering Co-op");
  assert.equal(first.org, "Globex");
  assert.equal(first.startAt, "2026-10-02T20:00:00.000Z");
  assert.equal(first.location, "TC 2218");
  assert.equal(first.status, "open");
  assert.equal(first.confidence, "exact");
  assert.equal(first.review, "auto");
  assert.deepEqual(first.seenIn, [
    {
      source: "waterlooworks",
      key: "interview:488135",
      scope: "waterlooworks", // unified scope: the adapter's union is authoritative
      at: NOW_ISO,
    },
  ]);
  assert.match(first.details, /Type: In-Person/);
  assert.equal(first.meta.jobId, "488135");
  assert.equal(first.meta.prep.format, "In-Person");
  assert.deepEqual(first.evidence, { method: "html" });

  // Cancelled schedule status -> cancelled Item.
  assert.equal(items[1].status, "cancelled");
  // No location -> falls back to method.
  assert.equal(items[2].location, "Phone Call");
});

test("interviewItems suffixes duplicate jobIds deterministically", () => {
  const rows = parsers.parseInterviews(doc("interviews.html")).rows;
  const items = interviewItems(rows, NOW);
  const ids = items.map((i) => i.id);
  assert.deepEqual(ids, [
    "waterlooworks:interview:488135",
    "waterlooworks:interview:488200",
    "waterlooworks:interview:488135:2026-11-30",
  ]);
  // Re-parsing produces identical ids (deterministic).
  assert.deepEqual(
    interviewItems(rows, NOW).map((i) => i.id),
    ids
  );
});

test("eventItems maps registration rows to event Items", () => {
  const rows = parsers.parseEventRegistrations(doc("events.html")).rows;
  const items = eventItems(rows, NOW);
  assert.equal(items.length, 3);
  const first = items[0];
  assert.match(first.id, /^waterlooworks:event:[0-9a-f]+$/);
  assert.equal(first.type, "event");
  assert.equal(first.title, "Resume Critiques");
  assert.equal(first.org, "Career Development");
  assert.equal(first.startAt, "2026-09-29T14:00:00.000Z");
  assert.equal(first.location, "TC 1234");
  assert.equal(first.status, "open");
  assert.equal(first.meta.registrationStatus, "Attended");
  assert.equal(items[2].status, "cancelled");
});

test("postingItems only emits a deadline while it is still in the future", () => {
  const posting = parsers.parsePosting(doc("posting.html"));
  const future = postingItems(posting, NOW);
  assert.equal(future.length, 1);
  assert.equal(future[0].id, "waterlooworks:deadline:488135");
  assert.equal(future[0].type, "application-deadline");
  assert.equal(future[0].title, "Apply: Analog/Mixed-Signal Engineering Co-op");
  assert.equal(future[0].org, "Globex");
  assert.equal(future[0].dueAt, "2026-09-30T13:00:00.000Z");
  assert.equal(future[0].meta.jobId, "488135");

  const past = postingItems(posting, new Date("2026-12-01T00:00:00.000Z"));
  assert.equal(past.length, 0);
});

test("interviewDetailItems: booked detail enriches the list item's id", () => {
  const detail = parsers.parseInterviewDetail(doc("interview-detail-booked.html"));
  const items = interviewDetailItems(detail, NOW);
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.id, "waterlooworks:interview:488135");
  assert.equal(item.type, "interview");
  assert.equal(item.startAt, "2026-10-02T20:00:00.000Z");
  assert.equal(item.endAt, "2026-10-02T20:30:00.000Z");
  assert.equal(item.location, "Virtual Room 106");
  assert.match(item.details, /Interviewer: Pat Example/);
  assert.match(item.details, /Method: Employer Arranged Webcam/);
  assert.equal(item.meta.prep.interviewer, "Pat Example");
  assert.equal(item.meta.prep.location, "Virtual Room 106");
  assert.equal(item.meta.prep.confirmedAt, "2026-09-26T22:53:00.000Z");
});

test("interviewDetailItems: open slots produce a book-by deadline", () => {
  const detail = parsers.parseInterviewDetail(doc("interview-detail-unbooked.html"));
  const items = interviewDetailItems(detail, NOW);
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.id, "waterlooworks:timeslot:400001");
  assert.equal(item.type, "deadline");
  assert.equal(item.category, "interview-timeslot");
  assert.equal(item.title, "Book interview slot: Hardware Co-op");
  assert.equal(item.org, "Globex");
  // Earliest available slot is Oct 1 12:30 PM ET (16:30Z) minus 24h.
  assert.equal(item.dueAt, "2026-09-30T16:30:00.000Z");
  assert.equal(item.confidence, "tentative");
  assert.equal(item.review, "auto");
  assert.equal(item.status, "open");
  assert.equal(item.meta.jobId, "400001");
  assert.equal(item.meta.availableSlots, 2);
  assert.equal(item.meta.rule, "24h-before-first-slot");
});

test("linkItems attaches item ids onto matching Applications", () => {
  const rows = parsers.parseApplications(doc("applications.html")).rows;
  const apps = toApplications(rows);
  const items = interviewItems(
    parsers.parseInterviews(doc("interviews.html")).rows,
    NOW
  );
  const linked = linkItems(apps, items);
  assert.deepEqual(linked[0].itemIds.sort(), [
    "waterlooworks:interview:488135",
    "waterlooworks:interview:488135:2026-11-30",
  ]);
  assert.deepEqual(linked[1].itemIds, ["waterlooworks:interview:488200"]);
  assert.deepEqual(linked[2].itemIds, []);
  // Original objects are not mutated.
  assert.deepEqual(apps[0].itemIds, []);
});

test("mergeInterviewScopes lets the detail win on shared fields", () => {
  const listItems = interviewItems(
    parsers.parseInterviews(doc("interviews.html")).rows,
    NOW
  );
  const detailItems = interviewDetailItems(
    parsers.parseInterviewDetail(doc("interview-detail-booked.html")),
    NOW
  );
  const merged = mergeInterviewScopes(listItems, detailItems);
  assert.equal(merged.length, 3); // 2 unique ids + one replaced

  const mergedItem = merged.find((i) => i.id === "waterlooworks:interview:488135");
  assert.equal(mergedItem.location, "Virtual Room 106"); // detail wins
  assert.equal(mergedItem.endAt, "2026-10-02T20:30:00.000Z"); // detail adds
  assert.equal(mergedItem.meta.prep.interviewer, "Pat Example"); // detail adds
  assert.equal(mergedItem.title, "Interview: Analog/Mixed-Signal Engineering Co-op"); // list kept
  // details concatenate: list lines first, then the detail's.
  assert.match(mergedItem.details, /Type: In-Person/);
  assert.match(mergedItem.details, /Interviewer: Pat Example/);
  assert.ok(
    mergedItem.details.indexOf("Type: In-Person") <
      mergedItem.details.indexOf("Interviewer: Pat Example")
  );
  assert.ok(merged.find((i) => i.id === "waterlooworks:interview:488135:2026-11-30"));

  // Detail-only items (e.g. timeslots) come through untouched.
  const timeslot = interviewDetailItems(
    parsers.parseInterviewDetail(doc("interview-detail-unbooked.html")),
    NOW
  );
  const merged2 = mergeInterviewScopes(listItems, timeslot);
  assert.ok(merged2.find((i) => i.id === "waterlooworks:timeslot:400001"));
});

test("messageDateItems classifies types and keeps only confident fresh hits", () => {
  // Interview keyword in the snippet wins over the deadline keyword.
  const interview = messageDateItems(
    {
      subject: "Booking open",
      sentAt: "2026-09-25T16:01:00.000Z",
      text: "Your interview is on October 5, 2026 at 10:00 AM.",
    },
    extractDates,
    NOW_ISO
  );
  assert.equal(interview.length, 1);
  assert.equal(interview[0].type, "interview");
  assert.equal(interview[0].startAt, "2026-10-05T14:00:00.000Z");
  assert.equal(interview[0].review, "pending");
  assert.equal(interview[0].org, "WaterlooWorks");

  // Deadline keyword -> dueAt instead of startAt.
  const deadline = messageDateItems(
    {
      subject: "Rankings",
      sentAt: "2026-09-25T16:01:00.000Z",
      text: "Submit your form by October 9, 2026 5:00 PM.",
    },
    extractDates,
    NOW_ISO
  );
  assert.equal(deadline.length, 1);
  assert.equal(deadline[0].type, "deadline");
  assert.equal(deadline[0].dueAt, "2026-10-09T21:00:00.000Z");
  assert.equal(deadline[0].startAt, undefined);

  // A hit more than a day before send time is a past reference — dropped.
  const past = messageDateItems(
    {
      subject: "Recap",
      sentAt: "2026-09-25T16:01:00.000Z",
      text: "We met on September 10.",
    },
    extractDates,
    NOW_ISO
  );
  assert.equal(past.length, 0);

  // Relative dates resolve from the message's send time, not now.
  const relative = messageDateItems(
    {
      subject: "Reminder",
      sentAt: "2026-09-25T16:01:00.000Z",
      text: "Your interview is tomorrow at 2 PM.",
    },
    extractDates,
    NOW_ISO
  );
  assert.equal(relative.length, 1);
  assert.equal(relative[0].startAt, "2026-09-26T18:00:00.000Z");
});

// --- co-op important-dates items ------------------------------------------

test("coopDateItems maps the fixture: times, ranges, ids, exclusions", () => {
  const entries = parsers.parseCoopDates(doc("coop-important-dates.html")).entries;
  const items = coopDateItems(entries, {
    url: "https://uwaterloo.ca/co-operative-education/important-dates",
    nowIso: NOW_ISO,
  });
  const byId = new Map(items.map((i) => [i.id, i]));

  // Exact UTC: "Job postings close 9 a.m. (ET)" on Sep 17 (EDT) -> 13:00Z.
  const close = byId.get(
    "waterlooworks:cycle:winter-2027:cycle-1-posting-a:postings-close"
  );
  assert.equal(close.dueAt, "2026-09-17T13:00:00.000Z");
  assert.equal(close.title, "Cycle 1 Posting A: Job postings close");
  assert.equal(close.category, "postings-close");
  assert.equal(close.meta.workTerm, "Winter 2027");
  assert.equal(close.meta.cycle, "Cycle 1 Posting A");
  assert.equal(close.review, "auto");
  assert.equal(close.confidence, "exact");
  assert.equal(close.url, "https://uwaterloo.ca/co-operative-education/important-dates");
  assert.equal(close.seenIn[0].scope, "waterlooworks");

  // Repeated "Interviews" days collapse to one all-day range per cycle and
  // work term, with an exclusive-midnight end (Sep 21-30 -> Oct 1).
  const run = byId.get("waterlooworks:cycle:winter-2027:cycle-1:interviews");
  assert.equal(run.startAt, "2026-09-21T04:00:00.000Z");
  assert.equal(run.endAt, "2026-10-01T04:00:00.000Z");
  assert.equal(run.allDay, true);
  // January's own "Cycle 1" is a different recruiting season.
  const janRun = byId.get("waterlooworks:cycle:spring-2027:cycle-1:interviews");
  assert.equal(janRun.startAt, "2027-01-22T05:00:00.000Z");
  assert.equal(janRun.endAt, "2027-01-30T05:00:00.000Z");

  // Holidays/classes/exams are excluded; work-term lines stay.
  assert.ok(!items.some((i) => /holiday|classes|exam/i.test(i.title)));
  const termStart = byId.get("waterlooworks:cycle:winter-2027:general:work-term");
  assert.equal(termStart.title, "Fall 2026 co-op work term starts");
  assert.equal(termStart.allDay, true);

  // Two postings-open items for the same cycle collide -> "-2" suffix,
  // and ids carry no date.
  assert.ok(byId.has("waterlooworks:cycle:winter-2027:cycle-1-posting-a:postings-open"));
  assert.ok(byId.has("waterlooworks:cycle:winter-2027:cycle-1-posting-a:postings-open-2"));
  assert.ok(items.every((i) => !/\d{4}-\d{2}-\d{2}/.test(i.id)));
});

test("coopDateItems: endOfDay -> 23:59 Toronto dueAt", () => {
  const items = coopDateItems(
    [
      {
        date: "2026-10-09",
        cycle: "Cycle 1",
        text: "Match results available by end of day",
        time: null,
        endOfDay: true,
      },
    ],
    { nowIso: NOW_ISO }
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].category, "match-results");
  assert.equal(items[0].dueAt, "2026-10-10T03:59:00.000Z"); // 23:59 EDT
  assert.equal(items[0].startAt, undefined);
  assert.equal(items[0].title, "Cycle 1: Match results available");
});
