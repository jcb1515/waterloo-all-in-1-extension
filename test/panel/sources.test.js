// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { sourceStatus, attentionSource } from "../../extension/src/panel/model/sources.js";

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

const live = () => /** @type {"live"|"soon"} */ ("live");

test("attentionSource: signed-out session says 'signed out — open the site'", () => {
  const learn = adapter("learn", 30);
  const r = attentionSource(
    [learn],
    { learn: st({ session: "signed-out" }) },
    live,
  );
  assert.equal(r && r.adapter, learn);
  assert.equal(r && r.text, "signed out — open the site");
});

test("attentionSource: signed-out error code reads as signed out", () => {
  const outline = adapter("outline", 1440);
  const r = attentionSource(
    [outline],
    { outline: st({ error: { code: "signed-out", message: "SSO redirect" } }) },
    live,
  );
  assert.equal(r && r.text, "signed out — open the site");
});

test("attentionSource: error with a message shows the message", () => {
  const learn = adapter("learn", 30);
  const r = attentionSource(
    [learn],
    { learn: st({ error: { code: "http-500", message: "Brightspace 500" } }) },
    live,
  );
  assert.equal(r && r.text, "Brightspace 500");
});

test("attentionSource: error without a message falls back to 'sync error'", () => {
  const learn = adapter("learn", 30);
  const r = attentionSource(
    [learn],
    { learn: st({ error: { code: "http-500" } }) },
    live,
  );
  assert.equal(r && r.text, "sync error");
});

test("attentionSource: passive and non-live adapters never nag", () => {
  const discord = adapter("discord", 0); // passive
  const learn = adapter("learn", 30);
  assert.equal(
    attentionSource(
      [discord],
      { discord: st({ session: "signed-out" }) },
      live,
    ),
    null,
  );
  assert.equal(
    attentionSource(
      [learn],
      { learn: st({ session: "signed-out" }) },
      () => "soon",
    ),
    null,
  );
});

test("attentionSource: healthy sources give null; first troubled wins", () => {
  const learn = adapter("learn", 30);
  const outline = adapter("outline", 1440);
  assert.equal(attentionSource([learn, outline], {}, live), null);
  const r = attentionSource(
    [outline, learn],
    {
      outline: st({ error: { message: "first" } }),
      learn: st({ error: { message: "second" } }),
    },
    live,
  );
  assert.equal(r && r.adapter.id, "outline");
  assert.equal(r && r.text, "first");
});
