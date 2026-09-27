// @ts-check
// The one-off .ics download: buildFeedPayload -> applyPublish -> buildCalendar
// must produce a VCALENDAR carrying the same UIDs the feed would use.
import test from "node:test";
import assert from "node:assert/strict";
import { buildFeedPayload } from "../../extension/src/calendar/payload.js";
import { applyPublish, buildCalendar } from "../../server/src/worker.js";

const NOW = new Date("2026-10-01T16:00:00.000Z"); // Thu Oct 1, 12:00 EDT
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

const CAL = {
  enabled: true,
  include: { classes: true, classWeeks: 8, completed: true, tentative: true, termDates: true },
};

const ITEMS = {
  "learn:asn1": {
    id: "learn:asn1",
    source: "learn",
    type: "deadline",
    title: "Assignment 1",
    org: "MATH 117",
    status: "open",
    confidence: "exact",
    review: "auto",
    dueAt: iso(NOW.getTime() + 2 * DAY),
  },
  "portal:lec": {
    id: "portal:lec",
    source: "portal",
    type: "class",
    title: "Lecture",
    org: "MATH 117",
    status: "open",
    confidence: "exact",
    review: "auto",
    startAt: iso(NOW.getTime() + DAY),
    endAt: iso(NOW.getTime() + DAY + 3600000),
    calendar: { uid: "portal-lec-1@waterloo-all-in-1", seq: 3 },
  },
};

test("ics export renders a VCALENDAR with the feed UIDs", () => {
  const { payload, count } = buildFeedPayload(ITEMS, {}, CAL, NOW);
  assert.equal(count, 2);
  const { state, accepted, skipped } = applyPublish(null, payload, NOW);
  assert.equal(accepted, 2);
  assert.equal(skipped.length, 0);
  const ics = buildCalendar(state, {});
  assert.match(ics, /^BEGIN:VCALENDAR\r?\n/);
  assert.match(ics, /END:VCALENDAR\r?\n?$/);
  assert.match(ics, /VERSION:2\.0/);
  // Assigned uid is reused verbatim; unassigned ids get the feed suffix.
  assert.match(ics, /UID:portal-lec-1@waterloo-all-in-1\r?\n/);
  assert.match(ics, /UID:learn:asn1@waterloo-all-in-1\r?\n/);
  assert.match(ics, /SUMMARY:/);
});

test("ics export of an empty week still yields a valid empty VCALENDAR", () => {
  const { payload } = buildFeedPayload({}, {}, CAL, NOW);
  const { state } = applyPublish(null, payload, NOW);
  const ics = buildCalendar(state, {});
  assert.match(ics, /^BEGIN:VCALENDAR/);
  assert.doesNotMatch(ics, /BEGIN:VEVENT/);
});
