// @ts-check
// Cross-source action to-dos (the shared meta.action seam): taskKey matching
// in memberMatch, task source ranking, same-action cluster coalescing,
// the book-interview auto-done rule and the action settings gates.

import test from "node:test";
import assert from "node:assert/strict";

import { recompute, itemRank } from "../../extension/src/core/merge.js";
import { autoDoneRule, deriveTodos, todoSourceItem } from "../../extension/src/core/todos.js";
import { buildTodos } from "../../extension/src/panel/model/todo.js";

const DAY = 86400000;
const NOW = new Date("2026-10-15T16:00:00.000Z"); // Thursday noon EDT
const nowIso = NOW.toISOString();
const iso = (ms) => new Date(ms).toISOString();
const t0 = NOW.getTime();

/** A raw action to-do the way an adapter emits it. */
const taskRaw = (source, key, over = {}) => ({
  id: `${source}:${key}`,
  source,
  type: "task",
  title: key,
  status: "open",
  confidence: "tentative",
  review: "auto",
  seenIn: [{ source, key, scope: "feed", at: nowIso }],
  ...over,
});

const rec = (/** @type {any} */ item) => ({ items: [item], updatedAt: nowIso });

const SETTINGS = { todos: { coop: true, deadlines: true, replies: true } };

/* ------------------------- taskKey matching ------------------------- */

test("a WaterlooWorks and an emailed book-interview task for the same employer merge", () => {
  const ww = taskRaw("waterlooworks", "bi1", {
    title: "Book your interview — Acme Corp",
    dueAt: iso(t0 + 5 * DAY),
    meta: { action: "book-interview", employer: "Acme Corp" },
  });
  const gm = taskRaw("gmail", "m1", {
    title: "Acme interview — pick a slot",
    dueAt: iso(t0 + 8 * DAY), // 3 days later, differently worded
    meta: { action: "book-interview", employer: "Acme" },
  });
  const r = recompute({ raws: { waterlooworks: rec(ww), gmail: rec(gm) }, now: NOW });
  assert.equal(Object.keys(r.items).length, 1);
  const it = r.items["waterlooworks:bi1"];
  assert.ok(it, "WaterlooWorks outranks email for action to-dos");
  assert.equal(it.title, ww.title);
  assert.equal(it.dueAt, ww.dueAt);
  assert.deepEqual(it.meta.employer, "Acme Corp");
  assert.deepEqual(
    it.seenIn.map((s) => s.source).sort(),
    ["gmail", "waterlooworks"],
    "seenIn unions every source record",
  );
});

test("different actions do not merge even for the same employer", () => {
  const a = taskRaw("gmail", "a", {
    dueAt: iso(t0 + DAY),
    meta: { action: "reply", employer: "Acme" },
  });
  const b = taskRaw("waterlooworks", "b", {
    dueAt: iso(t0 + DAY),
    meta: { action: "book-interview", employer: "Acme" },
  });
  const r = recompute({ raws: { gmail: rec(a), waterlooworks: rec(b) }, now: NOW });
  assert.equal(Object.keys(r.items).length, 2);
});

test("incompatible employers do not merge", () => {
  const a = taskRaw("gmail", "a", {
    dueAt: iso(t0 + DAY),
    meta: { action: "book-interview", employer: "Acme" },
  });
  const b = taskRaw("outlook", "b", {
    dueAt: iso(t0 + DAY),
    meta: { action: "book-interview", employer: "Globex Dynamics" },
  });
  const r = recompute({ raws: { gmail: rec(a), outlook: rec(b) }, now: NOW });
  assert.equal(Object.keys(r.items).length, 2);
});

test("the same action more than 7 days apart does not merge", () => {
  const a = taskRaw("gmail", "a", {
    dueAt: iso(t0 + DAY),
    meta: { action: "book-interview", employer: "Acme" },
  });
  const b = taskRaw("waterlooworks", "b", {
    dueAt: iso(t0 + 10 * DAY),
    meta: { action: "book-interview", employer: "Acme Corp" },
  });
  const r = recompute({ raws: { gmail: rec(a), waterlooworks: rec(b) }, now: NOW });
  assert.equal(Object.keys(r.items).length, 2);
});

test("an email reply task and an unrelated Discord reply task stay separate", () => {
  const a = taskRaw("gmail", "a", {
    dueAt: iso(t0 + DAY),
    meta: { action: "reply", employer: "Acme" },
  });
  const b = taskRaw("discord", "b", {
    dueAt: iso(t0 + DAY),
    org: "Study Crew",
    meta: { action: "reply" },
  });
  const r = recompute({ raws: { gmail: rec(a), discord: rec(b) }, now: NOW });
  assert.equal(Object.keys(r.items).length, 2);
});

test("a missing who falls through to the ordinary title/date rules", () => {
  // Identical titles on the same day still merge through the old rules.
  const a = taskRaw("gmail", "a", {
    title: "Submit the safety form",
    org: "ECE 105",
    dueAt: iso(t0 + DAY),
    meta: { action: "submit-form" },
  });
  const b = taskRaw("discord", "b", {
    title: "Submit the safety form",
    dueAt: iso(t0 + DAY),
    meta: { action: "submit-form" },
  });
  const r = recompute({ raws: { gmail: rec(a), discord: rec(b) }, now: NOW });
  assert.equal(Object.keys(r.items).length, 1);

  // Different wording within a week does NOT merge — the action match only
  // applies when both sides carry a who.
  const c = taskRaw("gmail", "c", {
    title: "Lab safety quiz",
    org: "ECE 105",
    dueAt: iso(t0 + DAY),
    meta: { action: "submit-form" },
  });
  const d = taskRaw("discord", "d", {
    title: "Post your project update",
    dueAt: iso(t0 + 3 * DAY),
    meta: { action: "submit-form" },
  });
  const r2 = recompute({ raws: { gmail: rec(c), discord: rec(d) }, now: NOW });
  assert.equal(Object.keys(r2.items).length, 2);
});

test("an action task on one side only uses the ordinary rules", () => {
  // Plain deadline vs action task: no taskKey pair, so title similarity and
  // the normal date rules decide — these don't merge.
  const a = taskRaw("gmail", "a", {
    title: "Reply to recruiter",
    dueAt: iso(t0 + DAY),
    meta: { action: "reply" },
  });
  const b = taskRaw("learn", "b", {
    title: "Assignment 4",
    type: "deadline",
    org: "ECE 105",
    dueAt: iso(t0 + 9 * DAY),
    confidence: "exact",
  });
  const r = recompute({ raws: { gmail: rec(a), learn: rec(b) }, now: NOW });
  assert.equal(Object.keys(r.items).length, 2);
});

/* ----------------------------- ranking ------------------------------ */

test("itemRank: manual and Learn still outrank task-keyed WW/email/Discord", () => {
  const t = (source) =>
    taskRaw(source, "x", {
      confidence: "exact",
      meta: { action: "book-interview", employer: "Acme" },
    });
  const man = t("manual");
  const ln = t("learn");
  const ww = t("waterlooworks");
  const gm = t("gmail");
  const dc = t("discord");
  assert.ok(itemRank(man) > itemRank(ln), "manual 7 first");
  assert.ok(itemRank(ln) > itemRank(ww), "learn 6 beats waterlooworks 5");
  assert.ok(itemRank(ww) > itemRank(gm), "waterlooworks 5 beats email 4");
  assert.ok(itemRank(gm) > itemRank(dc), "email 4 beats discord 3");
});

/* ------------------------- cluster coalescing ----------------------- */

test("two pre-linked action-task clusters coalesce across the 7-day window", () => {
  // The pair was already canonicalised separately (e.g. stored before this
  // matcher existed): links pin each raw to its own canonical id and the
  // anchors are 5 Toronto days apart — beyond the old same/adjacent-day rule.
  const ww = taskRaw("waterlooworks", "bi1", {
    title: "Book your interview — Acme Corp",
    dueAt: iso(t0 + 5 * DAY),
    meta: { action: "book-interview", employer: "Acme Corp" },
  });
  const gm = taskRaw("gmail", "m1", {
    title: "Acme interview — pick a slot",
    dueAt: iso(t0 + 10 * DAY),
    meta: { action: "book-interview", employer: "Acme" },
  });
  const soloA = recompute({ raws: { waterlooworks: rec(ww) }, now: NOW });
  const soloB = recompute({ raws: { gmail: rec(gm) }, now: NOW });
  const out = recompute({
    raws: { waterlooworks: rec(ww), gmail: rec(gm) },
    prevItems: { ...soloA.items, ...soloB.items },
    links: { [ww.id]: ww.id, [gm.id]: gm.id },
    uidMap: { ...soloA.uidMap, ...soloB.uidMap },
    now: NOW,
  });
  assert.deepEqual(Object.keys(out.items), ["waterlooworks:bi1"]);
  assert.equal(out.links[gm.id], "waterlooworks:bi1");
  assert.deepEqual(out.merged, { [gm.id]: ww.id });
  assert.deepEqual(
    out.items["waterlooworks:bi1"].seenIn.map((s) => s.source).sort(),
    ["gmail", "waterlooworks"],
  );
});

test("three same-action clusters spanning the window collapse to one", () => {
  const mkTask = (source, key, days, who) =>
    taskRaw(source, key, {
      dueAt: iso(t0 + days * DAY),
      meta: { action: "book-interview", employer: who },
    });
  const ww = mkTask("waterlooworks", "w", 5, "Acme Corp");
  const gm = mkTask("gmail", "g", 8, "Acme");
  const dc = mkTask("discord", "d", 12, "Acme Corp");
  const solos = [ww, gm, dc].map((it) => recompute({ raws: { [it.source]: rec(it) }, now: NOW }));
  const out = recompute({
    raws: { waterlooworks: rec(ww), gmail: rec(gm), discord: rec(dc) },
    prevItems: Object.assign({}, ...solos.map((s) => s.items)),
    links: { [ww.id]: ww.id, [gm.id]: gm.id, [dc.id]: dc.id },
    uidMap: Object.assign({}, ...solos.map((s) => s.uidMap)),
    now: NOW,
  });
  assert.deepEqual(Object.keys(out.items), ["waterlooworks:w"]);
  assert.equal(out.links[gm.id], "waterlooworks:w");
  assert.equal(out.links[dc.id], "waterlooworks:w");
});

test("coalescing still rejects a different action across the window", () => {
  const a = taskRaw("waterlooworks", "w", {
    dueAt: iso(t0 + 5 * DAY),
    meta: { action: "book-interview", employer: "Acme" },
  });
  const b = taskRaw("gmail", "g", {
    dueAt: iso(t0 + 6 * DAY),
    meta: { action: "respond-offer", employer: "Acme" },
  });
  const soloA = recompute({ raws: { waterlooworks: rec(a) }, now: NOW });
  const soloB = recompute({ raws: { gmail: rec(b) }, now: NOW });
  const out = recompute({
    raws: { waterlooworks: rec(a), gmail: rec(b) },
    prevItems: { ...soloA.items, ...soloB.items },
    links: { [a.id]: a.id, [b.id]: b.id },
    now: NOW,
  });
  assert.equal(Object.keys(out.items).length, 2);
  assert.deepEqual(out.merged, {});
});

/* ------------------------ book-interview done ------------------------ */

const biTask = (over = {}) =>
  taskRaw("gmail", "bi", {
    meta: { action: "book-interview", employer: "Acme" },
    seenIn: [{ source: "gmail", key: "bi", scope: "feed", at: iso(t0 - 2 * DAY) }],
    ...over,
  });

const interview = (over = {}) => ({
  id: "ww:i1",
  source: "waterlooworks",
  type: "interview",
  status: "open",
  title: "Interview — Acme Corp",
  startAt: iso(t0 + DAY),
  meta: { employer: "Acme Corp" },
  ...over,
});

test("autoDoneRule book-interview: a WaterlooWorks interview completes the task", () => {
  const r = autoDoneRule(biTask(), { items: { "ww:i1": interview() } });
  assert.deepEqual(r, { done: true, reason: "Interview booked on WaterlooWorks" });
});

test("autoDoneRule book-interview: non-WaterlooWorks / cancelled / other-employer do not", () => {
  const t = biTask();
  assert.equal(autoDoneRule(t, { items: { i: interview({ source: "gmail" }) } }).done, false);
  assert.equal(autoDoneRule(t, { items: { i: interview({ status: "cancelled" }) } }).done, false);
  assert.equal(
    autoDoneRule(t, { items: { i: interview({ meta: { employer: "Globex" } }) } }).done,
    false,
  );
  // ... but a merged canonical that merely *contains* WW evidence counts.
  assert.equal(
    autoDoneRule(t, {
      items: {
        i: interview({ source: "gmail", seenIn: [{ source: "waterlooworks", key: "i1" }] }),
      },
    }).done,
    true,
  );
});

test("autoDoneRule book-interview: an interview that predates the task is not the booking", () => {
  // Task first seen at t0-2d; the cutoff is a day before that.
  const old = interview({ startAt: iso(t0 - 4 * DAY) });
  assert.equal(autoDoneRule(biTask(), { items: { i: old } }).done, false);
  const inside = interview({ startAt: iso(t0 - 3 * DAY) });
  assert.equal(autoDoneRule(biTask(), { items: { i: inside } }).done, true);
});

/* --------------------------- settings gates -------------------------- */

test("todoSourceItem: action tasks honour the replies/coop toggles", () => {
  const rep = taskRaw("gmail", "r", { meta: { action: "reply" } });
  const bi = taskRaw("gmail", "b", { meta: { action: "book-interview", employer: "Acme" } });
  const sf = taskRaw("gmail", "s", { type: "deadline", org: "ECE 105", meta: { action: "submit-form" } });
  assert.equal(todoSourceItem(rep, { todos: {} }), true);
  assert.equal(todoSourceItem(rep, { todos: { replies: false } }), false);
  assert.equal(todoSourceItem(bi, { todos: { coop: false } }), false);
  assert.equal(todoSourceItem(bi, SETTINGS), true);
  assert.equal(todoSourceItem(sf, { todos: { coop: false } }), true, "form tasks are not co-op gated");
  // A non-action task stays on the old path (deadline type + deadlines off).
  const plain = taskRaw("learn", "p", { type: "deadline", meta: {} });
  assert.equal(todoSourceItem(plain, { todos: { deadlines: false } }), false);
});

/* ------------- rankings: one row per term, email suppressed ------------ */

const APP_BASE = {
  id: "waterlooworks:1",
  employer: "Acme Analog",
  jobTitle: "Hardware Engineer",
  jobId: "1",
};

test("rankings: an emailed submit-rankings task folds into the one row per term", () => {
  /** @type {Record<string, any>} */
  const items = {};
  for (const [term, days] of /** @type {[string, number[]][]} */ ([
    ["Winter 2027", [5, 9, 12, 20, 30, 40]],
    ["Spring 2027", [6, 11, 15, 25, 33, 45]],
    ["Fall 2027", [7, 14, 21, 28, 35, 50]],
  ])) {
    for (const [i, d] of days.entries()) {
      const id = `ww:${term.split(" ")[0].toLowerCase()}-${i}`;
      items[id] = {
        id,
        source: "waterlooworks",
        type: "cycle-date",
        category: "rankings-due",
        title: `Rankings close — ${term} ${i}`,
        dueAt: iso(t0 + d * DAY),
        status: "open",
        confidence: "exact",
        review: "auto",
        meta: { workTerm: term },
      };
    }
  }
  // The emailed rankings reminder sits a day after the Winter close date.
  items["gmail:rank"] = taskRaw("gmail", "rank", {
    type: "task",
    title: "WaterlooWorks: submit your rankings",
    dueAt: iso(t0 + 6 * DAY),
    meta: { action: "submit-rankings" },
  });
  const applications = {
    a1: { ...APP_BASE, id: "a1", status: "interview-scheduled", cycle: "2027 - Winter" },
    a2: { ...APP_BASE, id: "a2", status: "selected-for-interview", cycle: "Spring 2027" },
  };
  const todos = deriveTodos({ items, applications, settings: SETTINGS, now: NOW });
  const out = buildTodos({ items, todos, applications, settings: SETTINGS, now: NOW });
  const rankRows = out.groups
    .flatMap((g) => g.rows)
    .filter(
      (r) =>
        r.item.meta && (r.item.meta.auto === "rank" || r.item.meta.action === "submit-rankings"),
    );
  assert.equal(rankRows.length, 2, "one rankings row per in-flight term; email folded away");
  assert.ok(rankRows.every((r) => r.item.meta.auto === "rank"));
});
