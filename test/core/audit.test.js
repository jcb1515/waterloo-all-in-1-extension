// @ts-check
// auditStore: every check on synthetic snapshots + fix idempotency.

import test from "node:test";
import assert from "node:assert/strict";
import { auditStore, applySafeFixes } from "../../extension/src/core/audit.js";

const NOW = new Date("2026-10-01T16:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const t0 = NOW.getTime();
const DAY = 86400000;

const item = (id, over = {}) => ({
  id,
  source: "learn",
  type: "deadline",
  title: id,
  status: "open",
  dueAt: iso(t0 + DAY),
  ...over,
});

const snap = (over = {}) => ({
  items: { a: item("a") },
  todos: {},
  projects: [],
  userState: {},
  uidMap: {},
  updates: [],
  sourceState: {},
  "raw:manual": { items: [], updatedAt: iso(t0) },
  "raw:learn": { items: [item("a")], updatedAt: iso(t0) },
  ...over,
});

const byId = (out, id) => out.issues.find((i) => i.id === id);

test("a clean snapshot reports only the storage-total info line", () => {
  const { issues, summary } = auditStore(snap(), NOW);
  assert.equal(summary.items, 1);
  assert.equal(summary.rawItems, 1);
  assert.deepEqual(issues.map((i) => i.id), ["storage-total"]);
});

test("malformed items: bad type, unknown source, inverted and unparseable dates", () => {
  const { issues } = auditStore(
    snap({
      items: {
        a: item("a", { type: "weird" }),
        b: item("b", { source: "pluto" }),
        c: item("c", { startAt: iso(t0 + DAY), endAt: iso(t0) }),
        d: item("d", { dueAt: "not a date" }),
        e: { title: "no id" },
      },
      todos: { t1: item("t1", { source: "manual", type: "task" }) },
    }),
    NOW
  );
  const m = byId({ issues }, "items-malformed");
  assert.equal(m.severity, "error");
  assert.equal(m.count, 5);
});

test("anchors more than two years out are flagged", () => {
  const { issues } = auditStore(
    snap({ items: { a: item("a"), far: item("far", { dueAt: iso(t0 + 3 * 365 * DAY) }) } }),
    NOW
  );
  assert.equal(byId({ issues }, "items-far-anchor").count, 1);
});

test("seenIn entries pointing at a missing raw are flagged", () => {
  const { issues } = auditStore(
    snap({ items: { a: item("a", { seenIn: [{ source: "portal" }, { source: "learn" }] }) } }),
    NOW
  );
  assert.equal(byId({ issues }, "items-stale-seenin").count, 1);
});

test("duplicates: publish-guard pairs warn; clashes and course-code conflicts don't", () => {
  const items = {
    a: item("a", { title: "Midterm", org: "MATH 117", startAt: iso(t0 + DAY), dueAt: undefined }),
    b: item("b", { title: "Midterm exam", org: "MATH117", startAt: iso(t0 + DAY + 60000), dueAt: undefined }),
    c: item("c", { title: "Midterm", org: "ECE 105", startAt: iso(t0 + DAY), dueAt: undefined }),
    d: item("d", { title: "Lab report", org: "MATH 117", startAt: iso(t0 + 3 * DAY), dueAt: undefined }),
  };
  const { issues } = auditStore(snap({ items }), NOW);
  const d = byId({ issues }, "duplicates");
  assert.equal(d.severity, "warn");
  assert.equal(d.fixable, false);
  // a~b match (same course code, similar title, 1 min apart); a~c don't
  // (different course codes); nothing pairs with d (3 days away).
  assert.equal(d.count, 1);
});

test("raws: unknown keys warn, malformed raw records error", () => {
  const { issues } = auditStore(
    snap({ "raw:mystery": { items: [] }, "raw:learn": "garbage" }),
    NOW
  );
  assert.equal(byId({ issues }, "raw-unknown").count, 1);
  assert.equal(byId({ issues }, "raw-malformed").severity, "error");
});

test("userState orphans prune only dead ids with no recent activity", () => {
  const userState = {
    a: { done: true, doneAt: iso(t0 - 100 * DAY) }, // live item — kept
    gone_old: { done: true, doneAt: iso(t0 - 100 * DAY) },
    gone_fresh: { done: true, doneAt: iso(t0 - 10 * DAY) }, // recent — kept
    gone_no_dates: { notes: "x" }, // no activity at all — orphan
  };
  const s = snap({ userState });
  assert.equal(byId({ issues: auditStore(s, NOW).issues }, "userstate-orphans").count, 2);
  const patches = applySafeFixes(s, ["userstate-orphans"], NOW);
  assert.deepEqual(Object.keys(patches.userState).sort(), ["a", "gone_fresh"]);
});

test("onboarding userState keys are known, dated and never pruned", () => {
  const userState = {
    onboardingDismissedAt: iso(t0 - 100 * DAY), // old but a known meta key
    nudgeSnooze: { "portal:portal-open": iso(t0 - 20 * DAY) },
    gone_no_dates: { notes: "x" },
  };
  const s = snap({ userState });
  const iss = auditStore(s, NOW).issues;
  assert.equal(byId({ issues: iss }, "userstate-orphans").count, 1);
  assert.equal(byId({ issues: iss }, "userstate-onboarding-bad"), undefined);
  const patches = applySafeFixes(s, ["userstate-orphans"], NOW);
  assert.deepEqual(Object.keys(patches.userState).sort(), [
    "nudgeSnooze",
    "onboardingDismissedAt",
  ]);
});

test("invalid onboarding dates flag and fix", () => {
  const userState = {
    onboardingDismissedAt: "not-a-date",
    nudgeSnooze: { good: iso(t0), bad: "??", worse: 42 },
  };
  const s = snap({ userState });
  const iss = byId({ issues: auditStore(s, NOW).issues }, "userstate-onboarding-bad");
  assert.equal(iss.count, 3);
  assert.equal(iss.fixable, true);
  const patches = applySafeFixes(s, ["userstate-onboarding-bad"], NOW);
  assert.equal(patches.userState.onboardingDismissedAt, undefined);
  assert.deepEqual(patches.userState.nudgeSnooze, { good: iso(t0) });
});

test("uidMap tombstones prune, keeping the newest 5000", () => {
  /** @type {Record<string, any>} */
  const uidMap = { a: { uid: "u", seq: 0, hash: "h" } };
  for (let i = 0; i < 10; i++) uidMap[`dead_${i}`] = { uid: `u${i}`, seq: 0, hash: "h" };
  const s = snap({ uidMap });
  assert.equal(byId({ issues: auditStore(s, NOW).issues }, "uidmap-orphans").count, 10);
  const patches = applySafeFixes(s, ["uidmap-orphans"], NOW);
  assert.deepEqual(Object.keys(patches.uidMap), ["a"]);
});

test("reminder records older than 30 days prune", () => {
  const s = snap({
    remindersSent: { old: iso(t0 - 40 * DAY), fresh: iso(t0 - 5 * DAY), junk: "not-a-date" },
    reminderSnooze: { old: iso(t0 - 40 * DAY) },
  });
  assert.equal(byId({ issues: auditStore(s, NOW).issues }, "reminders-stale").count, 3);
  const patches = applySafeFixes(s, ["reminders-stale"], NOW);
  assert.deepEqual(patches.remindersSent, { fresh: iso(t0 - 5 * DAY) });
  assert.deepEqual(patches.reminderSnooze, {});
});

test("items of a deleted project get projectId cleared in raw:manual", () => {
  const raw = {
    items: [
      { id: "manual:x", type: "task", meta: { projectId: "gone", note: 1 } },
      { id: "manual:y", type: "task", meta: { projectId: "proj_a" } },
    ],
    updatedAt: iso(t0),
  };
  const s = snap({
    projects: [{ id: "proj_a", name: "A" }],
    items: { "manual:x": item("manual:x", { source: "manual", type: "task", meta: { projectId: "gone" } }) },
    "raw:manual": raw,
  });
  const iss = byId({ issues: auditStore(s, NOW).issues }, "projectitem-orphans");
  assert.equal(iss.count, 1);
  const patches = applySafeFixes(s, ["projectitem-orphans"], NOW);
  assert.equal(patches["raw:manual"].items[0].meta.projectId, undefined);
  assert.equal(patches["raw:manual"].items[0].meta.note, 1);
  assert.equal(patches["raw:manual"].items[1].meta.projectId, "proj_a");
});

test("caps: updates and logs trim", () => {
  const s = snap({
    updates: new Array(305).fill({ id: "u" }),
    "log:learn": new Array(120).fill({ at: iso(t0), message: "x" }),
  });
  assert.ok(byId({ issues: auditStore(s, NOW).issues }, "updates-cap"));
  assert.ok(byId({ issues: auditStore(s, NOW).issues }, "log-cap"));
  const patches = applySafeFixes(s, ["updates-cap", "log-cap"], NOW);
  assert.equal(patches.updates.length, 300);
  assert.equal(patches["log:learn"].length, 100);
});

test("caps: a fat sourceState and large outline files warn", () => {
  const s = snap({
    sourceState: { discord: { state: { blob: "x".repeat(1.6 * 1024 * 1024) } } },
    outlineFiles: [{ id: "o1", size: 9 * 1024 * 1024 }],
  });
  const iss = auditStore(s, NOW).issues;
  assert.ok(byId({ issues: iss }, "sourcestate-big"));
  assert.ok(byId({ issues: iss }, "outlinefiles-big"));
});

test("unknown settings keys list as info; malformed settings error", () => {
  const s = snap({ wa1Settings: { theme: "dark", mystery: 1 } });
  assert.equal(byId({ issues: auditStore(s, NOW).issues }, "settings-unknown-keys").count, 1);
  const s2 = snap({ wa1Settings: "junk" });
  assert.equal(byId({ issues: auditStore(s2, NOW).issues }, "settings-malformed").severity, "error");
});

test("secrets: updateToken/Bearer outside calendarFeed is an error", () => {
  const ok = auditStore(snap({ calendarFeed: { updateToken: "tok_123" } }), NOW);
  assert.equal(byId({ issues: ok.issues }, "secrets-leak"), undefined);
  const bad = auditStore(
    snap({ "log:learn": [{ message: "sent updateToken=abc" }] }),
    NOW
  );
  const leak = byId({ issues: bad.issues }, "secrets-leak");
  assert.equal(leak.severity, "error");
  assert.deepEqual(leak.sample, ["log:learn"]);
});

test("fixes are idempotent: a second audit finds nothing left to fix", () => {
  const s = snap({
    userState: { gone: { done: true, doneAt: iso(t0 - 100 * DAY) } },
    uidMap: { dead: { uid: "u", seq: 0, hash: "h" } },
    remindersSent: { old: iso(t0 - 40 * DAY) },
    updates: new Array(305).fill({ id: "u" }),
    "log:learn": new Array(120).fill({ at: iso(t0), message: "x" }),
  });
  const patches = applySafeFixes(s, undefined, NOW);
  const after = { ...s, ...patches };
  const rerun = auditStore(after, NOW);
  assert.equal(rerun.issues.filter((i) => i.fixable).length, 0);
  const again = applySafeFixes(after, undefined, NOW);
  assert.deepEqual(again, {});
});
