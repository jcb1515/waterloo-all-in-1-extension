// @ts-check
// Cross-source integration: the same real-world events seen by several
// sources must merge into one canonical item each (two for the genuine
// lecture clash), need zero publish-guard collapses, and produce zero
// auditStore duplicate warnings. Field precedence: exact times win, Portal's
// room wins for exams, WaterlooWorks wins an interview's moved time.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { recompute } from "../../extension/src/core/merge.js";
import { buildFeedPayload } from "../../extension/src/calendar/payload.js";
import { auditStore } from "../../extension/src/core/audit.js";

const NOW = new Date("2026-10-15T16:00:00.000Z");
const nowIso = NOW.toISOString();
const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/crosssource");

/** @param {string} name fixture file without .json */
const scenario = (name) =>
  JSON.parse(readFileSync(path.join(DIR, `${name}.json`), "utf8"));

const SCENARIOS = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""));

/** Wraps a scenario's `raws` into raw records ({items, updatedAt}). */
const rawRecords = (scn) =>
  Object.fromEntries(
    Object.entries(scn.raws || {}).map(([src, rec]) => [
      src,
      { items: rec.items || [], updatedAt: nowIso },
    ])
  );

/** @param {any} scn */
const merge = (scn) =>
  recompute({
    raws: rawRecords(scn),
    applications: scn.applications || {},
    now: NOW,
  });

/** Canonical item(s) whose cluster contains a given raw item id. */
const canonOf = (out, rawId) => out.items[out.links[rawId]];

/* ------------------------------ combined run ------------------------------ */

test("all scenarios merged: exactly one canonical per real event, two for the clash", () => {
  /** @type {Record<string, any>} */
  const raws = {};
  /** @type {Record<string, any>} */
  const applications = {};
  for (const name of SCENARIOS) {
    const scn = scenario(name);
    for (const [src, rec] of Object.entries(rawRecords(scn))) {
      if (!raws[src]) raws[src] = rec;
      else raws[src].items.push(...rec.items);
    }
    Object.assign(applications, scn.applications || {});
  }
  const out = recompute({ raws, applications, now: NOW });
  const ids = Object.keys(out.items);
  // 6 events: midterm, acme interview, acme reply task, watonomous, ece190,
  // two lectures, moved interview = 8 canonical items.
  assert.equal(ids.length, 8, `expected 8 canonical items, got ${ids.join(", ")}`);

  // Zero publish-guard collapses: the merge engine resolved every duplicate.
  const feed = buildFeedPayload(out.items, {}, {}, NOW, { acceptPending: true });
  assert.equal(feed.collapsed, 0, "publish guard should have nothing left to collapse");

  // Zero duplicate warnings from the store audit over the merged snapshot.
  const snapshot = { items: out.items };
  for (const [src, rec] of Object.entries(raws)) snapshot[`raw:${src}`] = rec;
  const report = auditStore(snapshot, NOW);
  const dup = report.issues.find((i) => i.id === "duplicates");
  assert.equal(dup, undefined, `auditStore reported duplicates: ${dup && dup.message}`);
});

/* ------------------------------ per scenario ------------------------------ */

test("MATH 117 midterm: 4 sources -> one exam; exact time and Portal room win", () => {
  const out = merge(scenario("math117-midterm"));
  assert.equal(Object.keys(out.items).length, 1);
  const it = canonOf(out, "learn:m117-midterm");
  assert.ok(it);
  assert.equal(it.type, "exam");
  // Exact members (Learn/Portal/outline) win over the email's tentative +30m.
  assert.equal(it.startAt, "2026-10-23T23:00:00.000Z");
  assert.equal(it.endAt, "2026-10-24T01:00:00.000Z");
  // Exams take the Portal member's seating room.
  assert.equal(it.location, "MC 2034");
  // Every source is visible in seenIn.
  const sources = new Set(it.seenIn.map((s) => s.source));
  for (const s of ["learn", "outline", "portal", "outlook"]) assert.ok(sources.has(s), s);
});

test("Acme interview: WW list+detail + Gmail invite merge; the reply task stays separate", () => {
  const out = merge(scenario("acme-interview"));
  assert.equal(Object.keys(out.items).length, 2);
  const it = canonOf(out, "waterlooworks:intv-2384");
  assert.ok(it);
  assert.equal(it.type, "interview");
  assert.equal(it.startAt, "2026-10-20T18:00:00.000Z");
  const sources = new Set(it.seenIn.map((s) => s.source));
  assert.deepEqual([...sources].sort(), ["gmail", "waterlooworks"]);
  // The Gmail member's link + onCalendar flag apply cluster-wide.
  assert.equal(it.meta.applicationId, "app-2384");
  assert.equal(it.meta.onCalendar, "google");
  const task = canonOf(out, "outlook:msg-9902");
  assert.ok(task);
  assert.equal(task.type, "task");
  // The interview canonical is skipped by the feed (Google already has it);
  // the pending reply task is skipped too — nothing publishes.
  const feed = buildFeedPayload(out.items, {}, {}, NOW);
  assert.equal(feed.collapsed, 0);
  assert.equal(feed.count, 0);
});

test("WATonomous meeting: Discord event + Gmail invite -> one item", () => {
  const out = merge(scenario("watonomous-meeting"));
  assert.equal(Object.keys(out.items).length, 1);
  const it = canonOf(out, "discord:evt-42");
  assert.equal(it.type, "meeting");
  assert.equal(it.startAt, "2026-10-21T23:00:00.000Z");
  const sources = new Set(it.seenIn.map((s) => s.source));
  assert.deepEqual([...sources].sort(), ["discord", "gmail"]);
});

test("ECE 190 deliverable: Learn + outline -> one deadline with the outline's weight", () => {
  const out = merge(scenario("ece190-deliverable"));
  assert.equal(Object.keys(out.items).length, 1);
  const it = canonOf(out, "learn:e190-d2p3");
  assert.equal(it.type, "deadline");
  assert.equal(it.dueAt, "2026-10-31T03:59:00.000Z");
  assert.equal(it.weight, 10);
});

test("lecture clash: different course codes at the same time stay two items", () => {
  const out = merge(scenario("lecture-clash"));
  assert.equal(Object.keys(out.items).length, 2);
  const feed = buildFeedPayload(out.items, {}, {}, NOW);
  assert.equal(feed.collapsed, 0, "the publish guard must not collapse a real clash");
  assert.equal(feed.count, 2);
});

test("moved interview: merges anyway and WaterlooWorks wins the new time", () => {
  const out = merge(scenario("interview-moved"));
  assert.equal(Object.keys(out.items).length, 1);
  const it = canonOf(out, "waterlooworks:intv-2401");
  assert.equal(it.type, "interview");
  // The stale email's 18:00Z slot loses to the WaterlooWorks 20:00Z start.
  assert.equal(it.startAt, "2026-10-22T20:00:00.000Z");
  assert.equal(it.endAt, "2026-10-22T20:45:00.000Z");
  const sources = new Set(it.seenIn.map((s) => s.source));
  assert.deepEqual([...sources].sort(), ["outlook", "waterlooworks"]);
});
