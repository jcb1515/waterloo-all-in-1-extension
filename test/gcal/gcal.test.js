// @ts-check
// Google Calendar reader: DOM extracts on synthetic fixtures, observe.parse
// rolling-state behaviour, and the no-network static rules.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import adapter from "../../extension/src/sources/gcal/index.js";
import {
  decodeCalId,
  gcalExtract,
  gcalView,
  kindOf,
  parseChipLabel,
} from "../../extension/src/sources/gcal/dom.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "gcal");
const html = (name) => fs.readFileSync(path.join(DIR, `${name}.html`), "utf8");
const docOf = (name) => parseHTML(html(name)).document;

const NOW = new Date("2026-09-28T12:00:00.000Z");
const GC = "https://calendar.google.com/calendar/u/0/r/";
const WEEK_URL = GC + "week/2026/9/29";
const DAY_URL = GC + "day/2026/10/1";
const MONTH_URL = GC + "month/2026/10/1";
const AGENDA_URL = GC + "agenda";

const ctx = (state = {}, now = NOW) => ({
  now,
  settings: {},
  state,
  courses: [],
  terms: [],
  log: () => {},
});
const parse = (body, state = {}, now = NOW) =>
  adapter.observe.parse(
    {
      source: "gcal",
      kind: "dom",
      url: WEEK_URL,
      body: typeof body === "string" ? body : JSON.stringify(body),
      at: NOW.toISOString(),
    },
    ctx(state, now),
  );

const titles = (events) => events.map((e) => e.title);
const find = (events, t) => events.find((e) => e.title === t);

/* ------------------------------ extract ------------------------------ */

test("gcal week view: chips, kinds, range and the merged detail popup", () => {
  const ex = gcalExtract(docOf("gcal-week"), WEEK_URL, { now: NOW });
  assert.equal(ex.view, "week");
  // Sunday on/before Sep 29 = Sep 27, +7 days (Toronto midnights, ISO instants).
  assert.deepEqual(ex.range, {
    start: "2026-09-27T04:00:00.000Z",
    end: "2026-10-04T04:00:00.000Z",
  });
  assert.equal(ex.events.length, 4); // popup merged into its chip

  const chat = find(ex.events, "Chat about robotics");
  assert.equal(chat.calendarKind, "own");
  assert.equal(chat.startAt, "2026-09-29T17:00:00.000Z");
  assert.equal(chat.endAt, "2026-09-29T17:30:00.000Z");
  assert.equal(chat.allDay, false);

  const lec = find(ex.events, "ECE 105 · Lecture");
  assert.equal(lec.calendarKind, "subscribed");
  assert.equal(lec.startAt, "2026-09-30T18:30:00.000Z");
  assert.equal(lec.endAt, "2026-09-30T19:20:00.000Z");

  const tday = find(ex.events, "Thanksgiving");
  assert.equal(tday.calendarKind, "subscribed");
  assert.equal(tday.allDay, true);
  assert.equal(tday.startAt, "2026-10-12T04:00:00.000Z");
  assert.equal(tday.endAt, undefined); // single all-day: no range end

  const mystery = find(ex.events, "Mystery");
  assert.equal(mystery.calendarKind, "unknown");
  assert.equal(mystery.startAt, "2026-10-01T14:00:00.000Z");
  assert.equal(mystery.endAt, "2026-10-01T15:00:00.000Z");
});

test("gcal day view: range and the no-date fallback to the URL date", () => {
  const ex = gcalExtract(docOf("gcal-day"), DAY_URL, { now: NOW });
  assert.equal(ex.view, "day");
  assert.deepEqual(ex.range, {
    start: "2026-10-01T04:00:00.000Z",
    end: "2026-10-02T04:00:00.000Z",
  });
  const study = find(ex.events, "Study group");
  assert.equal(study.calendarKind, "own");
  assert.equal(study.startAt, "2026-10-01T13:00:00.000Z");
  assert.equal(study.endAt, "2026-10-01T14:00:00.000Z");
  const office = find(ex.events, "Office hour"); // label has no date -> Oct 1
  assert.equal(office.startAt, "2026-10-01T15:00:00.000Z");
  assert.equal(office.endAt, "2026-10-01T16:00:00.000Z");
});

test("gcal month view: 42-day range, descendant label, all-day date range", () => {
  const ex = gcalExtract(docOf("gcal-month"), MONTH_URL, { now: NOW });
  assert.equal(ex.view, "month");
  // Sunday on/before Oct 1 = Sep 27; +42 days = Nov 8 (after the DST flip).
  assert.deepEqual(ex.range, {
    start: "2026-09-27T04:00:00.000Z",
    end: "2026-11-08T05:00:00.000Z",
  });
  const dinner = find(ex.events, "Dinner");
  assert.equal(dinner.calendarKind, "subscribed");
  assert.equal(dinner.startAt, "2026-10-02T22:00:00.000Z");
  const hack = find(ex.events, "Hackathon week");
  assert.equal(hack.allDay, true);
  assert.equal(hack.startAt, "2026-10-05T04:00:00.000Z");
  assert.equal(hack.endAt, "2026-10-10T04:00:00.000Z"); // exclusive
});

test("gcal schedule view: chips parse, range is null", () => {
  const ex = gcalExtract(docOf("gcal-schedule"), AGENDA_URL, { now: NOW });
  assert.equal(ex.view, "schedule");
  assert.equal(ex.range, null);
  assert.equal(ex.events.length, 1);
  assert.equal(ex.events[0].calendarKind, "own");
  assert.equal(ex.events[0].startAt, "2026-09-29T17:00:00.000Z");
});

test("gcal @m shorthand maps to the signed-in gmail address", () => {
  const ex = gcalExtract(docOf("gcal-shortid"), DAY_URL, { now: NOW });
  const gym = find(ex.events, "Gym");
  assert.equal(gym.calendarKind, "own");
  assert.equal(gym.startAt, "2026-10-01T12:00:00.000Z");
});

test("gcal view parsing: customweek, missing date, other, bad hosts", () => {
  const doc = docOf("gcal-day");
  assert.equal(gcalExtract(doc, GC + "customweek/2026/9/29", { now: NOW }).view, "week");
  const today = gcalExtract(doc, GC + "day", { now: NOW });
  assert.equal(today.view, "day");
  assert.equal(today.range.start.slice(0, 10), "2026-09-28"); // now's Toronto date
  assert.equal(gcalExtract(doc, GC + "settings", { now: NOW }).view, "other");
  assert.equal(gcalExtract(doc, "https://example.com/x", { now: NOW }).view, "other");
  assert.equal(gcalExtract(doc, "https://example.com/x", { now: NOW }).events.length, 0);
});

test("gcal label/date/id units", () => {
  // Timed range, overnight roll.
  const p = parseChipLabel("10pm to 1am, Late thing, October 1, 2026");
  assert.equal(p.startAt, "2026-10-02T02:00:00.000Z"); // 22:00 EDT
  assert.equal(p.endAt, "2026-10-02T05:00:00.000Z");
  // Cross-month all-day range.
  const r = parseChipLabel("All day, Reading week, September 28 – October 2, 2026");
  assert.equal(r.startAt, "2026-09-28T04:00:00.000Z");
  assert.equal(r.endAt, "2026-10-03T04:00:00.000Z");
  // Unparseable prefixes are skipped.
  assert.equal(parseChipLabel("Focus time"), null);
  assert.equal(parseChipLabel("1pm, No range, October 1, 2026"), null);
  assert.equal(parseChipLabel(""), null);

  assert.equal(decodeCalId("!!!notbase64"), "");
  assert.equal(decodeCalId("ZXZ0MDAxIGphbmUuc3R1ZGVudEBleGFtcGxlLmNvbQ"), "jane.student@example.com");
  assert.equal(decodeCalId(""), "");
  assert.equal(decodeCalId(Buffer.from("evtonly").toString("base64")), "");

  assert.equal(kindOf("jane.student@example.com", "jane.student@example.com"), "own");
  assert.equal(kindOf("jane.student@m", "jane.student@gmail.com"), "own");
  assert.equal(kindOf("abcd1234@group.calendar.google.com", "jane.student@example.com"), "own");
  assert.equal(kindOf("feed123@import.calendar.google.com", "jane.student@example.com"), "subscribed");
  assert.equal(kindOf("en.canadian#holiday@group.v.calendar.google.com", "jane.student@example.com"), "subscribed");
  assert.equal(kindOf("friend@example.org", "jane.student@example.com"), "subscribed");
  assert.equal(kindOf("", "jane.student@example.com"), "unknown");
});

test("gcal extract never leaks names, owners, locations or addresses", () => {
  for (const name of ["gcal-week", "gcal-day", "gcal-month", "gcal-schedule", "gcal-shortid"]) {
    const ex = gcalExtract(docOf(name), WEEK_URL, { now: NOW });
    const blob = JSON.stringify(ex);
    for (const s of [
      "jane.student@example.com",
      "jane.student@gmail.com",
      "Jane Student",
      "Friend Name",
      "Microsoft Teams",
      "Accepted",
      "Waterloo All-in-1",
      "@",
    ]) {
      assert.ok(!blob.includes(s), `${name} leaked ${s}`);
    }
  }
});

/* --------------------------- observe.parse --------------------------- */

test("observe.parse keeps rolling state; a re-read range deletes", async () => {
  const week = gcalExtract(docOf("gcal-week"), WEEK_URL, { now: NOW });
  const res1 = await parse(week);
  assert.equal(res1.complete, true);
  assert.equal(res1.scope, "gcal");
  assert.deepEqual(res1.readOk, ["gcal"]);
  assert.equal(res1.items.length, 0);
  assert.ok(find(res1.state.events, "Mystery"));
  assert.equal(res1.state.lastSeenAt, NOW.toISOString());

  // Same week re-read with Mystery gone: its range deletes, others keep.
  const week2 = { ...week, events: week.events.filter((e) => e.title !== "Mystery") };
  const res2 = await parse(week2, res1.state);
  assert.ok(!find(res2.state.events, "Mystery"));
  assert.ok(find(res2.state.events, "Chat about robotics"));
  assert.ok(find(res2.state.events, "Thanksgiving")); // outside the range, kept

  // A different range (the day view) merges instead of wiping everything.
  const day = gcalExtract(docOf("gcal-day"), DAY_URL, { now: NOW });
  const res3 = await parse(day, res2.state);
  assert.ok(find(res3.state.events, "Study group"));
  assert.ok(find(res3.state.events, "Chat about robotics"));
  assert.ok(!find(res3.state.events, "Mystery"));

  // A null range (schedule view) never deletes.
  const sched = gcalExtract(docOf("gcal-schedule"), AGENDA_URL, { now: NOW });
  const res4 = await parse(sched, res3.state);
  assert.deepEqual(titles(res4.state.events).sort(), titles(res3.state.events).sort());
});

test("observe.parse drops events outside the [now-1d, now+60d] window", async () => {
  const mk = (t, at, extra = {}) => ({
    title: t,
    startAt: at,
    allDay: false,
    calendarKind: "own",
    ...extra,
  });
  const res = await parse({
    v: 1,
    view: "week",
    range: null,
    events: [
      mk("too old", "2026-09-26T11:59:00.000Z"), // before now-1d
      mk("edge old", "2026-09-27T12:00:00.000Z"),
      mk("edge new", "2026-11-27T12:00:00.000Z"),
      mk("too far", "2026-11-27T12:01:00.000Z"),
      mk("bad kind", "2026-10-01T12:00:00.000Z", { calendarKind: "nope" }),
      mk("", "2026-10-01T12:00:00.000Z"),
      { startAt: "not a date", allDay: false, calendarKind: "own" },
      "garbage",
    ],
  });
  assert.deepEqual(titles(res.state.events).sort(), ["edge new", "edge old"]);
});

test("observe.parse dedupes title+startAt preferring own", async () => {
  const res = await parse({
    v: 1,
    view: "week",
    range: null,
    events: [
      { title: "Dup", startAt: "2026-10-01T14:00:00.000Z", allDay: false, calendarKind: "subscribed" },
      { title: "dup", startAt: "2026-10-01T14:00:00.000Z", allDay: false, calendarKind: "own" },
      { title: "DUP", startAt: "2026-10-01T14:00:00.000Z", allDay: false, calendarKind: "unknown" },
    ],
  });
  assert.equal(res.state.events.length, 1);
  assert.equal(res.state.events[0].calendarKind, "own");
});

test("observe.parse caps at 500, nearest to now first", async () => {
  const events = [];
  for (let i = -10; i < 590; i++) {
    events.push({
      title: `e${i}`,
      startAt: new Date(NOW.getTime() + i * 2 * 3600e3).toISOString(),
      allDay: false,
      calendarKind: "own",
    });
  }
  const res = await parse({ v: 1, view: "week", range: null, events });
  assert.equal(res.state.events.length, 500);
  assert.ok(find(res.state.events, "e0")); // nearest survives
  assert.ok(!find(res.state.events, "e589")); // farthest dropped
  const sorted = res.state.events.map((e) => e.startAt);
  assert.deepEqual(sorted, [...sorted].sort());
});

test("observe.parse fails soft on bad JSON and non-objects", async () => {
  const prev = { events: [{ title: "keep", startAt: "2026-10-01T14:00:00.000Z", allDay: false, calendarKind: "own" }] };
  const res = await parse("{not json", prev);
  assert.equal(res.complete, false);
  assert.equal(res.scope, "gcal");
  assert.equal(res.state, prev);
  const res2 = await parse("[1,2,3]", prev);
  assert.equal(res2.complete, false);
  assert.equal(res2.state, prev);
});

test("gcal adapter shape", async () => {
  assert.equal(adapter.id, "gcal");
  assert.equal(adapter.intervalMinutes, 0);
  assert.deepEqual(adapter.observe.urlPatterns, []);
  const res = await adapter.sync(ctx({ x: 1 }));
  assert.equal(res.complete, false);
  assert.equal(res.session, "no-tab");
});

/* ------------------------------ static ------------------------------ */

test("gcal sources contain no forbidden APIs", () => {
  const SRC = path.resolve(DIR, "..", "..", "..", "extension", "src", "sources", "gcal");
  const FORBIDDEN = [
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /\bWebSocket\b/,
    /localStorage/,
    /sessionStorage/,
    /document\.cookie/,
    /webpackChunk/,
    /\.click\s*\(/,
    /location\.assign/,
    /location\.href\s*=(?![=])/,
    /location\.replace\s*\(/,
    /history\.pushState/,
  ];
  for (const file of [
    "content.js",
    "dom.js",
    "index.js",
    "probe.js",
    "parsers.js",
    "selectors.js",
  ]) {
    const src = fs.readFileSync(path.join(SRC, file), "utf8");
    for (const re of FORBIDDEN) {
      assert.equal(re.test(src), false, `${file} contains ${re}`);
    }
  }
});
