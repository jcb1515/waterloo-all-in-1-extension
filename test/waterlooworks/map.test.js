// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseHTML } from "linkedom";
import * as parsers from "../../extension/src/sources/waterlooworks/parsers.js";
import {
  toApplications,
  interviewItems,
  eventItems,
  postingItems,
  interviewDetailItems,
  linkItems,
  mergeInterviewScopes,
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
