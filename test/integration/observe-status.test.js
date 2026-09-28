// @ts-check
// Observe-result -> sourceState counters. The scheduler refreshes
// lastOkAt/itemCount/complete only when a result carries readOk and NO
// session field (scheduler.js's observe branch): a "signed-in" marker on a
// successful read leaves the tile showing "nothing picked up". Every
// academic-reader success result must therefore omit `session` — this file
// runs each adapter's real parse and feeds it to nextSourceState.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import portal from "../../extension/src/sources/portal/index.js";
import email from "../../extension/src/sources/email/index.js";
import gcal from "../../extension/src/sources/gcal/index.js";
import outline from "../../extension/src/sources/outline/index.js";
import { parseOutline } from "../../extension/src/sources/outline/parsers.js";
import { extractDates } from "../../extension/src/lib/textdates/index.js";
import { nextSourceState } from "../../extension/src/core/scheduler.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-09-28T12:00:00.000Z");

const baseCtx = (extra = {}) => ({
  now: NOW,
  settings: {},
  state: {},
  courses: [],
  terms: [],
  log: () => {},
  textDates: extractDates,
  fetch: async () => ({ status: 0 }),
  relay: async () => ({ status: 0 }),
  parseHtml: async () => null,
  ...extra,
});

/** The counters a Sources tile reads after one observe result. */
const afterObserve = (result, itemCount) => {
  const st = nextSourceState({}, result, NOW, "observe", itemCount, "x");
  return { lastOkAt: st.lastOkAt, itemCount: st.itemCount, complete: st.complete, session: st.session };
};

test("observe status: a successful portal net read carries no session and stamps counters", async () => {
  const body = fs.readFileSync(path.join(HERE, "..", "fixtures", "portal", "schedule.json"), "utf8");
  const res = await portal.observe.parse(
    {
      source: "portal",
      kind: "net",
      url: "https://portalapi2.uwaterloo.ca/v2/student/CourseSchedule/",
      method: "GET",
      status: 200,
      contentType: "application/json",
      body,
      at: NOW.toISOString(),
    },
    baseCtx(),
  );
  assert.ok(res.items.length > 0);
  assert.ok(!("session" in res), "portal success must not set session");
  const st = afterObserve(res, res.items.length);
  assert.ok(st.lastOkAt);
  assert.equal(st.itemCount, res.items.length);
  assert.equal(st.complete, true);
  assert.equal(st.session, "signed-in"); // readOk implies signed-in
});

test("observe status: a successful gmail list read carries no session and stamps counters", async () => {
  const extract = {
    v: 1,
    provider: "gmail",
    folder: "inbox",
    view: "list",
    messages: [
      {
        key: "t1",
        url: "https://mail.google.com/mail/u/0/#inbox/t1",
        from: "Club President",
        fromEmail: "president@club.example.org",
        subject: "Mixer this week",
        preview: "Our fall mixer is on October 9 at 7pm in the lounge.",
        receivedAt: "2026-09-28T10:00:00.000Z",
      },
    ],
  };
  const res = await email.observe.parse(
    {
      source: "gmail",
      kind: "dom",
      url: "https://mail.google.com/mail/u/0/#inbox",
      body: JSON.stringify(extract),
      at: NOW.toISOString(),
    },
    baseCtx(),
  );
  assert.ok(res.items.length > 0);
  assert.ok(!("session" in res), "email success must not set session");
  const st = afterObserve(res, res.items.length);
  assert.ok(st.lastOkAt);
  assert.equal(st.itemCount, res.items.length);
});

test("observe status: a gcal read with no items still stamps lastOkAt", async () => {
  const res = await gcal.observe.parse(
    {
      source: "gcal",
      kind: "dom",
      url: "https://calendar.google.com/calendar/u/0/r/week",
      body: JSON.stringify({
        view: "week",
        range: { start: "2026-09-27T04:00:00.000Z", end: "2026-10-04T04:00:00.000Z" },
        events: [
          {
            eventId: "e1",
            title: "ECE 105 · Lecture",
            calendarKind: "subscribed",
            startAt: "2026-09-30T18:30:00.000Z",
            endAt: "2026-09-30T19:20:00.000Z",
          },
        ],
      }),
      at: NOW.toISOString(),
    },
    baseCtx(),
  );
  assert.ok(!("session" in res), "gcal success must not set session");
  const st = afterObserve(res, res.items.length);
  assert.ok(st.lastOkAt, "gcal readOk must stamp lastOkAt even with 0 items");
  assert.equal(st.itemCount, 0);
  assert.equal(st.complete, true);
});

test("observe status: a successful outline read carries no session and stamps counters", async () => {
  const body = fs.readFileSync(path.join(HERE, "..", "fixtures", "outline", "MATH117.html"), "utf8");
  const res = await outline.observe.parse(
    {
      source: "outline",
      kind: "dom",
      url: "https://outline.uwaterloo.ca/viewer/view/math117",
      body,
      at: NOW.toISOString(),
    },
    baseCtx({
      settings: { sections: { "MATH 117": ["LEC 001"] } },
      async parseHtml(docHtml, parser) {
        assert.equal(parser, "outline/parseOutline");
        return parseOutline(parseHTML(docHtml).document);
      },
    }),
  );
  assert.ok(res.items.length > 0);
  assert.ok(!("session" in res), "outline success must not set session");
  const st = afterObserve(res, res.items.length);
  assert.ok(st.lastOkAt);
  assert.equal(st.itemCount, res.items.length);
});

test("observe status: signed-out results still report the session", async () => {
  const res = await portal.observe.parse(
    {
      source: "portal",
      kind: "net",
      url: "https://portalapi2.uwaterloo.ca/v2/student/CourseSchedule/",
      method: "GET",
      status: 401,
      contentType: "application/json",
      body: "{}",
      at: NOW.toISOString(),
    },
    baseCtx(),
  );
  assert.equal(res.session, "signed-out");
});
