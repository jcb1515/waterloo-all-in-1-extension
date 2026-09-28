// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { onboardingRows, nudges, sourceEnabled } from "../../extension/src/panel/model/onboarding.js";

const NOW = new Date("2026-09-28T15:00:00.000Z");
const ago = (days) => new Date(NOW.getTime() - days * 86400000).toISOString();

/** A state with learn-home + both portal rows unread unless overridden. */
const base = () => ({
  settings: { sources: {} },
  items: {},
  probes: {},
  sourceState: {},
  userState: {},
});

test("enabled source rules: gcal opt-in, everyone else opt-out", () => {
  assert.equal(sourceEnabled({ sources: {} }, "gcal"), false);
  assert.equal(sourceEnabled({ sources: { gcal: { enabled: true } } }, "gcal"), true);
  assert.equal(sourceEnabled({ sources: {} }, "portal"), true);
  assert.equal(sourceEnabled({ sources: { portal: { enabled: false } } }, "portal"), false);
  assert.equal(sourceEnabled(null, "portal"), true);
  assert.equal(sourceEnabled(undefined, "gcal"), false);
});

test("onboardingRows covers essential rows of enabled sources", () => {
  const rows = onboardingRows(base(), NOW);
  const ids = rows.map((r) => `${r.source}:${r.row.id}`);
  assert.ok(ids.includes("learn:learn-home"));
  assert.ok(ids.includes("portal:portal-schedule"));
  assert.ok(ids.includes("portal:portal-exams"));
  // non-essential rows never appear
  assert.ok(!ids.includes("learn:learn-course"));
  for (const r of rows) assert.equal(r.done, false);
});

test("a disabled source drops all its rows", () => {
  const s = base();
  s.settings.sources = { portal: { enabled: false } };
  const ids = onboardingRows(s, NOW).map((r) => r.source);
  assert.ok(!ids.includes("portal"));
  assert.ok(ids.includes("learn"));
});

test("done via probe.ok (any age) or scopeOkAt; lastOkAt picks the newer", () => {
  const s = base();
  // learn-home has no stat scope — a page probe satisfies it
  s.probes = {
    learn: { "learn-home": { ok: true, at: ago(60) } },
    portal: { "portal-schedule": { ok: true, at: ago(40) } },
  };
  s.sourceState = {
    portal: { scopeOkAt: { "portal:schedule": ago(10), "portal:exams": ago(5) } },
  };
  const rows = onboardingRows(s, NOW);
  const home = rows.find((r) => r.row.id === "learn-home");
  const sched = rows.find((r) => r.row.id === "portal-schedule");
  const exams = rows.find((r) => r.row.id === "portal-exams");
  assert.equal(home?.done, true);
  assert.equal(home?.lastOkAt, ago(60));
  // probe at 40d, scopeOkAt at 10d -> newer wins
  assert.equal(sched?.done, true);
  assert.equal(sched?.lastOkAt, ago(10));
  // scopeOkAt alone satisfies a stat row
  assert.equal(exams?.done, true);
  assert.equal(exams?.lastOkAt, ago(5));
});

test("missing probes/sourceState/userState never crash and leave rows unread", () => {
  const rows = onboardingRows({ settings: { sources: {} } }, NOW);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => !r.done && r.lastOkAt == null));
  assert.deepEqual(nudges({ settings: { sources: {} } }, NOW), []);
});

test("nudges: refreshDays rows older than the window, oldest first", () => {
  const s = base();
  s.sourceState = {
    portal: { scopeOkAt: { "portal:schedule": ago(40), "portal:exams": ago(16) } },
  };
  const n = nudges(s, NOW);
  assert.equal(n.length, 2);
  // schedule (refreshDays 30, age 40) before exams (refreshDays 14, age 16)
  assert.equal(n[0].row.id, "portal-schedule");
  assert.equal(n[1].row.id, "portal-exams");
  assert.ok(n[0].ageDays > 30);
});

test("nudges: exactly refreshDays old is NOT stale", () => {
  const s = base();
  s.sourceState = {
    portal: { scopeOkAt: { "portal:exams": ago(14), "portal:schedule": ago(30) } },
  };
  assert.deepEqual(nudges(s, NOW), []);
});

test("nudges: never-read rows belong to onboarding, not nudges", () => {
  assert.deepEqual(nudges(base(), NOW), []);
});

test("nudges: snoozed rows are dropped until the snooze expires", () => {
  const mk = () => {
    const s = base();
    s.sourceState = { portal: { scopeOkAt: { "portal:exams": ago(20) } } };
    return s;
  };
  const active = mk();
  active.userState.nudgeSnooze = { "portal:portal-exams": ago(-3) }; // 3d in the future
  assert.equal(nudges(active, NOW).length, 0);
  const expired = mk();
  expired.userState.nudgeSnooze = { "portal:portal-exams": ago(1) }; // ended yesterday
  assert.equal(nudges(expired, NOW).length, 1);
});

test("nudges: disabled source produces no rows", () => {
  const s = base();
  s.settings.sources = { portal: { enabled: false } };
  s.sourceState = { portal: { scopeOkAt: { "portal:exams": ago(90) } } };
  assert.deepEqual(nudges(s, NOW), []);
});
