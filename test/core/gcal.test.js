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

test("a subscribed event never suppresses — including our own feed's import", () => {
  const items = { a: item("a") };
  const feed = ev({ title: "WATonomous Design review", calendarKind: "subscribed" });
  assert.equal(marked(suppressAgainstCalendar(items, [feed], NOW)).length, 0);
});

test("an unknown-kind event never suppresses", () => {
  const items = { a: item("a") };
  assert.equal(
    marked(suppressAgainstCalendar(items, [ev({ calendarKind: "unknown" })], NOW)).length,
    0,
  );
});

test("gcalOwnEvents filters to own only", () => {
  const sourceState = {
    gcal: {
      state: {
        events: [
          ev({ title: "mine" }),
          ev({ title: "sub", calendarKind: "subscribed" }),
          ev({ title: "unk", calendarKind: "unknown" }),
        ],
      },
    },
  };
  const own = gcalOwnEvents(sourceState);
  assert.equal(own.length, 1);
  assert.equal(own[0].title, "mine");
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
