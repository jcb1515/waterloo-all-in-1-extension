// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import {
  onboardingRows,
  nudges,
  sourceEnabled,
  lastGoodRead,
  sourceFreshness,
} from "../../extension/src/panel/model/onboarding.js";

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

/* --------------------- opened / lastGoodRead / freshness --------------------- */

test("opened-only row: done with status 'opened', no read evidence", () => {
  const s = base();
  s.userState.onboardingOpened = { "learn:learn-home": ago(1) };
  const rows = onboardingRows(s, NOW);
  const home = rows.find((r) => r.row.id === "learn-home");
  assert.equal(home?.done, true);
  assert.equal(home?.read, false);
  assert.equal(home?.status, "opened");
  assert.equal(home?.openedAt, ago(1));
  // Unread evidence stays null — opened is not a read.
  assert.equal(home?.lastOkAt, null);
});

test("read wins over opened for status; todo when neither", () => {
  const s = base();
  s.userState.onboardingOpened = { "portal:portal-open": ago(1) };
  s.sourceState = { portal: { scopeOkAt: { "portal:schedule": ago(2) } } };
  const open = onboardingRows(s, NOW).find((r) => r.row.id === "portal-open");
  assert.equal(open?.status, "read");
  assert.equal(open?.done, true);
  const home = onboardingRows(s, NOW).find((r) => r.row.id === "learn-home");
  assert.equal(home?.status, "todo");
  assert.equal(home?.done, false);
});

test("scopeReadAt marks a row read — a zero-item read is still a read", () => {
  const s = base();
  s.sourceState = { portal: { scopeReadAt: { "portal:schedule": ago(2) } } };
  const open = onboardingRows(s, NOW).find((r) => r.row.id === "portal-open");
  assert.equal(open?.done, true);
  assert.equal(open?.read, true);
  assert.equal(open?.status, "read");
  assert.equal(open?.lastOkAt, ago(2));
});

test("lastGoodRead: newest of probe, scopeOkAt, scopeReadAt; sync rows read 'sync'", () => {
  const s = base();
  s.probes = { portal: { "portal-open": { ok: true, at: ago(40) } } };
  s.sourceState = {
    portal: {
      scopeOkAt: { "portal:schedule": ago(30) },
      scopeReadAt: { "portal:schedule": ago(5) },
    },
    learn: { scopeReadAt: { sync: ago(3) } },
  };
  const rows = onboardingRows(s, NOW);
  const open = rows.find((r) => r.row.id === "portal-open");
  const home = rows.find((r) => r.row.id === "learn-home");
  assert.equal(open?.lastOkAt, ago(5));
  assert.equal(lastGoodRead(s, "portal", open?.row), ago(5));
  // learn-home has no stat.scope — its "sync" scopeReadAt satisfies it.
  assert.equal(home?.done, true);
  assert.equal(home?.status, "read");
  assert.equal(lastGoodRead(s, "learn", home?.row), ago(3));
});

test("nudges count scopeReadAt age the same as scopeOkAt", () => {
  const s = base();
  s.sourceState = { portal: { scopeReadAt: { "portal:schedule": ago(20) } } };
  const n = nudges(s, NOW);
  assert.equal(n.length, 1);
  assert.equal(n[0].row.id, "portal-open");
  assert.ok(n[0].ageDays > 14);
});

test("sourceFreshness: fresh / never / opened 10 min / opened 40 min", () => {
  const fresh = base();
  fresh.sourceState = { portal: { scopeReadAt: { "portal:schedule": ago(1) } } };
  assert.deepEqual(sourceFreshness(fresh, "portal", NOW), {
    key: "fresh",
    lastReadAt: ago(1),
  });

  // lastOkAt also feeds the fresh bucket.
  const viaLastOk = base();
  viaLastOk.sourceState = { portal: { lastOkAt: ago(1) } };
  assert.equal(sourceFreshness(viaLastOk, "portal", NOW).key, "fresh");

  assert.equal(sourceFreshness(base(), "portal", NOW).key, "never");

  const waiting = base();
  waiting.userState.onboardingOpened = {
    "portal:portal-open": new Date(NOW.getTime() - 10 * 60000).toISOString(),
  };
  assert.equal(sourceFreshness(waiting, "portal", NOW).key, "opened-waiting");

  const nothing = base();
  nothing.userState.onboardingOpened = {
    "portal:portal-open": new Date(NOW.getTime() - 40 * 60000).toISOString(),
  };
  assert.equal(sourceFreshness(nothing, "portal", NOW).key, "opened-nothing");
});

test("tile/nudge parity: needs-visit iff an unsnoozed-stale row exists", () => {
  const s = base();
  s.sourceState = { portal: { scopeOkAt: { "portal:schedule": ago(20) } } };
  // Stale beyond refreshDays=14, unsnoozed: nudge + tile agree.
  assert.equal(nudges(s, NOW).some((n) => n.source === "portal"), true);
  assert.equal(sourceFreshness(s, "portal", NOW).key, "needs-visit");
  // A fresh source never claims needs-visit.
  assert.equal(sourceFreshness(s, "learn", NOW).key, "never");
  assert.equal(nudges(s, NOW).some((n) => n.source === "learn"), false);
});

test("a snoozed stale row leaves the tile on needs-visit while the nudge hides", () => {
  const s = base();
  s.sourceState = { portal: { scopeOkAt: { "portal:schedule": ago(20) } } };
  s.userState.nudgeSnooze = { "portal:portal-open": ago(-3) }; // 3d in future
  assert.equal(nudges(s, NOW).length, 0);
  assert.equal(sourceFreshness(s, "portal", NOW).key, "needs-visit");
});
