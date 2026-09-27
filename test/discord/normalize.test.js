// @ts-check
// normalizeRestBody: the four endpoint shapes + fail-soft paths.
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRestBody } from "../../extension/src/sources/discord/messages.js";

const API = "https://discord.com/api/v10";
const msg = (id, extra = {}) => ({
  id,
  channel_id: "2001",
  content: `m${id}`,
  timestamp: "2026-10-01T12:00:00.000Z",
  ...extra,
});

test("channel history is a plain array", () => {
  const r = normalizeRestBody(
    `${API}/channels/2001/messages?limit=50`,
    JSON.stringify([msg("1"), msg("2")])
  );
  assert.equal(r.kind, "channel");
  assert.equal(r.channelId, "2001");
  assert.equal(r.messages.length, 2);
});

test("pins accept both array and {items:[{message}]}", () => {
  const a = normalizeRestBody(
    `${API}/channels/2001/messages/pins`,
    JSON.stringify([msg("1")])
  );
  assert.equal(a.kind, "pins");
  assert.equal(a.messages.length, 1);
  const b = normalizeRestBody(
    `${API}/channels/2001/messages/pins`,
    JSON.stringify({ items: [{ message: msg("7"), pinned_at: "x" }] })
  );
  assert.equal(b.messages[0].id, "7");
});

test("mentions endpoint is a plain array", () => {
  const r = normalizeRestBody(
    `${API}/users/@me/mentions?limit=25`,
    JSON.stringify([msg("1", { guild_id: "1001" })])
  );
  assert.equal(r.kind, "mentions");
  assert.equal(r.guildId, "1001");
});

test("search results take hit:true messages else the group head", () => {
  const body = {
    messages: [
      [{ ...msg("a", { guild_id: "1001" }) }, msg("ctx")],
      [msg("ctx2"), { ...msg("b", { hit: true }), hit: undefined }],
      [{ ...msg("c", { hit: true }) }, { ...msg("d", { hit: true }) }],
    ],
  };
  // mark hits explicitly
  body.messages[0][0].hit = true;
  const r = normalizeRestBody(
    `${API}/guilds/1001/messages/search`,
    JSON.stringify(body)
  );
  assert.equal(r.kind, "search");
  assert.equal(r.guildId, "1001");
  assert.deepEqual(r.messages.map((m) => m.id), ["a", "ctx2", "c", "d"]);
});

test("garbage bodies and unknown urls fail soft", () => {
  const r = normalizeRestBody(`${API}/channels/2001/messages`, "not json{");
  assert.equal(r.kind, "channel");
  assert.deepEqual(r.messages, []);
  const u = normalizeRestBody("https://discord.com/api/v10/gateway", "[]");
  assert.equal(u.kind, "unknown");
  assert.deepEqual(u.messages, []);
});
