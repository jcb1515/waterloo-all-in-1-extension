// @ts-check
// Projects: normalisation, name matching, upsert/delete folds and progress.

import test from "node:test";
import assert from "node:assert/strict";
import {
  newProjectId,
  normalizeProject,
  projectByName,
  projectDueItemId,
  stripProjectPrefix,
  upsertProjectFold,
  deleteProjectFold,
  projectProgress,
  itemProject,
  archivedProjectItem,
} from "../../extension/src/core/projects.js";
import { buildAgenda } from "../../extension/src/panel/model/agenda.js";

const DAY = 86400000;
const NOW = new Date("2026-01-19T16:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const t0 = NOW.getTime();

const proj = (over = {}) => ({
  id: "proj_a",
  name: "CommuniHacks",
  color: 3,
  status: "active",
  calendar: true,
  createdAt: iso(t0),
  ...over,
});

const pitem = (id, over = {}) => ({
  id,
  source: "manual",
  type: "task",
  title: id,
  org: "CommuniHacks",
  status: "open",
  meta: { projectId: "proj_a" },
  ...over,
});

test("normalizeProject: defaults, wraps and coerces", () => {
  const p = normalizeProject({ name: "  Thing  ", color: 99, dueAt: "junk", status: "weird" });
  assert.equal(p.name, "Thing");
  assert.equal(p.color, 3, "colour wraps into the palette range");
  assert.equal(p.dueAt, undefined, "junk dates dropped");
  assert.equal(p.status, "active");
  assert.equal(p.calendar, true);
  assert.ok(p.id.startsWith("proj_"));
  assert.equal(normalizeProject({}), null);
  assert.equal(normalizeProject(null), null);
  assert.equal(normalizeProject({ name: "x", calendar: false }).calendar, false);
});

test("projectByName + stripProjectPrefix match names loosely", () => {
  const projects = [proj(), { ...proj(), id: "proj_b", name: "UWASIC tapeout prep" }];
  assert.equal(projectByName(projects, "communihacks").id, "proj_a");
  assert.equal(projectByName(projects, "uwasic tapeout"), null, "exact names only");
  assert.equal(projectByName(projects, "unknown"), null);

  const hit = stripProjectPrefix("#CommuniHacks finish the poster", projects);
  assert.equal(hit.project.id, "proj_a");
  assert.equal(hit.text, "finish the poster");
  assert.equal(stripProjectPrefix("#uwasic order parts", projects).project.id, "proj_b",
    "first-word prefix match");
  assert.equal(stripProjectPrefix("no prefix", projects).project, null);
});

test("upsertProjectFold: creates the due item and renames rewrite org", () => {
  // New project with a due date -> due item.
  let { projects, items } = upsertProjectFold([], [], normalizeProject({
    name: "Hack", color: 2, dueAt: iso(t0 + 7 * DAY), allDay: true,
  }));
  assert.equal(projects.length, 1);
  const due = items.find((i) => i.id === projectDueItemId(projects[0].id));
  assert.ok(due, "due item created");
  assert.equal(due.meta.projectId, projects[0].id);
  assert.equal(due.title, "Hack due");
  assert.equal(due.type, "deadline");
  assert.equal(due.allDay, true);

  // Clear the due date -> the due item is removed.
  ({ projects, items } = upsertProjectFold(projects, items, { ...projects[0], dueAt: null }));
  assert.ok(!projects[0].dueAt);
  assert.equal(items.find((i) => i.id === projectDueItemId(projects[0].id)), undefined);

  // Rename -> member items get the new org.
  const raw = [pitem("a"), pitem("b"), { id: "other", source: "manual", org: "x" }];
  const renamed = upsertProjectFold([proj()], raw, { ...proj(), name: "CommuniHacks 2" });
  assert.equal(renamed.projects[0].name, "CommuniHacks 2");
  const reorged = renamed.items.filter((i) => i.org === "CommuniHacks 2").map((i) => i.id).sort();
  assert.deepEqual(reorged, ["a", "b"], "only project items re-orged");
  assert.equal(renamed.items.find((i) => i.id === "other").org, "x");

  // No rename -> items untouched.
  const same = upsertProjectFold([proj()], raw, { ...proj(), color: 4 });
  assert.equal(same.items.length, raw.length);
});

test("deleteProjectFold: removes every project item and drops the project", () => {
  const projects = [proj(), { ...proj(), id: "proj_b", name: "Other" }];
  const raw = [
    pitem("a"), pitem("b"),
    { ...pitem("due"), id: projectDueItemId("proj_a"), meta: { projectId: "proj_a" } },
    { id: "keep", source: "manual" },
  ];
  const out = deleteProjectFold(projects, raw, "proj_a");
  assert.deepEqual(out.projects.map((p) => p.id), ["proj_b"]);
  assert.deepEqual(out.items.map((i) => i.id), ["keep"], "due item goes with the project");
  const untouched = deleteProjectFold(projects, raw, "nope");
  assert.equal(untouched.items.length, raw.length);
});

test("projectProgress: counts, next open item and due countdown", () => {
  const project = proj({ dueAt: iso(t0 + 10 * DAY) });
  const items = {
    done1: pitem("done1", { status: "done" }),
    next: pitem("next", { dueAt: iso(t0 + 2 * DAY) }),
    later: pitem("later", { dueAt: iso(t0 + 5 * DAY) }),
    undated: pitem("undated"),
  };
  const out = projectProgress(project, items, {}, NOW);
  assert.equal(out.total, 4);
  assert.equal(out.done, 1);
  assert.equal(out.next.id, "next");
  assert.equal(out.lateDays, 0);

  assert.equal(projectProgress(proj(), items, {}, NOW).dueAt, null);
  assert.equal(projectProgress(proj({ dueAt: iso(t0 - 3 * DAY) }), items, {}, NOW).lateDays, 3);
  // userState.done counts too.
  const st = projectProgress(project, items, { next: { done: true } }, NOW);
  assert.equal(st.done, 2);
  assert.equal(st.next.id, "later");
});

test("newProjectId is unique and prefixed", () => {
  const a = newProjectId();
  assert.match(a, /^proj_/);
  assert.notEqual(a, newProjectId());
});

test("archivedProjectItem: archived hides, active/done and non-project items do not", () => {
  const projects = [
    proj({ id: "p1", status: "archived" }),
    proj({ id: "p2", status: "done" }),
  ];
  assert.equal(archivedProjectItem(pitem("x", { meta: { projectId: "p1" } }), projects), true);
  assert.equal(archivedProjectItem(pitem("x", { meta: { projectId: "p2" } }), projects), false);
  assert.equal(archivedProjectItem(pitem("x"), projects), false);
  assert.equal(itemProject(pitem("x", { meta: { projectId: "p1" } }), projects).status, "archived");
});

test("buildAgenda hides archived-project items; done-project items stay", () => {
  const projects = [
    proj({ id: "p1", status: "archived" }),
    proj({ id: "p2", status: "done" }),
  ];
  const items = {
    a: pitem("a", { dueAt: iso(t0 + 2 * 3600000), meta: { projectId: "p1" } }),
    b: pitem("b", { dueAt: iso(t0 + 2 * 3600000), meta: { projectId: "p2" } }),
    c: pitem("c", { dueAt: iso(t0 + 2 * 3600000) }),
  };
  const ag = buildAgenda({ items, now: NOW, projects });
  const ids = ag.groups.flatMap((g) => g.rows.map((r) => r.id)).sort();
  assert.deepEqual(ids, ["b", "c"]);
});
