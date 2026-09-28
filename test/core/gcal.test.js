// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import {
  suppressAgainstCalendar,
  gcalOwnEvents,
} from "../../extension/src/core/gcal.js";

const NOW = new Date("2026-10-01T16:00:00.000Z");

const item = (id, over = {}) => ({
  id,
  source: "learn",
  type: "meeting",
  title: "Design review",
  org: "WATonomous",
  startAt: "2026-10-01T18:00:00.000Z",
  ...over,
});

const ev = (over = {}) => ({
  title: "Design review",
  startAt: "2026-10-01T18:00:00.000Z",
  allDay: false,
  calendarKind: "own",
  ...over,
});

const marked = (items) =>
  Object.values(items).filter((i) => i.meta && i.meta.onCalendar === "google");

test("an own event within 5 minutes suppresses the matching item", () => {
  const items = { a: item("a") };
  const out = suppressAgainstCalendar(items, [ev({ startAt: "2026-10-01T18:03:00.000Z" })], NOW);
  assert.equal(marked(out).length, 1);
  assert.equal(out.a.meta.onCalendar, "google");
  // input untouched
  assert.equal(items.a.meta, undefined);
});

test("matching against '<org> <title>' also suppresses", () => {
  const items = { a: item("a") };
  const out = suppressAgainstCalendar(items, [ev({ title: "WATonomous Design review" })], NOW);
  assert.equal(marked(out).length, 1);
});

test("a subscribed event suppresses — but never our own feed", () => {
  const items = { a: item("a") };
  // Another subscribed calendar (UW Flow export etc.) is real evidence the
  // thing is already on the calendar.
  const sub = ev({ title: "WATonomous Design review", calendarKind: "subscribed" });
  assert.equal(marked(suppressAgainstCalendar(items, [sub], NOW)).length, 1);
  // …but a wa1 event — our own feed's republish — never suppresses, no
  // matter how it was classified when stored.
  const feed = ev({ title: "WATonomous Design review", calendarKind: "wa1" });
  assert.equal(marked(suppressAgainstCalendar(items, [feed], NOW)).length, 0);
  const feedByTitle = ev({ title: "ECE 105 · Lecture", calendarKind: "subscribed" });
  const itemEv = { a: item("a", { title: "Lecture", org: "ECE 105", type: "class" }) };
  assert.equal(marked(suppressAgainstCalendar(itemEv, [feedByTitle], NOW)).length, 0);
});

test("an unknown-kind event never suppresses", () => {
  const items = { a: item("a") };
  assert.equal(
    marked(suppressAgainstCalendar(items, [ev({ calendarKind: "unknown" })], NOW)).length,
    0,
  );
});

test("gcalOwnEvents keeps suppressible events (own + subscribed, never wa1)", () => {
  const sourceState = {
    gcal: {
      state: {
        events: [
          ev({ title: "mine" }),
          ev({ title: "sub", calendarKind: "subscribed" }),
          ev({ title: "ECE 105 · Lecture", calendarKind: "subscribed" }), // wa1 title
          ev({ title: "feed", calendarKind: "wa1" }),
          ev({ title: "unk", calendarKind: "unknown" }),
        ],
      },
    },
  };
  const kept = gcalOwnEvents(sourceState);
  assert.deepEqual(kept.map((e) => e.title), ["mine", "sub"]);
  assert.deepEqual(gcalOwnEvents({}), []);
  assert.deepEqual(gcalOwnEvents({ gcal: { state: {} } }), []);
});

test("the 5-minute window is inclusive; 6 minutes does not suppress", () => {
  const items = { a: item("a") };
  const at5 = suppressAgainstCalendar(items, [ev({ startAt: "2026-10-01T18:05:00.000Z" })], NOW);
  assert.equal(marked(at5).length, 1);
  const at6 = suppressAgainstCalendar(items, [ev({ startAt: "2026-10-01T18:06:00.000Z" })], NOW);
  assert.equal(marked(at6).length, 0);
  const before5 = suppressAgainstCalendar(items, [ev({ startAt: "2026-10-01T17:55:00.000Z" })], NOW);
  assert.equal(marked(before5).length, 1);
});

test("all-day event matches the same Toronto date, not the next one", () => {
  const items = { a: item("a", { allDay: true, dueAt: "2026-10-02T03:59:00.000Z", startAt: undefined }) };
  const sameDay = suppressAgainstCalendar(
    items,
    // Oct 1 all-day Toronto = 2026-10-01T04:00Z
    [ev({ allDay: true, startAt: "2026-10-01T04:00:00.000Z" })],
    NOW,
  );
  // item dueAt 2026-10-02T03:59Z is still Oct 1 in Toronto -> suppressed
  assert.equal(marked(sameDay).length, 1);
  const nextDay = suppressAgainstCalendar(
    items,
    [ev({ allDay: true, startAt: "2026-10-02T04:00:00.000Z" })],
    NOW,
  );
  assert.equal(marked(nextDay).length, 0);
});

test("a second pass without the event leaves the item unmarked (un-suppress)", () => {
  const items = { a: item("a") };
  const suppressed = suppressAgainstCalendar(items, [ev()], NOW);
  assert.equal(marked(suppressed).length, 1);
  const recomputeInput = { a: item("a") };
  const unsuppressed = suppressAgainstCalendar(recomputeInput, [], NOW);
  assert.equal(marked(unsuppressed).length, 0);
  assert.equal(unsuppressed, recomputeInput);
});

test("a different title at the same time does not suppress", () => {
  const items = { a: item("a") };
  const out = suppressAgainstCalendar(items, [ev({ title: "Dental appointment" })], NOW);
  assert.equal(marked(out).length, 0);
});

test("manual items, project items and derived to-dos are never suppressed", () => {
  const items = {
    manual: item("manual", { source: "manual" }),
    proj: item("proj", { source: "manual", meta: { projectId: "proj_1" } }),
    derived: item("derived", { meta: { auto: "study" } }),
    src: item("src"),
  };
  const out = suppressAgainstCalendar(items, [ev()], NOW);
  assert.equal(marked(out).length, 1);
  assert.equal(out.src.meta.onCalendar, "google");
  assert.equal(out.manual.meta, undefined);
  assert.equal(out.derived.meta.onCalendar, undefined);
});

test("an item already marked onCalendar keeps its mark", () => {
  const items = { a: item("a", { meta: { onCalendar: "google" } }) };
  const out = suppressAgainstCalendar(items, [ev()], NOW);
  assert.equal(out, items);
});

/* ---------------- course-code + component matching -------------------- */

const classItem = (id, over = {}) =>
  item(id, {
    source: "outline",
    type: "class",
    title: "Lecture",
    org: "ECE 105",
    startAt: "2026-10-06T14:30:00.000Z",
    endAt: "2026-10-06T15:50:00.000Z",
    ...over,
  });

test("live shape: 'ECE 105 LEC - Classical Mechanics' suppresses a class item", () => {
  const items = { a: classItem("a") };
  const out = suppressAgainstCalendar(
    items,
    [ev({ title: "ECE 105 LEC - Classical Mechanics", startAt: "2026-10-06T14:30:00.000Z" })],
    NOW,
  );
  assert.equal(marked(out).length, 1);
});

test("UW Flow shape: 'ECE105 - LEC 001' suppresses; subscribed counts", () => {
  const items = { a: classItem("a") };
  const out = suppressAgainstCalendar(
    items,
    [
      ev({
        title: "ECE105 - LEC 001",
        startAt: "2026-10-06T14:30:00.000Z",
        calendarKind: "subscribed",
      }),
    ],
    NOW,
  );
  assert.equal(marked(out).length, 1);
});

test("Quest-exporter shape: 'ECE 105 - LEC 001 - Classroom' suppresses", () => {
  const items = { a: classItem("a") };
  const out = suppressAgainstCalendar(
    items,
    [ev({ title: "ECE 105 - LEC 001 - Classroom", startAt: "2026-10-06T14:33:00.000Z" })],
    NOW,
  );
  assert.equal(marked(out).length, 1);
});

test("same time, different course: no suppression", () => {
  const items = { a: classItem("a") };
  const out = suppressAgainstCalendar(
    items,
    [ev({ title: "MATH 117 LEC - Calculus", startAt: "2026-10-06T14:30:00.000Z" })],
    NOW,
  );
  assert.equal(marked(out).length, 0);
});

test("same course, LEC event vs TUT item: no suppression", () => {
  const items = {
    a: classItem("a", { type: "tutorial", title: "Tutorial" }),
  };
  const out = suppressAgainstCalendar(
    items,
    [ev({ title: "ECE 105 LEC - Classical Mechanics", startAt: "2026-10-06T14:30:00.000Z" })],
    NOW,
  );
  assert.equal(marked(out).length, 0);
  // …but the same item does match a TUT event.
  const tut = suppressAgainstCalendar(
    items,
    [ev({ title: "ECE 105 TUT - Classical Mechanics", startAt: "2026-10-06T14:30:00.000Z" })],
    NOW,
  );
  assert.equal(marked(tut).length, 1);
});

test("a class item with no component word on the event still matches", () => {
  const items = { a: classItem("a") };
  const out = suppressAgainstCalendar(
    items,
    [ev({ title: "ECE 105 - Classical Mechanics", startAt: "2026-10-06T14:30:00.000Z" })],
    NOW,
  );
  assert.equal(marked(out).length, 1);
});

test("an exam item needs an exam word or TST on the event", () => {
  const items = {
    a: classItem("a", {
      type: "exam",
      title: "Final",
      org: "ECE 105",
      startAt: "2026-12-10T19:30:00.000Z",
      endAt: "2026-12-10T22:00:00.000Z",
    }),
  };
  const finals = suppressAgainstCalendar(
    items,
    [ev({ title: "ECE105 - FINAL", startAt: "2026-12-10T19:30:00.000Z" })],
    NOW,
  );
  assert.equal(marked(finals).length, 1);
  const lec = suppressAgainstCalendar(
    items,
    [ev({ title: "ECE 105 LEC - Classical Mechanics", startAt: "2026-12-10T19:30:00.000Z" })],
    NOW,
  );
  assert.equal(marked(lec).length, 0);
});

test("deadline vs 'ECE 150 | Assignment 3 due' — timed and all-day", () => {
  const dl = (over = {}) =>
    item("a", {
      source: "outline",
      type: "deadline",
      title: "Assignment 3",
      org: "ECE 150",
      dueAt: "2026-10-16T03:59:00.000Z",
      startAt: undefined,
      ...over,
    });
  // Timed: Oct 15 11:59 PM Toronto vs the item's 23:59 due.
  const timed = suppressAgainstCalendar(
    { a: dl() },
    [ev({ title: "ECE 150 | Assignment 3 due", startAt: "2026-10-16T03:58:00.000Z" })],
    NOW,
  );
  assert.equal(marked(timed).length, 1);
  // All-day event on the same Toronto day also matches.
  const allDay = suppressAgainstCalendar(
    { a: dl() },
    [
      ev({
        title: "ECE 150 | Assignment 3 due",
        startAt: "2026-10-15T04:00:00.000Z",
        allDay: true,
      }),
    ],
    NOW,
  );
  assert.equal(marked(allDay).length, 1);
  // A different assessment number does not.
  const wrongNum = suppressAgainstCalendar(
    { a: dl() },
    [ev({ title: "ECE 150 | Assignment 4 due", startAt: "2026-10-16T03:58:00.000Z" })],
    NOW,
  );
  assert.equal(marked(wrongNum).length, 0);
  // Nor a different kind at the same instant.
  const wrongKind = suppressAgainstCalendar(
    { a: dl() },
    [ev({ title: "ECE 150 | Quiz 3", startAt: "2026-10-16T03:58:00.000Z" })],
    NOW,
  );
  assert.equal(marked(wrongKind).length, 0);
});

test("a wa1 feed event never suppresses the class it republishes", () => {
  const items = { a: classItem("a") };
  const feed = ev({ title: "ECE 105 · Lecture", calendarKind: "wa1", startAt: "2026-10-06T14:30:00.000Z" });
  assert.equal(marked(suppressAgainstCalendar(items, [feed], NOW)).length, 0);
  // …even when stored under the old "subscribed" kind.
  const legacy = ev({ title: "ECE 105 · Lecture", calendarKind: "subscribed", startAt: "2026-10-06T14:30:00.000Z" });
  assert.equal(marked(suppressAgainstCalendar(items, [legacy], NOW)).length, 0);
});

test("an event titled exactly our feed summary never suppresses (renamed feed)", () => {
  // The user can rename the calendar — label and title-shape checks can
  // both miss, so a non-own event whose title equals the item's feed
  // summary is treated as our own republish.
  const items = { a: classItem("a") };
  const renamed = ev({
    title: "ECE 105 · Lecture",
    calendarKind: "subscribed",
    startAt: "2026-10-06T14:30:00.000Z",
  });
  assert.equal(marked(suppressAgainstCalendar(items, [renamed], NOW)).length, 0);
  // "✓ " and "Cancelled: " prefixed summaries count too (they dodge the
  // leading-code title regex).
  const done = ev({
    title: "✓ ECE 105 · Lecture",
    calendarKind: "subscribed",
    startAt: "2026-10-06T14:30:00.000Z",
  });
  assert.equal(marked(suppressAgainstCalendar(items, [done], NOW)).length, 0);
  const cancel = ev({
    title: "Cancelled: ECE 105 · Lecture",
    calendarKind: "unknown",
    startAt: "2026-10-06T14:30:00.000Z",
  });
  assert.equal(marked(suppressAgainstCalendar(items, [cancel], NOW)).length, 0);
  // A no-org item published as its bare title: a subscribed twin is the
  // feed copy, not independent evidence (accepted loss).
  const rw = {
    a: item("a", {
      title: "Reading week",
      org: "",
      dueAt: "2026-10-12T04:00:00.000Z",
      startAt: undefined,
      allDay: true,
    }),
  };
  const feedRw = ev({
    title: "Reading week",
    calendarKind: "subscribed",
    startAt: "2026-10-12T04:00:00.000Z",
    allDay: true,
  });
  assert.equal(marked(suppressAgainstCalendar(rw, [feedRw], NOW)).length, 0);
  // …but the same title on the user's OWN calendar still suppresses —
  // that's genuinely the user's event.
  const ownRw = ev({ title: "Reading week", startAt: "2026-10-12T04:00:00.000Z", allDay: true });
  assert.equal(marked(suppressAgainstCalendar(rw, [ownRw], NOW)).length, 1);
});
