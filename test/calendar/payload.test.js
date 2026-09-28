// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { buildFeedPayload, stableHash } from "../../extension/src/calendar/payload.js";

const NOW = new Date("2026-10-01T16:00:00.000Z");
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

const CAL = {
  enabled: true,
  serviceUrl: "https://x.workers.dev",
  split: false,
  include: { classes: true, tentative: true, completed: true, termDates: true },
  alarms: false,
};

const mk = (id, over = {}) => ({
  id,
  source: "learn",
  type: "deadline",
  title: id,
  status: "open",
  confidence: "exact",
  review: "auto",
  dueAt: iso(NOW.getTime() + DAY),
  ...over,
});

const build = (items, userState = {}, cal = CAL) =>
  buildFeedPayload(items, userState, cal, NOW);

test("envelope shape and basic event fields", () => {
  const { payload, count, trimmed } = build({
    a: mk("learn:1", {
      org: "ECE 105",
      url: "https://learn.uwaterloo.ca/x",
      location: "MC 4020",
      section: "LEC 002",
      weight: 15,
      details: "Covers weeks 1-6",
      calendar: { uid: "learn-1@waterloo-all-in-1", seq: 3 },
      seenIn: [{ source: "learn" }, { source: "outline" }, { source: "learn" }],
    }),
  });
  assert.equal(count, 1);
  assert.equal(trimmed, false);
  assert.equal(payload.version, 2);
  assert.equal(payload.calendarName, "Waterloo All-in-1");
  assert.equal(payload.timeZone, "America/Toronto");
  const ev = payload.events[0];
  assert.equal(ev.id, "learn:1");
  assert.equal(ev.calendar.uid, "learn-1@waterloo-all-in-1");
  assert.equal(ev.calendar.seq, 3);
  assert.deepEqual(ev.seenIn, [{ source: "learn" }, { source: "outline" }]);
  assert.equal(ev.status, "open");
  assert.equal(ev.details, "Covers weeks 1-6");
  assert.equal(payload.alarms, undefined);
});

test("exclusions: review, hidden, cancelled, undated, stale", () => {
  const items = {
    keep: mk("keep"),
    pend: mk("pend", { review: "pending" }),
    dism: mk("dism", { review: "dismissed" }),
    hid: mk("hid"),
    canc: mk("canc", { status: "cancelled" }),
    nodate: mk("nodate", { dueAt: undefined, startAt: undefined }),
    old: mk("old", { dueAt: iso(NOW.getTime() - 61 * DAY) }),
  };
  const { payload } = build(items, { hid: { hidden: true } });
  assert.deepEqual(payload.events.map((e) => e.id), ["keep"]);
});

test("a stale window still counts endAt for the 60-day rule", () => {
  const { payload } = build({
    w: mk("w", {
      startAt: iso(NOW.getTime() - 70 * DAY),
      dueAt: undefined,
      endAt: iso(NOW.getTime() - 10 * DAY), // ended recently -> keep
      allDay: true,
    }),
  });
  assert.equal(payload.events.length, 1);
});

test("include toggles: classes / tentative / completed / termDates", () => {
  const items = {
    cls: mk("cls", { type: "class", startAt: iso(NOW.getTime() + 3600e3), dueAt: undefined }),
    tut: mk("tut", { type: "tutorial", startAt: iso(NOW.getTime() + 3600e3), dueAt: undefined }),
    tent: mk("tent", { confidence: "tentative" }),
    done1: mk("done1", { status: "done" }),
    sub: mk("sub", { status: "submitted" }),
    usdone: mk("usdone"),
    term: mk("term", { type: "term-date", startAt: iso(NOW.getTime() + DAY), dueAt: undefined, allDay: true }),
  };
  const off = (k) => ({ ...CAL, include: { ...CAL.include, [k]: false } });
  const ids = (cal, us = {}) => build(items, us, cal).payload.events.map((e) => e.id).sort();

  assert.deepEqual(ids(off("classes")), ["done1", "sub", "tent", "term", "usdone"]);
  assert.deepEqual(ids(off("tentative")), ["cls", "done1", "sub", "term", "tut", "usdone"]);
  assert.deepEqual(ids(off("completed"), { usdone: { done: true } }), ["cls", "tent", "term", "tut"]);
  assert.deepEqual(ids(off("termDates")), ["cls", "done1", "sub", "tent", "tut", "usdone"]);
  assert.deepEqual(ids(CAL, { usdone: { done: true } }).length, 7);
});

test("userState.done publishes status 'done'", () => {
  const { payload } = build({ a: mk("a") }, { a: { done: true } });
  assert.equal(payload.events[0].status, "done");
});

test("alarms flag adds the type-level table only when on", () => {
  const withAlarms = { ...CAL, alarms: true };
  const { payload } = build({ a: mk("a") }, {}, withAlarms);
  assert.deepEqual(payload.alarms.deadline, [1440, 60]);
  assert.deepEqual(payload.alarms.exam, [2880, 1440]);
  const { payload: no } = build({ a: mk("a") });
  assert.equal(no.alarms, undefined);
});

test("3000-event cap keeps the events nearest to now", () => {
  /** @type {Record<string, any>} */
  const items = {};
  for (let i = 0; i < 3100; i++) {
    // Spread anchors: index = days in the future.
    items[`i${i}`] = mk(`i${i}`, { dueAt: iso(NOW.getTime() + (i + 1) * DAY) });
  }
  const { payload, count, trimmed } = build(items);
  assert.equal(count, 3000);
  assert.equal(trimmed, true);
  const ids = new Set(payload.events.map((e) => e.id));
  assert.ok(ids.has("i0"), "nearest kept");
  assert.ok(!ids.has("i3099"), "farthest dropped");
});

test("oversized payloads: details truncated, then farthest dropped", () => {
  const big = "x".repeat(1_000_000);
  const { payload, trimmed } = build({
    a: mk("a", { details: big }),
    b: mk("b", { details: big }),
  });
  assert.equal(trimmed, true);
  assert.equal(payload.events.length, 2);
  assert.ok(payload.events[0].details.length <= 300);
  assert.ok(JSON.stringify(payload).length < 1.8 * 1024 * 1024);

  // Now force dropping: 3000 events x 800-char details stays over the limit
  // even after details truncation, so the farthest events get dropped.
  /** @type {Record<string, any>} */
  const many = {};
  for (let i = 0; i < 3000; i++) {
    many[`e${i}`] = mk(`e${i}`, {
      dueAt: iso(NOW.getTime() + i * 60000),
      details: "y".repeat(800),
      url: "https://learn.uwaterloo.ca/" + "u".repeat(400),
      location: "L".repeat(80),
    });
  }
  const r = build(many);
  assert.ok(r.count < 3000, `dropped farthest to fit (got ${r.count})`);
  assert.ok(JSON.stringify(r.payload).length < 1.8 * 1024 * 1024);
  // The dropped events are the farthest out.
  const kept = new Set(r.payload.events.map((e) => e.id));
  assert.ok(kept.has("e0") && !kept.has("e2999"));
});

test("events carry facts: meta.facts pass through, Type/Group derived", () => {
  const { payload } = build({
    a: mk("a", {
      type: "exam",
      category: "final",
      dueAt: undefined,
      startAt: iso(NOW.getTime() + DAY),
      group: "5",
      meta: {
        facts: [
          { label: "Room", value: "PAC 1-12" },
          { label: "Instructions", value: "Bring WatCard" },
        ],
      },
    }),
    b: mk("b", { type: "tutorial", startAt: iso(NOW.getTime() + 3600e3), dueAt: undefined }),
    c: mk("c"), // a plain deadline — no Type fact
  });
  const ev = (id) => payload.events.find((e) => e.id === id);
  assert.deepEqual(ev("a").facts, [
    { label: "Room", value: "PAC 1-12" },
    { label: "Instructions", value: "Bring WatCard" },
    { label: "Type", value: "Final exam" },
    { label: "Group", value: "5" },
  ]);
  assert.deepEqual(ev("b").facts, [{ label: "Type", value: "Tutorial" }]);
  assert.equal(ev("c").facts, undefined);
});

test("facts dedupe by label case-insensitively, clamp, and cap at 12", () => {
  const facts = [
    { label: "Type", value: "Technical interview" }, // the source's own Type wins
    { label: "room", value: "MC 2035" },
    { label: "Room", value: "duplicate" },
    { label: "L".repeat(60), value: "v".repeat(400) },
    ...Array.from({ length: 14 }, (_, i) => ({ label: `F${i}`, value: "v" })),
  ];
  const { payload } = build({ a: mk("a", { type: "interview", meta: { facts } }) });
  const ev = payload.events[0];
  assert.equal(ev.facts.length, 12);
  assert.equal(ev.facts[0].value, "Technical interview");
  assert.ok(!ev.facts.some((f) => /duplicate/.test(f.value)));
  assert.ok(ev.facts.every((f) => f.label.length <= 40 && f.value.length <= 300));
});

test("classes publish only inside [now − 7d, now + classWeeks]", () => {
  const cls = (id, days) =>
    mk(id, { type: "class", startAt: iso(NOW.getTime() + days * DAY), dueAt: undefined });
  const items = {
    pastEdge: cls("pastEdge", -7), // exactly a week back — inside
    past8: cls("past8", -8),
    in8w: cls("in8w", 55),
    edge: cls("edge", 56), // exactly 8 weeks — inside
    out8w: cls("out8w", 57),
    far: mk("far", { dueAt: iso(NOW.getTime() + 200 * DAY) }), // not a class: no cap
  };
  const ids = (cal) =>
    build(items, {}, cal).payload.events.map((e) => e.id).sort();
  assert.deepEqual(ids(CAL), ["edge", "far", "in8w", "pastEdge"]);
  const cal4 = { ...CAL, include: { ...CAL.include, classWeeks: 4 } };
  assert.deepEqual(ids(cal4), ["far", "pastEdge"]);
  // include.classes: false still drops all of them.
  const off = { ...CAL, include: { ...CAL.include, classes: false } };
  assert.deepEqual(ids(off), ["far"]);
});

test("class uids stay stable as the window slides", () => {
  const it = mk("c", {
    type: "class",
    startAt: iso(NOW.getTime() + 50 * DAY),
    dueAt: undefined,
    calendar: { uid: "c@wa1", seq: 0 },
  });
  const before = build({ c: it });
  assert.equal(before.payload.events[0].calendar.uid, "c@wa1");
  // Seven weeks on, the same class is one day ahead — same uid.
  const later = build({ c: it }, {}, CAL, new Date(NOW.getTime() + 49 * DAY));
  assert.equal(later.payload.events[0].calendar.uid, "c@wa1");
});

test("project exclusions: calendar off, archived project, per-item opt-out", () => {
  const items = {
    on: mk("on", { source: "manual", title: "Paint the banner", meta: { projectId: "p_on" } }),
    off: mk("off", { source: "manual", title: "Book the venue", meta: { projectId: "p_off" } }),
    arch: mk("arch", { source: "manual", title: "Order stickers", meta: { projectId: "p_arch" } }),
    itemOff: mk("itemOff", {
      source: "manual",
      title: "Rehearse the pitch",
      meta: { projectId: "p_on", calendar: false },
    }),
    plain: mk("plain", { title: "Return the ladder" }),
  };
  const projects = [
    { id: "p_on", name: "On", status: "active", calendar: true },
    { id: "p_off", name: "Off", status: "active", calendar: false },
    { id: "p_arch", name: "Archived", status: "archived", calendar: true },
  ];
  const { payload } = buildFeedPayload(items, {}, CAL, NOW, { projects });
  assert.deepEqual(payload.events.map((e) => e.id).sort(), ["on", "plain"]);
  // Without the projects arg nothing project-scoped is excluded — but the
  // per-item meta.calendar flag applies either way.
  const all = buildFeedPayload(items, {}, CAL, NOW);
  assert.deepEqual(all.payload.events.map((e) => e.id).sort(), ["arch", "off", "on", "plain"]);
});

test("stableHash is key-order independent", () => {
  const a = { version: 2, events: [{ id: "x", title: "T" }], timeZone: "America/Toronto" };
  const b = { timeZone: "America/Toronto", events: [{ title: "T", id: "x" }], version: 2 };
  assert.equal(stableHash(a), stableHash(b));
  assert.notEqual(stableHash(a), stableHash({ ...a, calendarName: "Other" }));
});
