// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAgenda,
  rowView,
  fmtCountdown,
  fmtLate,
  startOfDay,
} from "../../extension/src/panel/model/agenda.js";

const DAY = 86400000;
const HOUR = 3600000;

// Fixed "now": Wednesday 2026-09-23 10:00 local.
const NOW = new Date(2026, 8, 23, 10, 0, 0);
const at = (dOff, h, m = 0) =>
  new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + dOff, h, m).toISOString();

/** @param {string} id @param {any} over */
const item = (id, over) => ({
  id,
  source: "learn",
  type: "deadline",
  title: id,
  status: "open",
  confidence: "exact",
  review: "auto",
  ...over,
});

const ids = (group) => group && group.rows.map((r) => r.id);
const group = (ag, id) => ag.groups.find((g) => g.id === id);
const groupIds = (ag) => ag.groups.map((g) => g.id);

/* ------------------------------ grouping ------------------------------ */

test("groups: overdue, today, tomorrow, week days, next week, later — sorted by anchor", () => {
  const items = {
    a: item("a", { dueAt: at(-2, 12) }), // overdue
    b: item("b", { dueAt: at(0, 23, 59) }), // today
    c: item("c", { dueAt: at(1, 10) }), // tomorrow
    d: item("d", { dueAt: at(3, 12) }), // Sat Sep 26 (this week)
    e: item("e", { dueAt: at(5, 12) }), // Mon Sep 28 -> next week
    f: item("f", { dueAt: at(20, 12) }), // later
  };
  const ag = buildAgenda({ items, userState: {}, settings: {}, now: NOW });
  assert.deepEqual(groupIds(ag), ["overdue", "today", "tomorrow", "day:Sat Sep 26 2026", "next-week", "later"]);
  assert.equal(group(ag, "later").collapsedByDefault, true);
  assert.equal(ag.summary.overdue, 1);
  assert.equal(ag.summary.dueToday, 1);
  assert.equal(ag.summary.dueWeek, 3); // b, c, d
});

test("rows within a group sort by anchor (dueAt || startAt)", () => {
  const items = {
    late: item("late", { dueAt: at(0, 22) }),
    early: item("early", { dueAt: at(0, 9) }),
  };
  const ag = buildAgenda({ items, userState: {}, settings: {}, now: NOW });
  assert.deepEqual(ids(group(ag, "today")), ["early", "late"]);
});

/* --------------------------- class visibility --------------------------- */

const cls = (id, dOff, h) =>
  item(id, { type: "class", startAt: at(dOff, h), endAt: at(dOff, h + 1), org: "ECE 105" });

test("showClasses=today: today's classes fold into Classes today, tomorrow stays put", () => {
  const items = { c0: cls("c0", 0, 13), c1: cls("c1", 1, 9), c4: cls("c4", 4, 9) };
  const ag = buildAgenda({
    items,
    userState: {},
    settings: { agenda: { showClasses: "today" } },
    now: NOW,
  });
  assert.deepEqual(ids(group(ag, "classes-today")), ["c0"]);
  assert.equal(group(ag, "classes-today").collapsedByDefault, true);
  assert.equal(group(ag, "classes-today").label, "Classes today");
  assert.deepEqual(ids(group(ag, "tomorrow")), ["c1"]);
  assert.equal(ag.groups.some((g) => g.rows.some((r) => r.id === "c4")), false);
});

test("classes-today emits right after the today group", () => {
  const items = {
    d: item("d", { dueAt: at(0, 23, 59) }),
    c: cls("c", 0, 13),
  };
  const ag = buildAgenda({ items, userState: {}, settings: {}, now: NOW });
  assert.deepEqual(groupIds(ag).slice(0, 2), ["today", "classes-today"]);
});

test("showClasses=all shows classes anywhere; none hides them", () => {
  const items = { c4: cls("c4", 4, 9) };
  const all = buildAgenda({ items, userState: {}, settings: { agenda: { showClasses: "all" } }, now: NOW });
  assert.ok(all.groups.some((g) => g.rows.some((r) => r.id === "c4")));
  const none = buildAgenda({ items, userState: {}, settings: { agenda: { showClasses: "none" } }, now: NOW });
  assert.ok(!none.groups.some((g) => g.rows.some((r) => r.id === "c4")));
});

test("Classes filter always shows classes for the next 7 days", () => {
  const items = { c4: cls("c4", 4, 9), c9: cls("c9", 9, 9), d: item("d", { dueAt: at(0, 23) }) };
  const ag = buildAgenda({
    items,
    userState: {},
    settings: { agenda: { showClasses: "none" } },
    now: NOW,
    filter: "classes",
  });
  assert.ok(ag.groups.some((g) => g.rows.some((r) => r.id === "c4")));
  assert.ok(!ag.groups.some((g) => g.rows.some((r) => r.id === "c9")), "beyond 7 days");
  assert.ok(!ag.groups.some((g) => g.rows.some((r) => r.id === "d")), "deadline excluded");
});

/* ------------------------------- filters -------------------------------- */

test("filters partition item types", () => {
  const items = {
    quiz: item("quiz", { type: "quiz", dueAt: at(1, 23) }),
    labDue: item("labDue", { type: "lab", dueAt: at(1, 23) }),
    labSess: item("labSess", { type: "lab", startAt: at(1, 10) }),
    exam: item("exam", { type: "exam", startAt: at(2, 16) }),
    meet: item("meet", { type: "meeting", startAt: at(2, 12) }),
    int: item("int", { type: "interview", startAt: at(2, 14) }),
    cls: cls("cls", 1, 9),
  };
  const mk = (filter) =>
    buildAgenda({ items, userState: {}, settings: { agenda: { showClasses: "all" } }, now: NOW, filter })
      .groups.flatMap((g) => g.rows.map((r) => r.id))
      .sort();
  assert.deepEqual(mk("deadlines"), ["labDue", "quiz"]);
  assert.deepEqual(mk("classes"), ["cls", "labSess"]);
  assert.deepEqual(mk("exams"), ["exam"]);
  assert.deepEqual(mk("meetings"), ["meet"]);
  assert.deepEqual(mk("coop"), ["int"]);
});

test("org filter restricts to a normalised org match", () => {
  const items = {
    a: item("a", { dueAt: at(0, 23), org: "ECE 105" }),
    b: item("b", { dueAt: at(0, 23), org: "MATH 117" }),
  };
  const ag = buildAgenda({ items, userState: {}, settings: {}, now: NOW, org: "ece105" });
  assert.deepEqual(ids(group(ag, "today")), ["a"]);
});

/* ------------------------------ exclusions ------------------------------- */

test("hidden, snoozed, review-pending, term-date and cancelled items are excluded", () => {
  const items = {
    hid: item("hid", { dueAt: at(0, 23) }),
    snz: item("snz", { dueAt: at(0, 23) }),
    rev: item("rev", { dueAt: at(0, 23), review: "pending" }),
    dis: item("dis", { dueAt: at(0, 23), review: "dismissed" }),
    term: item("term", { type: "term-date", dueAt: at(0, 23) }),
    can: item("can", { status: "cancelled", dueAt: at(0, 23) }),
    ok: item("ok", { dueAt: at(0, 23) }),
  };
  const userState = {
    hid: { hidden: true },
    snz: { snoozedUntil: new Date(NOW.getTime() + DAY).toISOString() },
  };
  const ag = buildAgenda({ items, userState, settings: {}, now: NOW });
  assert.deepEqual(ids(group(ag, "today")), ["ok"]);
});

/* ------------------------------ row view --------------------------------- */

test("rowView: countdown under 3h, late labels, moved marker", () => {
  const soon = item("soon", { dueAt: new Date(NOW.getTime() + 2 * HOUR + 10 * 60000).toISOString() });
  const v1 = rowView(soon, NOW);
  assert.equal(v1.countdown, "in 2h 10m");
  const late = item("late", { dueAt: at(-2, 12) });
  const v2 = rowView(late, NOW);
  assert.equal(v2.lateLabel, "2d late");
  const moved = item("moved", {
    dueAt: at(5, 22),
    moved: { from: at(4, 22), at: at(0, 9) },
  });
  assert.equal(rowView(moved, NOW).movedFrom, "Sun, Sep 27");
  assert.equal(rowView(item("s", { status: "submitted", dueAt: at(0, 1) }), NOW).statusLabel, "Submitted");
});

test("fmtCountdown/fmtLate edge cases", () => {
  assert.equal(fmtCountdown(45 * 60000), "in 45m");
  assert.equal(fmtCountdown(3 * HOUR), null);
  assert.equal(fmtCountdown(-1), null);
  assert.equal(fmtLate(5 * HOUR), "5h late");
});

/* ------------------------------ done recently ----------------------------- */

test("done items land in collapsed 'Done recently' within 7 days", () => {
  const items = {
    done1: item("done1", { dueAt: at(0, 23) }),
    done2: item("done2", { dueAt: at(0, 23) }),
    old: item("old", { dueAt: at(0, 23) }),
    live: item("live", { dueAt: at(0, 23) }),
  };
  const userState = {
    done1: { done: true, doneAt: at(0, 9) },
    done2: { done: true, doneAt: at(-1, 9) },
    old: { done: true, doneAt: at(-10, 9) },
  };
  const ag = buildAgenda({ items, userState, settings: {}, now: NOW });
  const done = group(ag, "done");
  assert.equal(done.label, "Done recently");
  assert.equal(done.collapsedByDefault, true);
  assert.deepEqual(ids(done), ["done1", "done2"], "most recently done first");
  assert.deepEqual(ids(group(ag, "today")), ["live"]);
});

/* -------------------------------- nextClass -------------------------------- */

test("nextClass is the next classish item today or tomorrow", () => {
  const items = {
    past: cls("past", 0, 8), // already over
    next: cls("next", 0, 13),
    later: cls("later", 3, 9),
  };
  const ag = buildAgenda({
    items,
    userState: {},
    settings: { agenda: { showClasses: "all" } },
    now: NOW,
  });
  assert.equal(ag.nextClass.id, "next");
});

/* -------------------------------- search -------------------------------- */

test("q filters rows on title/org/location, case-insensitive", () => {
  const items = {
    a: item("a", { title: "Midterm Review", dueAt: at(0, 14), org: "math 117" }),
    b: item("b", { title: "Lab report", dueAt: at(0, 15), location: "E5 1234" }),
    c: item("c", { title: "Essay draft", dueAt: at(0, 16), org: "ENGL 192" }),
  };
  const base = { items, userState: {}, settings: {}, now: NOW };
  assert.deepEqual(ids(group(buildAgenda({ ...base, q: "midterm" }), "today")), ["a"]);
  assert.deepEqual(ids(group(buildAgenda({ ...base, q: "engl" }), "today")), ["c"]);
  assert.deepEqual(ids(group(buildAgenda({ ...base, q: "E5 1234" }), "today")), ["b"]);
  assert.equal(buildAgenda({ ...base, q: "nothing matches" }).groups.length, 0);
});

/* ------------------------------- source filter --------------------------- */

test("source filter: keeps only items from that source (source or seenIn)", () => {
  const items = {
    a: item("a", { dueAt: at(0, 12), source: "learn", seenIn: [{ source: "learn" }] }),
    b: item("b", {
      dueAt: at(0, 13),
      source: "portal",
      seenIn: [{ source: "portal" }, { source: "outline" }],
    }),
    c: item("c", { dueAt: at(0, 14), source: "waterlooworks", seenIn: [{ source: "waterlooworks" }] }),
  };
  const base = { items, userState: {}, settings: {}, now: NOW };
  assert.deepEqual(ids(group(buildAgenda({ ...base, source: "learn" }), "today")), ["a"]);
  assert.deepEqual(ids(group(buildAgenda({ ...base, source: "outline" }), "today")), ["b"], "seenIn match");
  assert.deepEqual(ids(group(buildAgenda({ ...base, source: "portal" }), "today")), ["b"]);
  assert.equal(buildAgenda({ ...base, source: "discord" }).groups.length, 0);
});

/* ----------------------------- full-date labels -------------------------- */

test("day groups carry full-date labels; today/tomorrow keep their name + date", () => {
  const items = {
    a: item("a", { dueAt: at(0, 12) }),      // Wed Sep 23
    b: item("b", { dueAt: at(1, 12) }),      // Thu Sep 24
    c: item("c", { dueAt: at(3, 12) }),      // Sat Sep 26
  };
  const ag = buildAgenda({ items, userState: {}, settings: {}, now: NOW });
  assert.equal(group(ag, "today").label, "Today — Wednesday, September 23");
  assert.equal(group(ag, "tomorrow").label, "Tomorrow — Thursday, September 24");
  assert.equal(group(ag, "day:Sat Sep 26 2026").label, "Saturday, September 26");
});
