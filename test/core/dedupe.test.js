// @ts-check
// Duplicate protection: orgsCompatible, the email↔WaterlooWorks interview
// link before clustering, the meta.onCalendar payload skip, and the
// publish-time collapse guard.

import test from "node:test";
import assert from "node:assert/strict";
import { recompute, orgsCompatible, linkEmailItems } from "../../extension/src/core/merge.js";
import { buildFeedPayload } from "../../extension/src/calendar/payload.js";
import { effectiveItem, isVisible } from "../../extension/src/core/effective.js";

const NOW = new Date("2026-01-19T16:00:00.000Z");
const nowIso = NOW.toISOString();
const MIN = 60000;
const T = NOW.getTime();

const raw = (source, key, over = {}) => ({
  id: `${source}:${key}`,
  source,
  type: "deadline",
  title: key,
  status: "open",
  confidence: "exact",
  review: "auto",
  seenIn: [{ source, key, scope: "s", at: nowIso }],
  ...over,
});

const raws = (...pairs) =>
  Object.fromEntries(pairs.map(([s, items]) => [s, { items, updatedAt: nowIso }]));

const interviewAt = (ms, over) => ({
  type: "interview",
  startAt: new Date(ms).toISOString(),
  endAt: new Date(ms + 30 * MIN).toISOString(),
  ...over,
});

/* --------------------------- orgsCompatible ---------------------------- */

test("orgsCompatible: equal course codes, empty side, containment, similarity", () => {
  assert.equal(orgsCompatible("ECE 105", "ece105"), true, "course codes normalise");
  assert.equal(orgsCompatible("Acme Corp", ""), true, "either side empty");
  assert.equal(orgsCompatible("", "MATH 117"), true);
  assert.equal(orgsCompatible("acme", "Acme Corp"), true, "compact containment");
  assert.equal(orgsCompatible("watonomous", "WATonomous"), true);
  assert.equal(orgsCompatible("Acme Analog", "Acme Analog Design"), true, "token overlap ≥0.5");
});

test("orgsCompatible: two different course codes are never compatible", () => {
  assert.equal(orgsCompatible("MATH 117", "ECE 105"), false);
  assert.equal(orgsCompatible("math117", "ECE 105"), false);
  assert.equal(orgsCompatible("CS 246", "CS 247"), false);
});

test("orgsCompatible: short containments and unrelated names stay apart", () => {
  assert.equal(orgsCompatible("ab", "Fab Lab"), false, "shorter side < 3 chars");
  assert.equal(orgsCompatible("Acme Analog", "Northwind Optics"), false);
});

/* ------------------------- merge-level dupes --------------------------- */

test("merge: 'Acme Corp' (WaterlooWorks) and 'acme' (email) interviews collapse", () => {
  const ww = raw("waterlooworks", "int-1", interviewAt(T + 26 * 3600000, {
    title: "Interview — Hardware Engineer",
    org: "Acme Corp",
    meta: { jobId: "j1" },
  }));
  const em = raw("gmail", "inv-1", interviewAt(T + 26 * 3600000, {
    title: "Interview — Hardware Engineer",
    org: "acme",
    meta: { employer: "acme" },
  }));
  const out = recompute({ raws: raws(["waterlooworks", [ww]], ["gmail", [em]]), now: NOW });
  assert.equal(Object.keys(out.items).length, 1, "one canonical item");
  const only = Object.values(out.items)[0];
  assert.deepEqual([...new Set(only.seenIn.map((s) => s.source))].sort(), ["gmail", "waterlooworks"]);

  const feed = buildFeedPayload(out.items, {}, {}, NOW);
  assert.equal(feed.count, 1, "one published event");
});

test("merge: MATH 117 and ECE 105 lectures at the same time stay separate", () => {
  const a = raw("learn", "m117-lec", {
    type: "class",
    title: "MATH 117 Lecture",
    org: "MATH 117",
    startAt: new Date(T + 3600000).toISOString(),
  });
  const b = raw("portal", "e105-lec", {
    type: "class",
    title: "ECE 105 Lecture",
    org: "ECE 105",
    startAt: new Date(T + 3600000).toISOString(),
  });
  const out = recompute({ raws: raws(["learn", [a]], ["portal", [b]]), now: NOW });
  assert.equal(Object.keys(out.items).length, 2, "a real clash stays two items");
});

test("merge: email and WaterlooWorks interviews for one application merge within 15 min", () => {
  const apps = { "waterlooworks:j9": { id: "waterlooworks:j9", employer: "Acme Analog", jobTitle: "Hardware Engineer", jobId: "j9", status: "interview-scheduled" } };
  const ww = raw("waterlooworks", "int-9", interviewAt(T + 30 * 3600000, {
    title: "Acme Analog — Hardware Engineer co-op interview",
    org: "Acme Analog",
    meta: { jobId: "j9" },
  }));
  const em = raw("gmail", "inv-9", interviewAt(T + 30 * 3600000 + 10 * MIN, {
    title: "Your interview is confirmed",
    org: "Acme Analog",
    meta: { employer: "Acme Analog" },
  }));
  const out = recompute({ raws: raws(["waterlooworks", [ww]], ["gmail", [em]]), applications: apps, now: NOW });
  assert.equal(Object.keys(out.items).length, 1, "the applicationId link merges them");
  assert.equal(Object.values(out.items)[0].meta.applicationId, "waterlooworks:j9");
});

test("merge: the same pair 40 minutes apart stays two items", () => {
  const apps = { "waterlooworks:j9": { id: "waterlooworks:j9", employer: "Acme Analog", jobTitle: "Hardware Engineer", jobId: "j9", status: "interview-scheduled" } };
  const ww = raw("waterlooworks", "int-9", interviewAt(T + 30 * 3600000, {
    title: "Acme Analog — Hardware Engineer co-op interview",
    org: "Acme Analog",
    meta: { jobId: "j9" },
  }));
  const em = raw("gmail", "inv-9", interviewAt(T + 30 * 3600000 + 40 * MIN, {
    title: "Something else entirely",
    org: "An unrelated org",
    meta: { employer: "Acme Analog" },
  }));
  const out = recompute({ raws: raws(["waterlooworks", [ww]], ["gmail", [em]]), applications: apps, now: NOW });
  assert.equal(Object.keys(out.items).length, 2, "40 min apart is a different event");
});

/* ----------------------------- onCalendar ------------------------------ */

test("payload: a meta.onCalendar item is skipped but stays visible in the panel", () => {
  const invite = raw("gmail", "inv-7", {
    type: "meeting",
    title: "Robotics design review",
    startAt: new Date(T + 2 * 86400000).toISOString(),
    meta: { onCalendar: "google" },
  });
  const other = raw("learn", "d1", { title: "A deadline", dueAt: new Date(T + 86400000).toISOString() });
  const feed = buildFeedPayload({ [invite.id]: invite, [other.id]: other }, {}, {}, NOW);
  const ids = feed.payload.events.map((e) => e.id);
  assert.deepEqual(ids, [other.id], "the onCalendar item never publishes");

  const eff = effectiveItem(invite, undefined);
  assert.equal(isVisible(eff, NOW), true, "still visible in the agenda");
});

/* --------------------------- publish guard ----------------------------- */

test("payload: the publish guard collapses a pair the merge missed", () => {
  // Two canonical items with no orgs and only ≥0.6 title similarity — under
  // memberMatch's 0.85 same-day bar for missing orgs, but over the guard's.
  const keep = raw("learn", "d1", {
    type: "meeting",
    title: "Design review meeting",
    startAt: new Date(T + 3 * 3600000).toISOString(),
  });
  const dupe = raw("discord", "d2", {
    type: "meeting",
    title: "Design review",
    startAt: new Date(T + 3 * 3600000 + 2 * MIN).toISOString(),
  });
  const items = { [keep.id]: keep, [dupe.id]: dupe };
  const feed = buildFeedPayload(items, {}, {}, NOW);
  assert.equal(feed.collapsed, 1);
  assert.equal(feed.count, 1);
  assert.equal(feed.payload.events[0].id, keep.id, "the higher-ranked (learn/api) item is kept");
});

test("payload: rank decides the survivor — on a tie the first wins", () => {
  const a = raw("discord", "d1", { type: "meeting", title: "Team sync", startAt: new Date(T + 3600000).toISOString() });
  const b = raw("portal", "d2", { type: "meeting", title: "Team sync weekly", startAt: new Date(T + 3600000).toISOString() });
  const feed = buildFeedPayload({ [a.id]: a, [b.id]: b }, {}, {}, NOW);
  assert.equal(feed.collapsed, 1);
  assert.equal(feed.payload.events[0].id, b.id, "portal (api) outranks discord (text)");
});

/* --------------------------- view-level link --------------------------- */

test("linkEmailItems: application.itemIds still collects linked email items", () => {
  const apps = { "waterlooworks:j9": { id: "waterlooworks:j9", employer: "Acme Analog", jobTitle: "Hardware Engineer", jobId: "j9", itemIds: [] } };
  const item = raw("outlook", "m1", {
    type: "offer-deadline",
    title: "Hardware Engineer — offer deadline",
    meta: { employer: "Acme Analog" },
    dueAt: new Date(T + 86400000).toISOString(),
  });
  const out = linkEmailItems({ [item.id]: item }, apps);
  assert.equal(out.items[item.id].meta.applicationId, "waterlooworks:j9");
  assert.deepEqual(out.applications["waterlooworks:j9"].itemIds, [item.id]);
});
