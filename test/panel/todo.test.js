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
    book: item("book", { source: "gmail", type: "task", category: "book-call", dueAt: iso(t0 + DAY) }), // reply
    man: item("man", { source: "manual", type: "task" }), // mine
    team: item("team", { source: "discord", type: "task", dueAt: iso(t0 + DAY) }), // teams
  };
  const pick = (filter) =>
    buildTodos({ items, settings: SETTINGS, now: NOW, filter }).groups
      .flatMap((g) => g.rows)
      .map((r) => r.item.id)
      .sort();
  assert.deepEqual(pick("all"), ["book", "dl", "man", "rep", "team", "ww"]);
  assert.deepEqual(pick("school"), ["dl"]);
  assert.deepEqual(pick("coop"), ["ww"]);
  assert.deepEqual(pick("replies"), ["book", "rep"], "book-call rows count under Replies & calls");
  assert.deepEqual(pick("mine"), ["man"]);
  assert.deepEqual(pick("teams"), ["team"]);
  const model = buildTodos({ items, settings: SETTINGS, now: NOW });
  assert.equal(model.counts.reply, 2, "the Replies & calls chip counts replies + book-calls");
});

test("buildTodos: a book-call row done via an invite shows 'Invite received'", () => {
  const items = {
    book: item("book", {
      source: "gmail",
      type: "task",
      category: "book-call",
      title: "Book a call with Jane Recruiter",
      status: "done",
      dueAt: iso(t0 + DAY),
    }),
    rep: item("rep", {
      source: "gmail",
      type: "task",
      category: "reply",
      title: "Reply to Prof: midterm",
      status: "done",
      dueAt: iso(t0 + DAY),
    }),
  };
  const out = buildTodos({ items, settings: SETTINGS, now: NOW });
  const rows = Object.fromEntries(
    out.groups.flatMap((g) => g.rows).map((r) => [r.item.id, r]),
  );
  assert.equal(rows.book.doneReason, "Invite received");
  assert.equal(rows.rep.doneReason, "You replied");
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

test("buildTodos: a derived to-do suppresses the source row it links", () => {
  const items = {
    ww: item("ww", {
      source: "waterlooworks",
      type: "offer-deadline",
      title: "Acme — respond to offer",
      dueAt: iso(t0 + DAY),
      meta: { jobId: "1" },
    }),
  };
  const todos = {
    "todo:offer:a1": item("todo:offer:a1", {
      source: "manual",
      type: "task",
      title: "Respond to offer — Acme",
      dueAt: iso(t0 + DAY),
      meta: {
        auto: "offer",
        applicationId: "a1",
        linkedItemId: "ww",
        completesWhen: "when WaterlooWorks shows your response",
      },
    }),
  };
  const out = buildTodos({ items, todos, settings: SETTINGS, now: NOW });
  const ids = out.groups.flatMap((g) => g.rows.map((r) => r.item.id));
  assert.deepEqual(ids, ["todo:offer:a1"], "the derived row replaces the offer-deadline row");
});

test("buildTodos: study to-dos never suppress their parent row", () => {
  const items = { q: item("q", { type: "quiz", dueAt: iso(t0 + 3 * DAY) }) };
  const todos = {
    "todo:study:q": item("todo:study:q", {
      source: "manual",
      type: "task",
      title: "Study for Quiz",
      dueAt: iso(t0 + 3 * DAY),
      meta: { auto: "study", parentId: "q" },
    }),
  };
  const ids = buildTodos({ items, todos, settings: SETTINGS, now: NOW })
    .groups.flatMap((g) => g.rows.map((r) => r.item.id))
    .sort();
  assert.deepEqual(ids, ["q", "todo:study:q"], "the quiz itself stays a to-do");
});

test("buildTodos: project items get kind project; done/archived projects hide theirs", () => {
  const items = {
    p1: item("p1", { source: "manual", type: "task", meta: { projectId: "proj_a" } }),
    p2: item("p2", { source: "manual", type: "task", meta: { projectId: "proj_b" } }),
    p3: item("p3", { source: "manual", type: "task", meta: { projectId: "proj_gone" } }),
  };
  const projects = [
    { id: "proj_a", name: "Hackathon", color: 0, status: "active" },
    { id: "proj_b", name: "Old build", color: 1, status: "archived" },
  ];
  const out = buildTodos({ items, projects, settings: SETTINGS, now: NOW });
  const ids = out.groups.flatMap((g) => g.rows.map((r) => r.item.id)).sort();
  assert.deepEqual(ids, ["p1", "p3"], "archived project's item hidden; orphaned stays");
  assert.equal(out.groups.flatMap((g) => g.rows)[0].kind, "project");
  const pf = buildTodos({ items, projects, settings: SETTINGS, now: NOW, filter: "projects" });
  assert.deepEqual(pf.groups.flatMap((g) => g.rows.map((r) => r.item.id)).sort(), ["p1", "p3"]);
});

test("dueLabel: overdue and dated rows", () => {
  const r = (a) => ({ item: { dueAt: iso(a) }, anchorMs: a });
  assert.equal(dueLabel(r(t0 - 2 * DAY), NOW), "2d late");
  assert.match(dueLabel(r(t0 + 3600000), NOW), /·/);
  assert.equal(dueLabel({ item: {} }, NOW), "No date");
});

/* ----------------------- adapter action to-dos ----------------------- */

test("buildTodos: meta.action maps to reply / coop / deadline kinds", () => {
  const items = {
    rep: item("rep", {
      source: "gmail",
      type: "task",
      dueAt: iso(t0 + DAY),
      meta: { action: "reply" },
    }),
    bi: item("bi", {
      source: "gmail",
      type: "task",
      dueAt: iso(t0 + DAY),
      meta: { action: "book-interview", employer: "Acme" },
    }),
    ro: item("ro", {
      source: "outlook",
      type: "task",
      dueAt: iso(t0 + DAY),
      meta: { action: "respond-offer", employer: "Acme" },
    }),
    sr: item("sr", {
      source: "gmail",
      type: "task",
      dueAt: iso(t0 + DAY),
      meta: { action: "submit-rankings" },
    }),
    sf: item("sf", {
      source: "gmail",
      type: "deadline",
      org: "ECE 105",
      dueAt: iso(t0 + DAY),
      meta: { action: "submit-form" },
    }),
  };
  const rows = Object.fromEntries(
    buildTodos({ items, settings: SETTINGS, now: NOW })
      .groups.flatMap((g) => g.rows)
      .map((r) => [r.item.id, r.kind])
  );
  assert.equal(rows.rep, "reply");
  assert.equal(rows.bi, "coop");
  assert.equal(rows.ro, "coop");
  assert.equal(rows.sr, "deadline", "a rankings task without employer falls through");
  assert.equal(rows.sf, "deadline");
});

test("buildTodos: an emailed submit-rankings task folds into the derived rank to-do", () => {
  const items = {
    em: item("em", {
      source: "gmail",
      type: "task",
      title: "Submit your rankings",
      dueAt: iso(t0 + 6 * DAY),
      meta: { action: "submit-rankings" },
    }),
    emFar: item("emFar", {
      source: "gmail",
      type: "task",
      title: "Rankings for a later term",
      dueAt: iso(t0 + 30 * DAY),
      meta: { action: "submit-rankings" },
    }),
  };
  const todos = {
    "todo:rank:w": item("todo:rank:w", {
      source: "manual",
      type: "task",
      title: "Submit your rankings",
      dueAt: iso(t0 + 5 * DAY),
      meta: { auto: "rank" },
    }),
  };
  const ids = buildTodos({ items, todos, settings: SETTINGS, now: NOW })
    .groups.flatMap((g) => g.rows.map((r) => r.item.id))
    .sort();
  assert.deepEqual(ids, ["emFar", "todo:rank:w"], "near rank to-do suppressed, far one stays");
});

test("buildTodos: meta.undated keeps its bucket but reads 'No due date · by <day>'", () => {
  const items = {
    u: item("u", {
      source: "gmail",
      type: "task",
      dueAt: iso(t0 + 3 * DAY),
      meta: { action: "reply", undated: true },
    }),
  };
  const out = buildTodos({ items, settings: SETTINGS, now: NOW });
  const week = out.groups.find((g) => g.id === "week");
  const row = week && week.rows.find((r) => r.item.id === "u");
  assert.ok(row, "the suggested date still lands in This week");
  assert.match(dueLabel(row, NOW), /^No due date · by /);
});
