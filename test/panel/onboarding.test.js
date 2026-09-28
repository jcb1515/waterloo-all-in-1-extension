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
  assert.ok(ids.includes("portal:portal-open"));
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
  // learn-home has no stat scope — a page probe satisfies it; portal-open
  // has both a probe hit (40d) and a scopeOkAt (10d) — the newer wins.
  s.probes = {
    learn: { "learn-home": { ok: true, at: ago(60) } },
    portal: { "portal-open": { ok: true, at: ago(40) } },
  };
  s.sourceState = {
    portal: { scopeOkAt: { "portal:schedule": ago(10) } },
  };
  const rows = onboardingRows(s, NOW);
  const home = rows.find((r) => r.row.id === "learn-home");
  const open = rows.find((r) => r.row.id === "portal-open");
  assert.equal(home?.done, true);
  assert.equal(home?.lastOkAt, ago(60));
  assert.equal(open?.done, true);
  assert.equal(open?.lastOkAt, ago(10));

  // scopeOkAt alone satisfies a stat row (no probe hit at all)
  const s2 = base();
  s2.sourceState = { portal: { scopeOkAt: { "portal:schedule": ago(5) } } };
  const open2 = onboardingRows(s2, NOW).find((r) => r.row.id === "portal-open");
  assert.equal(open2?.done, true);
  assert.equal(open2?.lastOkAt, ago(5));
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
    portal: { scopeOkAt: { "portal:schedule": ago(40) } },
  };
  // A second stale row from another enabled source keeps the ordering check.
  s.probes = { waterlooworks: { applications: { ok: true, at: ago(10) } } };
  const n = nudges(s, NOW);
  assert.equal(n.length, 2);
  // portal-open (last read 40d ago) before applications (10d ago)
  assert.equal(n[0].row.id, "portal-open");
  assert.equal(n[1].row.id, "applications");
  assert.ok(n[0].ageDays > 14);
});

test("nudges: exactly refreshDays old is NOT stale", () => {
  const s = base();
  s.sourceState = {
    portal: { scopeOkAt: { "portal:schedule": ago(14) } },
  };
  assert.deepEqual(nudges(s, NOW), []);
});

test("nudges: never-read rows belong to onboarding, not nudges", () => {
  assert.deepEqual(nudges(base(), NOW), []);
});

test("nudges: snoozed rows are dropped until the snooze expires", () => {
  const mk = () => {
    const s = base();
    s.sourceState = { portal: { scopeOkAt: { "portal:schedule": ago(20) } } };
    return s;
  };
  const active = mk();
  active.userState.nudgeSnooze = { "portal:portal-open": ago(-3) }; // 3d in the future
  assert.equal(nudges(active, NOW).length, 0);
  const expired = mk();
  expired.userState.nudgeSnooze = { "portal:portal-open": ago(1) }; // ended yesterday
  assert.equal(nudges(expired, NOW).length, 1);
});

test("nudges: disabled source produces no rows", () => {
  const s = base();
  s.settings.sources = { portal: { enabled: false } };
  s.sourceState = { portal: { scopeOkAt: { "portal:schedule": ago(90) } } };
  assert.deepEqual(nudges(s, NOW), []);
});
