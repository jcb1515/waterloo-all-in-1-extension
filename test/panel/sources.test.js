// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { sourceStatus } from "../../extension/src/panel/model/sources.js";

const NOW = new Date("2026-09-27T16:00:00.000Z");
const HOUR = 3600000;
const iso = (ms) => new Date(ms).toISOString();

const adapter = (id, intervalMinutes) => ({
  id,
  label: id,
  origins: [],
  intervalMinutes,
  syncOnTabOpen: false,
});

const st = (over = {}) => ({
  lastRunAt: iso(NOW.getTime() - 20 * 60000),
  lastOkAt: iso(NOW.getTime() - 20 * 60000),
  session: "signed-in",
  complete: true,
  ...over,
});

test("passive adapters ignore complete:false — age of lastOkAt decides", () => {
  const discord = adapter("discord", 0);
  const s = sourceStatus(discord, st({ complete: false }), "live", NOW);
  assert.equal(s.key, "connected");

  // Never synced -> stale.
  assert.equal(
    sourceStatus(discord, st({ lastOkAt: null, complete: false }), "live", NOW).key,
    "stale",
  );
  // Older than 24 h -> stale.
  assert.equal(
    sourceStatus(discord, st({ lastOkAt: iso(NOW.getTime() - 25 * HOUR) }), "live", NOW).key,
    "stale",
  );
  // Inside 24 h -> connected.
  assert.equal(
    sourceStatus(discord, st({ lastOkAt: iso(NOW.getTime() - 23 * HOUR) }), "live", NOW).key,
    "connected",
  );
});

test("actively synced adapters keep the complete:false -> stale rule", () => {
  const outline = adapter("outline", 1440);
  assert.equal(
    sourceStatus(outline, st({ complete: false }), "live", NOW).key,
    "stale",
  );
  assert.equal(sourceStatus(outline, st(), "live", NOW).key, "connected");
});

test("signed-out and error still win for passive adapters", () => {
  const discord = adapter("discord", 0);
  assert.equal(
    sourceStatus(discord, st({ session: "signed-out" }), "live", NOW).key,
    "signed-out",
  );
  assert.equal(
    sourceStatus(discord, st({ error: { code: "x", message: "boom" } }), "live", NOW).key,
    "error",
  );
});

test("soon stage is muted regardless of state", () => {
  const s = sourceStatus(adapter("email", 0), st(), "soon", NOW);
  assert.equal(s.key, "soon");
  assert.equal(s.detail, undefined);
});
