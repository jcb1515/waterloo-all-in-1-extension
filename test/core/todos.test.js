// @ts-check
// Derived to-dos: deriveTodos study/co-op rules, autoDoneRule reasons, and
// the todoSourceItem settings gates.

import test from "node:test";
import assert from "node:assert/strict";
import { deriveTodos, autoDoneRule, todoSourceItem, termKey } from "../../extension/src/core/todos.js";
import { nextReminders } from "../../extension/src/core/remind.js";

const DAY = 86400000;
const NOW = new Date("2026-01-19T16:00:00.000Z"); // Monday noon EST-ish
const iso = (ms) => new Date(ms).toISOString();
const t0 = NOW.getTime();

const SETTINGS = {
  todos: {
    study: { enabled: true, leadDays: { quiz: 2, midterm: 5, final: 7, exam: 5, presentation: 3 } },
    coop: true,
    deadlines: true,
    replies: true,
    includeInCalendar: false,
  },
};

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

/* ------------------------------- study -------------------------------- */

test("deriveTodos: a quiz gets a study to-do due with it, opening leadDays early", () => {
  const due = t0 + 4 * DAY;
  const items = { "learn:q1": item("learn:q1", { type: "quiz", title: "Quiz 3", org: "ECE 105", dueAt: iso(due) }) };
  const todos = deriveTodos({ items, settings: SETTINGS, now: NOW });
  const todo = todos["todo:study:learn:q1"];
  assert.ok(todo, "study to-do exists");
  assert.equal(todo.title, "Study for ECE 105 Quiz 3");
  assert.equal(todo.type, "task");
  assert.equal(todo.source, "manual");
  assert.equal(todo.review, "auto");
  assert.equal(todo.meta.auto, "study");
  assert.equal(todo.meta.parentId, "learn:q1");
  assert.equal(todo.dueAt, iso(due));
  assert.equal(Date.parse(todo.opensAt), due - 2 * DAY, "quiz lead is 2 days");
});

test("deriveTodos: per-category leads — midterm 5d, final 7d, exam 5d, presentation 3d", () => {
  const due = t0 + 30 * DAY;
  const items = {
    "o:mid": item("o:mid", { source: "outline", type: "exam", category: "midterm", title: "Midterm", dueAt: iso(due) }),
    "o:fin": item("o:fin", { source: "outline", type: "exam", category: "final", title: "Final exam", dueAt: iso(due) }),
    "o:oth": item("o:oth", { source: "outline", type: "exam", category: "make-up", title: "Make-up exam", dueAt: iso(due) }),
    "o:pres": item("o:pres", { source: "outline", type: "presentation", title: "Design talk", dueAt: iso(due) }),
  };
  const todos = deriveTodos({ items, settings: SETTINGS, now: NOW });
  assert.equal(Date.parse(todos["todo:study:o:mid"].opensAt), due - 5 * DAY);
  assert.equal(Date.parse(todos["todo:study:o:fin"].opensAt), due - 7 * DAY);
  assert.equal(Date.parse(todos["todo:study:o:oth"].opensAt), due - 5 * DAY, "generic exam falls back to the exam lead");
  assert.equal(Date.parse(todos["todo:study:o:pres"].opensAt), due - 3 * DAY);
  assert.equal(todos["todo:study:o:pres"].title, "Prepare Design talk", "presentation wording");
});

test("deriveTodos: a passed assessment marks the to-do done, then drops it after 2 days", () => {
  const past = t0 - 3 * 3600000; // due 3h ago
  const items = { "l:q": item("l:q", { type: "quiz", title: "Quiz", dueAt: iso(past) }) };
  const todos = deriveTodos({ items, settings: SETTINGS, now: NOW });
  assert.equal(todos["todo:study:l:q"].status, "done", "anchor passed -> done");

  const late = deriveTodos({ items, settings: SETTINGS, now: new Date(t0 + 3 * DAY) });
  assert.equal(late["todo:study:l:q"], undefined, "dropped 2 days after it finished");
});

test("deriveTodos: dismissed/hidden/cancelled parents produce no to-do", () => {
  const due = t0 + 4 * DAY;
  const items = {
    "l:dismissed": item("l:dismissed", { type: "quiz", dueAt: iso(due) }),
    "l:hidden": item("l:hidden", { type: "quiz", dueAt: iso(due) }),
    "l:cancelled": item("l:cancelled", { type: "quiz", dueAt: iso(due), status: "cancelled" }),
    "l:pending": item("l:pending", { type: "quiz", dueAt: iso(due), review: "pending" }),
  };
  const userState = {
    "l:dismissed": { review: "dismissed" },
    "l:hidden": { hidden: true },
  };
  const todos = deriveTodos({ items, userState, settings: SETTINGS, now: NOW });
  assert.deepEqual(Object.keys(todos), []);
});

test("deriveTodos: study.enabled=false makes none; createdAt survives recompute", () => {
  const due = t0 + 4 * DAY;
  const items = { "l:q": item("l:q", { type: "quiz", dueAt: iso(due) }) };
  const off = deriveTodos({ items, settings: { todos: { study: { enabled: false } } }, now: NOW });
  assert.deepEqual(Object.keys(off), []);
  const prev = { "todo:study:l:q": { meta: { createdAt: "2026-01-01T00:00:00.000Z" } } };
  const again = deriveTodos({ items, settings: SETTINGS, now: NOW, prev });
  assert.equal(again["todo:study:l:q"].meta.createdAt, "2026-01-01T00:00:00.000Z");
});

/* -------------------------------- co-op ------------------------------- */

const APP = {
  id: "waterlooworks:1",
  employer: "Acme Analog",
  jobTitle: "Hardware Engineer",
  jobId: "1",
  status: "offer",
  history: [{ status: "offer", at: iso(t0 - 3600000) }],
};

test("deriveTodos: an offered application gets a respond-to-offer to-do at the offer deadline", () => {
  const items = {
    "ww:offer-dl": item("ww:offer-dl", {
      source: "waterlooworks",
      type: "offer-deadline",
      title: "Respond",
      dueAt: iso(t0 + 2 * DAY),
      meta: { jobId: "1" },
    }),
  };
  const todos = deriveTodos({ items, applications: { [APP.id]: APP }, settings: SETTINGS, now: NOW });
  const todo = todos[`todo:offer:${APP.id}`];
  assert.ok(todo);
  assert.equal(todo.title, "Respond to offer — Acme Analog (Hardware Engineer)");
  assert.equal(todo.dueAt, iso(t0 + 2 * DAY), "due at the linked offer deadline");
  assert.equal(todo.meta.applicationId, APP.id);
  assert.equal(todo.meta.linkedItemId, "ww:offer-dl", "links the source offer-deadline row it replaces");
  assert.equal(todo.meta.completesWhen, "when WaterlooWorks shows your response");
});

test("deriveTodos: answering the offer finishes the to-do, which then expires", () => {
  const prevTodo = { [`todo:offer:${APP.id}`]: { id: `todo:offer:${APP.id}`, meta: { auto: "offer", applicationId: APP.id } } };
  const answered = { ...APP, status: "ranked", history: [...APP.history, { status: "ranked", at: iso(t0 - 1800000) }] };
  const todos = deriveTodos({ applications: { [APP.id]: answered }, settings: SETTINGS, now: NOW, prev: prevTodo });
  assert.equal(todos[`todo:offer:${APP.id}`].status, "done", "answered offer -> done");

  const stale = { ...answered, history: [{ status: "ranked", at: iso(t0 - 3 * DAY) }] };
  const gone = deriveTodos({ applications: { [APP.id]: stale }, settings: SETTINGS, now: NOW, prev: prevTodo });
  assert.equal(gone[`todo:offer:${APP.id}`], undefined, "old answered offer drops out");
});

test("deriveTodos: rankings-due + an in-flight application -> Submit your rankings", () => {
  const items = {
    "ww:rank-due": item("ww:rank-due", {
      source: "waterlooworks",
      type: "cycle-date",
      category: "rankings-due",
      dueAt: iso(t0 + 5 * DAY),
    }),
  };
  const interviewing = { ...APP, status: "interview-scheduled" };
  const todos = deriveTodos({ items, applications: { [APP.id]: interviewing }, settings: SETTINGS, now: NOW });
  const todo = todos["todo:rank:ww:rank-due"];
  assert.ok(todo);
  assert.equal(todo.title, "Submit your rankings");
  assert.equal(todo.dueAt, iso(t0 + 5 * DAY));

  // No in-flight applications -> no to-do.
  const none = deriveTodos({ items, applications: { [APP.id]: { ...APP, status: "applied" } }, settings: SETTINGS, now: NOW });
  assert.equal(none["todo:rank:ww:rank-due"], undefined);
});

test("deriveTodos: rankings to-do is done once an app is ranked after rankings opened", () => {
  const items = {
    "ww:rank-open": item("ww:rank-open", {
      source: "waterlooworks",
      type: "cycle-date",
      category: "rankings-open",
      dueAt: iso(t0 - 2 * DAY),
    }),
    "ww:rank-due": item("ww:rank-due", {
      source: "waterlooworks",
      type: "cycle-date",
      category: "rankings-due",
      dueAt: iso(t0 + 5 * DAY),
    }),
  };
  const ranked = { ...APP, status: "ranked", history: [{ status: "ranked", at: iso(t0 - DAY) }] };
  const todos = deriveTodos({ items, applications: { [APP.id]: ranked }, settings: SETTINGS, now: NOW });
  assert.equal(todos["todo:rank:ww:rank-due"].status, "done");
});

/* --------- one rankings to-do per work term (live bug: 18 emitted) -------- */

const rankDue = (id, days, workTerm) =>
  item(id, {
    source: "waterlooworks",
    type: "cycle-date",
    category: "rankings-due",
    title: `Rankings close — ${workTerm} ${id}`,
    dueAt: iso(t0 + days * DAY),
    meta: workTerm ? { workTerm } : {},
  });

const rankIds = (todos) => Object.keys(todos).filter((k) => k.startsWith("todo:rank:")).sort();

test("deriveTodos: 18 rankings-due dates across 3 terms -> at most one per in-flight term", () => {
  const items = {};
  // 6 dates per term; the earliest upcoming one wins for its term.
  for (const [term, days] of [
    ["Winter 2027", [5, 9, 12, 20, 30, 40]],
    ["Spring 2027", [6, 11, 15, 25, 33, 45]],
    ["Fall 2027", [7, 14, 21, 28, 35, 50]],
  ]) {
    for (const [i, d] of days.entries()) items[`ww:${term.split(" ")[0].toLowerCase()}-${i}`] = rankDue(`ww:${term.split(" ")[0].toLowerCase()}-${i}`, d, term);
  }
  const applications = {
    a1: { ...APP, id: "a1", status: "interview-scheduled", cycle: "2027 - Winter" },
    a2: { ...APP, id: "a2", status: "selected-for-interview", cycle: "Spring 2027" },
  };
  const todos = deriveTodos({ items, applications, settings: SETTINGS, now: NOW });
  assert.deepEqual(rankIds(todos), ["todo:rank:ww:spring-0", "todo:rank:ww:winter-0"]);
  assert.equal(todos["todo:rank:ww:winter-0"].dueAt, iso(t0 + 5 * DAY));
  assert.equal(todos["todo:rank:ww:spring-0"].dueAt, iso(t0 + 6 * DAY));
});

test("deriveTodos: a past rankings-due date is ignored; the next upcoming one wins", () => {
  const items = {
    "ww:past": { ...rankDue("ww:past", 5, "Winter 2027"), dueAt: iso(t0 - 5 * DAY) },
    "ww:next": rankDue("ww:next", 8, "Winter 2027"),
    "ww:later": rankDue("ww:later", 20, "Winter 2027"),
  };
  const applications = { a1: { ...APP, id: "a1", status: "interview-scheduled", cycle: "2027 - Winter" } };
  const todos = deriveTodos({ items, applications, settings: SETTINGS, now: NOW });
  assert.deepEqual(rankIds(todos), ["todo:rank:ww:next"]);
});

test("deriveTodos: an in-flight app with no parseable term gets one fallback to-do", () => {
  const items = {
    "ww:spring": rankDue("ww:spring", 3, "Spring 2027"),
    "ww:winter": rankDue("ww:winter", 7, "Winter 2027"),
  };
  const applications = { a1: { ...APP, id: "a1", status: "interview-scheduled", cycle: "n/a" } };
  const todos = deriveTodos({ items, applications, settings: SETTINGS, now: NOW });
  // The earliest upcoming date overall carries the single fallback to-do.
  assert.deepEqual(rankIds(todos), ["todo:rank:ww:spring"]);
});

test("deriveTodos: no in-flight applications -> no rankings to-dos even with unkeyed dates", () => {
  const items = {
    "ww:w": rankDue("ww:w", 5, "Winter 2027"),
    "ww:u": rankDue("ww:u", 6, null),
  };
  const applications = { a1: { ...APP, id: "a1", status: "applied", cycle: "2027 - Winter" } };
  const todos = deriveTodos({ items, applications, settings: SETTINGS, now: NOW });
  assert.deepEqual(rankIds(todos), []);
});

test("deriveTodos: a term ranked after rankings opened keeps its to-do as done", () => {
  const items = {
    "ww:rank-open": item("ww:rank-open", {
      source: "waterlooworks",
      type: "cycle-date",
      category: "rankings-open",
      dueAt: iso(t0 - 2 * DAY),
    }),
    "ww:w": rankDue("ww:w", 5, "Winter 2027"),
    "ww:s": rankDue("ww:s", 9, "Spring 2027"),
  };
  const ranked = {
    ...APP,
    status: "ranked",
    cycle: "2027 - Winter",
    history: [{ status: "ranked", at: iso(t0 - DAY) }],
  };
  const todos = deriveTodos({ items, applications: { [APP.id]: ranked }, settings: SETTINGS, now: NOW });
  assert.deepEqual(rankIds(todos), ["todo:rank:ww:w"]);
  assert.equal(todos["todo:rank:ww:w"].status, "done");
});

test("termKey normalises term text to '<Season> <YYYY>'", () => {
  assert.equal(termKey("2027 - Winter"), "Winter 2027");
  assert.equal(termKey("Winter 2027"), "Winter 2027");
  assert.equal(termKey("Winter 2027 main round"), "Winter 2027");
  assert.equal(termKey("spring 2027"), "Spring 2027");
  assert.equal(termKey("Fall 2026"), "Fall 2026");
  assert.equal(termKey("SUMMER 2027"), "Summer 2027");
  assert.equal(termKey("Winter 2027"), "Winter 2027");
  assert.equal(termKey("Spring 2027") === termKey("Summer 2027"), false);
  for (const junk of [null, undefined, "", "n/a", "Winter", "2027", "co-op term"]) {
    assert.equal(termKey(junk), null, JSON.stringify(junk));
  }
});

/* ----------------------------- autoDoneRule ---------------------------- */

test("autoDoneRule: Learn deadline/quiz is done when submitted", () => {
  const d = item("l:1", { type: "deadline" });
  assert.deepEqual(autoDoneRule(d), { done: false, reason: "Submitted on Learn" });
  assert.deepEqual(autoDoneRule({ ...d, status: "submitted" }), { done: true, reason: "Submitted on Learn" });
});

test("autoDoneRule: application-deadline completes when the jobId has an application", () => {
  const d = item("w:1", { type: "application-deadline", meta: { jobId: "9" } });
  assert.equal(autoDoneRule(d, { applications: {} }).done, false);
  const apps = { a: { id: "a", jobId: "9" } };
  assert.deepEqual(autoDoneRule(d, { applications: apps }), { done: true, reason: "Applied on WaterlooWorks" });
});

test("autoDoneRule: a reply task completes when its status is done", () => {
  const r = item("o:1", { type: "task", category: "reply" });
  assert.deepEqual(autoDoneRule(r), { done: false, reason: "You replied" });
  assert.equal(autoDoneRule({ ...r, status: "done" }).done, true);
});

test("autoDoneRule: a book-call task completes as 'Invite received'", () => {
  const b = item("gmail:book:thr-1", { source: "gmail", type: "task", category: "book-call" });
  assert.deepEqual(autoDoneRule(b), { done: false, reason: "Invite received" });
  assert.deepEqual(autoDoneRule({ ...b, status: "done" }), {
    done: true,
    reason: "Invite received",
  });
});

test("todoSourceItem: book-call tasks follow the replies toggle", () => {
  const b = item("gmail:book:thr-1", { source: "gmail", type: "task", category: "book-call" });
  assert.equal(todoSourceItem(b, SETTINGS), true);
  assert.equal(todoSourceItem(b, { todos: { replies: false } }), false);
});

test("autoDoneRule: a timeslot pick completes when an interview item exists for the job", () => {
  const slot = item("w:slot", { source: "waterlooworks", type: "deadline", category: "interview-timeslot", meta: { jobId: "7" } });
  assert.equal(autoDoneRule(slot, { items: {} }).done, false);
  const items = { "w:int": item("w:int", { type: "interview", meta: { jobId: "7" } }) };
  assert.deepEqual(autoDoneRule(slot, { items }), { done: true, reason: "Interview slot booked" });
});

test("autoDoneRule: userState.done always wins ('Checked off'); plain items have no rule", () => {
  const m = item("m:1", { source: "manual", type: "task" });
  assert.equal(autoDoneRule(m), null);
  assert.deepEqual(autoDoneRule(m, { userState: { done: true } }), { done: true, reason: "Checked off" });
});

test("autoDoneRule: study to-do is done after the assessment passes", () => {
  const s = item("todo:study:x", {
    meta: { auto: "study", parentLabel: "midterm" },
    dueAt: iso(t0 + DAY),
  });
  assert.deepEqual(autoDoneRule(s, { now: NOW }), { done: false, reason: "After the midterm" });
  assert.equal(autoDoneRule({ ...s, dueAt: iso(t0 - DAY) }, { now: NOW }).done, true);
});

/* --------------------------- settings gates ---------------------------- */

test("todoSourceItem honours each toggle", () => {
  const on = SETTINGS;
  assert.equal(todoSourceItem(item("x", { type: "deadline" }), on), true);
  assert.equal(todoSourceItem(item("x", { type: "deadline" }), { todos: { deadlines: false } }), false);
  assert.equal(todoSourceItem(item("x", { type: "task", category: "reply" }), { todos: { replies: false } }), false);
  assert.equal(todoSourceItem(item("x", { type: "deadline", category: "interview-timeslot" }), { todos: { coop: false } }), false);
  assert.equal(todoSourceItem(item("x", { type: "meeting" }), on), false, "meetings are not to-dos");
  assert.equal(todoSourceItem(item("x", { source: "manual", type: "task" }), { todos: {} }), true, "manual tasks always list");
});

/* ------------------------------ reminders ------------------------------ */

test("nextReminders: a study to-do fires once at opensAt", () => {
  const due = t0 + 5 * DAY;
  const open = due - 5 * DAY; // opensAt = now
  const todos = {
    "todo:study:m": item("todo:study:m", {
      meta: { auto: "study", parentId: "x", parentLabel: "midterm" },
      dueAt: iso(due),
      opensAt: iso(open + DAY), // opens tomorrow
      title: "Study for MATH 117 Midterm",
    }),
  };
  const out = nextReminders(todos, {}, { reminders: { enabled: true, leads: {} } }, NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].itemId, "todo:study:m");
  assert.equal(out[0].fireAt, open + DAY);
  assert.equal(out[0].lead, 4 * 24 * 60, "lead is the opensAt-to-due gap in minutes");

  // Already sent -> nothing again.
  const sentKey = out[0].key;
  assert.equal(nextReminders(todos, {}, { reminders: {} }, NOW, { [sentKey]: "x" }).length, 0);
});

/* ------------------------- todo pin + sources --------------------------- */

test("todoSourceItem: an explicit pin wins over every rule", () => {
  // todoPin === true lists a type that never auto-lists.
  assert.equal(
    todoSourceItem(item("ev", { type: "meeting", todoPin: true }), SETTINGS),
    true,
  );
  // todoPin === false hides even a plain deadline.
  assert.equal(
    todoSourceItem(item("dl", { type: "deadline", todoPin: false }), SETTINGS),
    false,
  );
  // And a pin still lists when the deadlines toggle is off.
  assert.equal(
    todoSourceItem(item("dl2", { type: "deadline", todoPin: true }), { todos: { deadlines: false } }),
    true,
  );
});

test("todoSourceItem: an undated non-action item never auto-lists", () => {
  const undated = item("u", { type: "task", meta: { undated: true }, dueAt: iso(t0 + 2 * DAY) });
  assert.equal(todoSourceItem(undated, SETTINGS), false);
  // An action task with the same flag still follows its own seam rules.
  const action = item("a", {
    type: "deadline",
    meta: { undated: true, action: "submit-form" },
    dueAt: iso(t0 + 2 * DAY),
  });
  assert.equal(todoSourceItem(action, SETTINGS), true, "action seam unaffected");
});

test("todoSourceItem: deadline-type items list from every source", () => {
  for (const src of ["learn", "outline", "portal", "gmail", "outlook", "discord", "waterlooworks"]) {
    assert.equal(
      todoSourceItem(item(`x:${src}`, { source: src, type: "deadline" }), SETTINGS),
      true,
      `${src} deadline lists`,
    );
  }
  assert.equal(
    todoSourceItem(item("p", { source: "gmail", type: "presentation" }), SETTINGS),
    true,
    "presentation lists",
  );
  assert.equal(
    todoSourceItem(item("ad", { source: "waterlooworks", type: "application-deadline" }), SETTINGS),
    false,
    "a bare application-deadline stays calendar-only",
  );
});
