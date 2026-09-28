// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import {
  snoozeUntil,
  fmtEstimate,
  estimateSumMin,
  primaryLink,
  hiddenSnoozed,
  sourceLabel,
  calendarState,
  calendarReasonText,
  todoState,
} from "../../extension/src/panel/model/itemsheet.js";
import { buildAgenda } from "../../extension/src/panel/model/agenda.js";

const HOUR = 3600000;

/* ------------------------------- snooze ---------------------------------- */

test("snooze hour is a plain +60min shift", () => {
  const now = new Date("2026-10-31T15:00:00.000Z"); // 11 AM EDT
  assert.equal(
    snoozeUntil("hour", now),
    new Date(now.getTime() + HOUR).toISOString(),
  );
});

test("snooze evening targets tonight 8 PM Toronto, rolling past it", () => {
  // Sat Oct 31 2026, 11:00 EDT -> tonight 20:00 EDT = Nov 1 00:00Z.
  const now = new Date("2026-10-31T15:00:00.000Z");
  assert.equal(snoozeUntil("evening", now), "2026-11-01T00:00:00.000Z");
  // 21:30 EDT -> tomorrow (Nov 1) 20:00 EST = Nov 2 01:00Z (fell back).
  const late = new Date("2026-11-01T01:30:00.000Z");
  assert.equal(snoozeUntil("evening", late), "2026-11-02T01:00:00.000Z");
});

test("snooze morning/monday stay at wall-clock 8 AM across the fall-back", () => {
  // Sat Oct 31 2026, 11:00 EDT. Nov 1 is the DST fall-back day.
  const now = new Date("2026-10-31T15:00:00.000Z");
  // Tomorrow 8 AM: Nov 1 08:00 EST = 13:00Z (not 12:00Z — offset changed).
  assert.equal(snoozeUntil("morning", now), "2026-11-01T13:00:00.000Z");
  // Next Monday: Nov 2 08:00 EST = 13:00Z.
  assert.equal(snoozeUntil("monday", now), "2026-11-02T13:00:00.000Z");
  // On a Monday, "Monday 8 AM" means the following week.
  const mon = new Date("2026-11-02T15:00:00.000Z"); // Mon Nov 2, 10:00 EST
  assert.equal(snoozeUntil("monday", mon), "2026-11-09T13:00:00.000Z");
  assert.equal(snoozeUntil("bogus", now), null);
});

/* ------------------------------ estimates ------------------------------- */

test("fmtEstimate renders compact h/m", () => {
  assert.equal(fmtEstimate(45), "45m");
  assert.equal(fmtEstimate(120), "2h");
  assert.equal(fmtEstimate(210), "3h 30m");
});

test("estimateSumMin totals open items' estimates only", () => {
  const rows = [
    { id: "a", status: "open" },
    { id: "b", status: "open" },
    { id: "c", status: "done" },
    { id: "d", status: "open" },
  ];
  const us = { a: { estimateMin: 90 }, b: { estimateMin: 120 }, c: { estimateMin: 60 } };
  assert.equal(estimateSumMin(rows, us), 210);
  assert.equal(estimateSumMin(rows, {}), 0);
});

test("buildAgenda attaches the summed estimate to each group", () => {
  const now = new Date("2026-09-27T12:00:00"); // Sunday
  const items = {
    i1: { id: "i1", title: "Quiz", type: "quiz", status: "open", dueAt: new Date(now.getTime() + HOUR).toISOString() },
    i2: { id: "i2", title: "Lab report", type: "deadline", status: "open", dueAt: new Date(now.getTime() + 2 * HOUR).toISOString() },
    i3: { id: "i3", title: "Essay", type: "deadline", status: "open", dueAt: new Date(now.getTime() + 26 * HOUR).toISOString() },
  };
  const userState = { i1: { estimateMin: 60 }, i2: { estimateMin: 150 }, i3: { estimateMin: 90 } };
  const a = buildAgenda({ items, userState, settings: {}, now });
  const today = a.groups.find((g) => g.id === "today");
  const tomorrow = a.groups.find((g) => g.id === "tomorrow");
  assert.equal(today.estMin, 210);
  assert.equal(tomorrow.estMin, 90);
});

/* ------------------------------ source link ------------------------------ */

test("primaryLink prefers url, then meta.listUrl, then evidence.url", () => {
  const base = { id: "x", source: "portal" };
  assert.equal(primaryLink(base).url, null);
  assert.equal(primaryLink(base).label, "Portal");

  const ev = { ...base, evidence: { url: "https://ev.example" } };
  assert.equal(primaryLink(ev).url, "https://ev.example");

  const list = { ...ev, meta: { listUrl: "https://list.example" } };
  assert.equal(primaryLink(list).url, "https://list.example");

  const own = { ...list, url: "https://item.example" };
  assert.equal(primaryLink(own).url, "https://item.example");
  assert.equal(sourceLabel("manual"), "Manual");
});

/* --------------------------- hidden / snoozed ---------------------------- */

test("hiddenSnoozed lists hidden and future-snoozed items", () => {
  const now = new Date("2026-09-27T12:00:00");
  const items = {
    a: { id: "a", title: "B hidden" },
    b: { id: "b", title: "A snoozed" },
    c: { id: "c", title: "C plain" },
    d: { id: "d", title: "D expired snooze" },
  };
  const us = {
    a: { hidden: true },
    b: { snoozedUntil: new Date(now.getTime() + HOUR).toISOString() },
    d: { snoozedUntil: new Date(now.getTime() - HOUR).toISOString() },
  };
  const out = hiddenSnoozed(items, us, now);
  assert.deepEqual(out.map((e) => e.item.id), ["b", "a"]);
  assert.equal(out[0].snoozedUntil !== null, true);
  assert.equal(out[1].hidden, true);
});

/* --------------------------- calendar state ------------------------------ */

const CAL_ON = {
  enabled: true,
  include: { classes: true, tentative: true, completed: true, termDates: true },
};
const CAL_STATE = { settings: { calendar: CAL_ON, review: {} }, projects: [] };
const CAL_NOW = new Date("2026-10-01T16:00:00.000Z");
const calItem = (id, over = {}) => ({
  id,
  source: "gmail",
  type: "deadline",
  title: id,
  status: "open",
  confidence: "exact",
  review: "auto",
  dueAt: new Date(CAL_NOW.getTime() + 86400000).toISOString(),
  ...over,
});

test("calendarState: publishable -> on + canRemove", () => {
  const s = calendarState(calItem("x"), {}, CAL_STATE, CAL_NOW);
  assert.deepEqual(s, { kind: "on", reason: null, canAdd: false, canRemove: true });
});

test("calendarState: meta.onCalendar -> google, no actions", () => {
  const s = calendarState(calItem("x", { meta: { onCalendar: true } }), {}, CAL_STATE, CAL_NOW);
  assert.equal(s.kind, "google");
  assert.equal(s.reason, "on-google");
  assert.equal(s.canAdd, false);
  assert.equal(s.canRemove, false);
});

test("calendarState: pending / dismissed / removed are addable, others not", () => {
  const pending = calItem("p", { review: "pending" });
  assert.deepEqual(
    calendarState(pending, {}, CAL_STATE, CAL_NOW),
    { kind: "off", reason: "pending", canAdd: true, canRemove: false },
  );
  // showPending treats pending as accepted — the item is publishable "on".
  const showAll = {
    settings: { calendar: CAL_ON, review: { showPending: true } },
    projects: [],
  };
  assert.equal(calendarState(pending, {}, showAll, CAL_NOW).kind, "on");

  assert.deepEqual(
    calendarState(calItem("d"), { review: "dismissed" }, CAL_STATE, CAL_NOW),
    { kind: "off", reason: "dismissed", canAdd: true, canRemove: false },
  );
  assert.deepEqual(
    calendarState(calItem("r"), { calendar: false }, CAL_STATE, CAL_NOW),
    { kind: "off", reason: "removed", canAdd: true, canRemove: false },
  );
  assert.deepEqual(
    calendarState(calItem("nd", { dueAt: undefined }), {}, CAL_STATE, CAL_NOW),
    { kind: "off", reason: "no-date", canAdd: false, canRemove: false },
  );
  assert.equal(
    calendarState(calItem("h"), { hidden: true }, CAL_STATE, CAL_NOW).reason,
    "hidden",
  );
  assert.equal(calendarState(null, {}, CAL_STATE, CAL_NOW).kind, "off");
});

test("calendarReasonText covers the non-addable reasons", () => {
  assert.match(calendarReasonText("classes-off"), /turned off in Calendar settings/);
  assert.match(calendarReasonText("no-date"), /No date to put on a calendar/);
  assert.match(calendarReasonText("opted-out", { meta: { projectId: "p" } }), /project/);
  assert.match(calendarReasonText("undated"), /guess/);
});

/* ----------------------------- to-do state ------------------------------ */

const TODO_SETTINGS = {
  todos: { deadlines: true, replies: true, coop: true },
  review: {},
};
const todoStateFor = (items, userState = {}, extra = {}) =>
  todoState(
    items.x,
    userState.x,
    {
      items,
      userState,
      todos: {},
      applications: {},
      settings: TODO_SETTINGS,
      projects: [],
      ...extra,
    },
    CAL_NOW,
  );
const todoItem = (over = {}) => ({
  x: {
    id: "x",
    source: "gmail",
    type: "deadline",
    title: "x",
    status: "open",
    confidence: "exact",
    review: "auto",
    dueAt: new Date(CAL_NOW.getTime() + 86400000).toISOString(),
    ...over,
  },
});

test("todoState: a pending gmail deadline — not listed, addable", () => {
  const s = todoStateFor(todoItem({ review: "pending" }));
  assert.deepEqual(s, { listed: false, auto: false, canAdd: true, canRemove: false });
});

test("todoState: pinned pending lists; accepted auto-lists; todo:false hides", () => {
  const pending = todoItem({ review: "pending" });
  assert.deepEqual(todoStateFor(pending, { x: { todo: true } }), {
    listed: true,
    auto: false,
    canAdd: false,
    canRemove: true,
  });
  assert.deepEqual(todoStateFor(pending, { x: { review: "accepted" } }), {
    listed: true,
    auto: true,
    canAdd: false,
    canRemove: true,
  });
  assert.deepEqual(
    todoStateFor(todoItem(), { x: { todo: false } }),
    { listed: false, auto: false, canAdd: true, canRemove: false },
  );
});

test("todoState: undated non-action — nothing to pin", () => {
  const s = todoStateFor(
    todoItem({ source: "outlook", type: "task", meta: { undated: true }, dueAt: undefined }),
  );
  assert.deepEqual(s, { listed: false, auto: false, canAdd: false, canRemove: false });
});
