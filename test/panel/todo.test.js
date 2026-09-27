// @ts-check
// To-do tab model: grouping, opensAt visibility, filters and done reasons.

import test from "node:test";
import assert from "node:assert/strict";
import { buildTodos, doneLine, dueLabel } from "../../extension/src/panel/model/todo.js";

const DAY = 86400000;
const NOW = new Date("2026-01-19T16:00:00.000Z"); // Monday
const iso = (ms) => new Date(ms).toISOString();
const t0 = NOW.getTime();

const item = (id, over = {}) => ({
  id,
  source: "learn",
  type: "deadline",
  title: id,
  status: "open",
  confidence: "exact",
  review: "auto",
  ...over,
});

const SETTINGS = {
  todos: {
    study: { enabled: true, leadDays: { quiz: 2, midterm: 5 } },
    coop: true,
    deadlines: true,
    replies: true,
  },
};

test("buildTodos: groups by overdue/today/week/later/nodate and a collapsed done group", () => {
  const items = {
    over: item("over", { dueAt: iso(t0 - DAY) }),
    today: item("today", { dueAt: iso(t0 + 2 * 3600000) }),
    week: item("week", { dueAt: iso(t0 + 3 * DAY) }),
    later: item("later", { dueAt: iso(t0 + 20 * DAY) }),
    nodate: item("nodate", { source: "manual", type: "task" }),
    doneI: item("doneI", { dueAt: iso(t0 - 2 * 3600000) }),
  };
  const userState = { doneI: { done: true, doneAt: iso(t0 - 3600000) } };
  const out = buildTodos({ items, userState, settings: SETTINGS, now: NOW });
  const byId = Object.fromEntries(out.groups.map((g) => [g.id, g.rows.map((r) => r.item.id)]));
  assert.deepEqual(byId.overdue, ["over"]);
  assert.deepEqual(byId.today, ["today"]);
  assert.deepEqual(byId.week, ["week"]);
  assert.deepEqual(byId.later, ["later"]);
  assert.deepEqual(byId.nodate, ["nodate"]);
  assert.deepEqual(byId.done, ["doneI"]);
  assert.equal(out.groups.find((g) => g.id === "done").collapsedByDefault, true);
});

test("buildTodos: a study to-do hides until opensAt, then shows with its lead", () => {
  const due = t0 + 5 * DAY;
  const todos = {
    "todo:study:x": item("todo:study:x", {
      source: "manual",
      type: "task",
      title: "Study for MATH 117 Midterm",
      dueAt: iso(due),
      opensAt: iso(t0 + 2 * DAY), // opens in 2 days
      meta: { auto: "study", parentId: "x", leadDays: 3 },
    }),
  };
  const early = buildTodos({ todos, settings: SETTINGS, now: NOW });
  assert.equal(early.groups.length, 0, "not open yet — no group row");
  assert.equal(early.startingSoon.length, 1, "but listed as starting soon");
  assert.equal(early.startingSoon[0].id, "todo:study:x");

  const open = buildTodos({ todos, settings: SETTINGS, now: new Date(t0 + 2 * DAY + 1) });
  const all = open.groups.flatMap((g) => g.rows);
  assert.equal(all.length, 1);
  assert.equal(all[0].kind, "study");
  assert.match(all[0].auto, /Completes .*after the assessment/);
});

test("buildTodos: userState.override.opensAt pulls a study to-do earlier", () => {
  const due = t0 + 5 * DAY;
  const todos = {
    "todo:study:x": item("todo:study:x", {
      source: "manual",
      type: "task",
      dueAt: iso(due),
      opensAt: iso(t0 + 4 * DAY),
      meta: { auto: "study", parentId: "x" },
    }),
  };
  const userState = { "todo:study:x": { override: { opensAt: iso(t0 - DAY) } } };
  const out = buildTodos({ todos, userState, settings: SETTINGS, now: NOW });
  assert.equal(out.groups.flatMap((g) => g.rows).length, 1, "overridden open -> visible now");
});

test("buildTodos: filters split school/coop/replies/mine", () => {
  const items = {
    dl: item("dl", { dueAt: iso(t0 + DAY), org: "ECE 105" }), // school
    ww: item("ww", { source: "waterlooworks", type: "offer-deadline", dueAt: iso(t0 + DAY) }), // coop
    rep: item("rep", { source: "outlook", type: "task", category: "reply", dueAt: iso(t0 + DAY) }), // reply
    man: item("man", { source: "manual", type: "task" }), // mine
    team: item("team", { source: "discord", type: "task", dueAt: iso(t0 + DAY) }), // teams
  };
  const pick = (filter) =>
    buildTodos({ items, settings: SETTINGS, now: NOW, filter }).groups
      .flatMap((g) => g.rows)
      .map((r) => r.item.id)
      .sort();
  assert.deepEqual(pick("all"), ["dl", "man", "rep", "team", "ww"]);
  assert.deepEqual(pick("school"), ["dl"]);
  assert.deepEqual(pick("coop"), ["ww"]);
  assert.deepEqual(pick("replies"), ["rep"]);
  assert.deepEqual(pick("mine"), ["man"]);
  assert.deepEqual(pick("teams"), ["team"]);
});

test("buildTodos: done reasons — Checked off, Submitted on Learn, auto rules", () => {
  const items = {
    manual: item("manual", { source: "manual", type: "task" }),
    sub: item("sub", { source: "learn", type: "deadline", status: "submitted", dueAt: iso(t0 - DAY) }),
    appDl: item("appDl", {
      source: "waterlooworks",
      type: "application-deadline",
      dueAt: iso(t0 + DAY),
      meta: { jobId: "9" },
    }),
  };
  const userState = { manual: { done: true, doneAt: iso(t0 - 3600000) } };
  const applications = { a1: { id: "a1", jobId: "9" } };
  const out = buildTodos({ items, applications, userState, settings: SETTINGS, now: NOW });
  const rows = Object.fromEntries(
    out.groups.flatMap((g) => g.rows).map((r) => [r.item.id, r])
  );
  assert.equal(rows.manual.doneReason, "Checked off");
  assert.equal(rows.sub.doneReason, "Submitted on Learn");
  assert.equal(rows.appDl.doneReason, "Applied on WaterlooWorks");
  assert.equal(rows.appDl.done, true);
  assert.equal(doneLine(rows.manual, NOW), "Checked off · 1h ago");
});

test("buildTodos: hidden and snoozed rows stay out; auto badge tooltip explains", () => {
  const items = {
    hid: item("hid", { dueAt: iso(t0 + DAY) }),
  };
  const todos = {
    "todo:study:x": item("todo:study:x", {
      source: "manual",
      type: "task",
      dueAt: iso(t0 + DAY),
      meta: { auto: "study", parentId: "x", completesWhen: "after the midterm" },
    }),
  };
  const userState = { hid: { hidden: true } };
  const out = buildTodos({ items, todos, userState, settings: SETTINGS, now: NOW });
  const rows = out.groups.flatMap((g) => g.rows);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].item.id, "todo:study:x");
  assert.equal(rows[0].auto, "Completes after the midterm");
});

test("dueLabel: overdue and dated rows", () => {
  const r = (a) => ({ item: { dueAt: iso(a) }, anchorMs: a });
  assert.equal(dueLabel(r(t0 - 2 * DAY), NOW), "2d late");
  assert.match(dueLabel(r(t0 + 3600000), NOW), /·/);
  assert.equal(dueLabel({ item: {} }, NOW), "No date");
});
