// @ts-check
// Shared task seam for Discord: meta.action on reply/assigned-task items,
// the +2d undated fallback, and settled-read complete/readOk scopes.
import test from "node:test";
import assert from "node:assert/strict";
import { extractDates } from "../../extension/src/lib/textdates/index.js";
import {
  candidatesForMessage,
  replyCandidate,
} from "../../extension/src/sources/discord/messages.js";
import adapter from "../../extension/src/sources/discord/index.js";

const NOW_ISO = "2026-10-01T12:00:00.000Z";
const O = (over = {}) => ({
  extractDates,
  selfId: "42",
  roleIds: ["77"],
  nowIso: NOW_ISO,
  channelId: "2001",
  guildId: "1001",
  channelName: "elec-general",
  team: "Robotics Club",
  watched: true,
  ...over,
});
const msg = (content, extra = {}) => ({
  id: "9001",
  channel_id: "2001",
  guild_id: "1001",
  content,
  timestamp: "2026-10-01T20:00:00.000Z",
  type: 0,
  mentions: [],
  mention_roles: [],
  mention_everyone: false,
  ...extra,
});

// --- meta.action --------------------------------------------------------

test("reply to-dos carry meta.action reply", () => {
  const item = replyCandidate(
    msg("can you review the footprint?", { mentions: [{ id: "42" }] }),
    O()
  );
  assert.ok(item);
  assert.equal(item.meta.action, "reply");
});

test("assigned task with hand-in cue + doc noun -> submit-document", () => {
  const [item] = candidatesForMessage(
    msg("can you submit the report?", {
      mentions: [{ id: "42" }],
    }),
    O()
  );
  assert.equal(item.type, "task");
  assert.equal(item.meta.action, "submit-document");
});

test("assigned task without a doc noun -> other", () => {
  const [item] = candidatesForMessage(
    msg("can you route the new connector footprints", {
      mentions: [{ id: "42" }],
    }),
    O()
  );
  assert.equal(item.type, "task");
  assert.equal(item.meta.action, "other");
});

test("doc noun without a hand-in cue -> other (no submit)", () => {
  const [item] = candidatesForMessage(
    msg("can you fix the slides?", { mentions: [{ id: "42" }] }),
    O()
  );
  assert.equal(item.meta.action, "other");
});

test("unassigned announcement with a deadline gets no meta.action", () => {
  const [item] = candidatesForMessage(
    msg("BOM is due October 10 at 5pm"),
    O()
  );
  assert.equal(item.type, "deadline");
  assert.equal(item.meta.action, undefined);
});

test("@everyone asks don't become reply or task items", () => {
  const m = msg("can everyone submit the report by Friday?", {
    mention_everyone: true,
  });
  assert.equal(replyCandidate(m, O()), null);
});

// --- settled reads -> complete + readOk --------------------------------

const G = "1001";
const CH = "2001";
const AT = NOW_ISO;
const SETTINGS = {
  watched: [{ guild: "Robotics Club", team: "Robotics Club" }],
};
function makeCtx(state = {}) {
  return {
    state,
    now: new Date(NOW_ISO),
    settings: SETTINGS,
    textDates: extractDates,
    log() {},
  };
}
const dom = (extract, url = `https://discord.com/channels/${G}/${CH}`) => ({
  source: "discord",
  kind: "dom",
  url,
  body: JSON.stringify(extract),
  at: AT,
});

test("settled guild-channel inventory -> complete + discord:channel", async () => {
  const extract = {
    v: 1,
    type: "inventory",
    settled: true,
    location: { guildId: G, channelId: CH },
    guilds: [{ guildId: G, name: "Robotics Club" }],
    channels: [],
  };
  const r = await adapter.observe.parse(dom(extract), makeCtx());
  assert.equal(r.complete, true);
  assert.deepEqual(r.readOk, ["discord:channel"]);
});

test("unsettled inventory read is not complete", async () => {
  const extract = {
    v: 1,
    type: "inventory",
    settled: false,
    location: { guildId: G, channelId: CH },
    guilds: [{ guildId: G, name: "Robotics Club" }],
    channels: [],
  };
  const r = await adapter.observe.parse(dom(extract), makeCtx());
  assert.equal(r.complete, false);
  assert.deepEqual(r.readOk, ["discord"]);
});

test("settled events modal with zero cards -> discord:events", async () => {
  const extract = {
    v: 1,
    type: "events",
    settled: true,
    modal: "list",
    location: { guildId: G, channelId: CH },
    guildName: "Robotics Club",
    cards: [],
  };
  const r = await adapter.observe.parse(dom(extract), makeCtx());
  assert.equal(r.complete, true);
  assert.deepEqual(r.readOk, ["discord:events"]);
});

test("unsettled events modal is not complete", async () => {
  const extract = {
    v: 1,
    type: "events",
    settled: false,
    modal: "list",
    location: { guildId: G, channelId: CH },
    guildName: "Robotics Club",
    cards: [],
  };
  const r = await adapter.observe.parse(dom(extract), makeCtx());
  assert.equal(r.complete, false);
  assert.deepEqual(r.readOk, ["discord"]);
});
