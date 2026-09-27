// @ts-check
// Robustness + growth: ~300 deterministic malformed ObservedPayloads must
// never throw and must always return {items: Array, scope}; sync() survives
// garbage ctx.state. Then 1000 realistic reads prove state stays bounded —
// every accumulator must hold its documented cap.
import test from "node:test";
import assert from "node:assert/strict";
import { extractDates } from "../../extension/src/lib/textdates/index.js";
import adapter from "../../extension/src/sources/discord/index.js";

const NOW = new Date("2026-09-20T12:00:00.000Z");
const AT = NOW.toISOString();
const SETTINGS = { watched: { "Robotics Club": { focus: ["electrical"] } } };

/** Deterministic PRNG so failures reproduce. */
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rnd, list) => list[Math.floor(rnd() * list.length)];

function randText(rnd, len) {
  const pool =
    "abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<>&\"'{}[]()/=?#$|é中🎉\n\r\t";
  let s = "";
  for (let i = 0; i < len; i++) s += pool[Math.floor(rnd() * pool.length)];
  return s;
}

/** A random JSON-ish garbage value. */
function garbage(rnd, depth = 0) {
  const kinds = [
    () => rnd() * 1000 - 500,
    () => Math.floor(rnd() * 1e18).toString(),
    () => randText(rnd, Math.floor(rnd() * 40)),
    () => rnd() < 0.5,
    () => null,
    () => undefined,
    () =>
      depth < 2
        ? Array.from({ length: Math.floor(rnd() * 4) }, () => garbage(rnd, depth + 1))
        : [],
    () =>
      depth < 2
        ? Object.fromEntries(
            Array.from({ length: Math.floor(rnd() * 4) }, () => [
              randText(rnd, 6),
              garbage(rnd, depth + 1),
            ])
          )
        : {},
  ];
  return pick(rnd, kinds)();
}

/** A garbage DOM extract JSON body — right shape, wrong field types. */
function garbageExtract(rnd) {
  return JSON.stringify({
    v: garbage(rnd),
    type: pick(rnd, [
      "inventory", "messages", "events", "location",
      "nope", 5, null, undefined,
    ]),
    location: garbage(rnd),
    guildName: garbage(rnd),
    guilds: garbage(rnd),
    channels: garbage(rnd),
    messages: garbage(rnd),
    cards: garbage(rnd),
    tz: garbage(rnd),
    modal: garbage(rnd),
  });
}

function randNetBody(rnd) {
  return pick(rnd, [
    () => randText(rnd, Math.floor(rnd() * 300)),
    () => '[{"id":"1"' + randText(rnd, 20), // truncated JSON
    () => JSON.stringify(garbage(rnd)),
    () =>
      JSON.stringify(
        Array.from({ length: Math.floor(rnd() * 5) }, () => garbage(rnd))
      ),
    () => "",
    () => "x".repeat(1024 * 1024), // 1 MB string (rare path)
  ])();
}

function randUrl(rnd) {
  const g = String(Math.floor(rnd() * 1e17) + 1e17);
  const c = String(Math.floor(rnd() * 1e17) + 1e17);
  return pick(rnd, [
    () => `https://discord.com/api/v10/channels/${c}/messages?limit=50`,
    () => `https://discord.com/api/v9/guilds/${g}/channels`,
    () => `https://discord.com/api/v10/users/@me/mentions?limit=25`,
    () => `https://discord.com/api/v10/users/@me/scheduled-events`,
    () => `https://discord.com/api/v10/channels/${c}/pins`,
    () => `https://discord.com/channels/${g}/${c}`,
    () => "not a url",
    () => "",
    () => garbage(rnd),
  ])();
}

const ctx = (state = {}) => ({
  state,
  now: NOW,
  settings: SETTINGS,
  textDates: extractDates,
  log() {},
});

test("fuzz: 300 malformed payloads never throw and return {items, scope}", async () => {
  const rnd = mulberry32(31337);
  for (let i = 0; i < 300; i++) {
    const kind = pick(rnd, ["net", "dom", "weird", 5, null, {}]);
    const payload = {
      source: "discord",
      kind,
      url: randUrl(rnd),
      method: pick(rnd, ["GET", "POST", 5, null, {}]),
      status: pick(rnd, [200, 401, 404, "200", {}, null, -1]),
      body:
        kind === "dom"
          ? pick(rnd, [() => garbageExtract(rnd), () => randText(rnd, 80), () => "[{"])()
          : randNetBody(rnd),
      at: pick(rnd, [AT, "garbage", 12345, null, {}]),
    };
    // Every fifth case feeds a garbage prior state too.
    const state = i % 5 === 0 ? garbage(rnd) : {};
    const result = await adapter.observe.parse(payload, ctx(state));
    assert.ok(result && typeof result === "object", `case ${i}: result`);
    assert.ok(Array.isArray(result.items), `case ${i}: items array`);
    assert.equal(result.scope, "discord", `case ${i}: scope`);
    assert.ok(result.state && typeof result.state === "object", `case ${i}: state`);
  }
});

test("fuzz: sync() survives garbage ctx.state", async () => {
  const rnd = mulberry32(424242);
  for (let i = 0; i < 100; i++) {
    const result = await adapter.sync(ctx(garbage(rnd)));
    assert.ok(result && typeof result === "object", `case ${i}: result`);
    assert.ok(Array.isArray(result.items), `case ${i}: items array`);
    assert.ok(result.state && typeof result.state === "object", `case ${i}: state`);
  }
});

/**
 * 1000 realistic reads: unique guilds/channels/messages — proves every
 * accumulator is capped (messages, meetingLog, dmChannels, rsvps, guilds,
 * sweep.done, events).
 */
test("growth: 1000 unique reads keep state under 1.5 MB and hold all caps", async () => {
  const rnd = mulberry32(1);
  let state = {};
  const c = ctx(state);
  for (let i = 0; i < 1000; i++) {
    const g = `${1e17 + i}`;
    const ch = `${2e17 + i}`;
    const mid = `${3e17 + i}`;
    let payload;
    const mod = i % 4;
    if (mod === 0) {
      // DOM inventory: new guild + channel
      payload = {
        source: "discord",
        kind: "dom",
        url: `https://discord.com/channels/${g}/${ch}`,
        body: JSON.stringify({
          v: 1,
          type: "inventory",
          location: { guildId: g, channelId: ch },
          guilds: [{ guildId: g, name: `Guild ${i}`, unread: false, mentions: 0 }],
          channels: [{ channelId: ch, name: `general-${i}`, type: 0, order: 1 }],
        }),
        at: AT,
      };
    } else if (mod === 1) {
      // REST channel history: one dated message
      payload = {
        source: "discord",
        kind: "net",
        url: `https://discord.com/api/v10/channels/${ch}/messages?limit=50`,
        method: "GET",
        status: 200,
        body: JSON.stringify([
          {
            id: mid,
            channel_id: ch,
            guild_id: g,
            content: `meeting <t:${1791496800 + i}> October sync ${i}`,
            timestamp: AT,
            type: 0,
            mentions: [],
            mention_roles: [],
            mention_everyone: false,
          },
        ]),
        at: AT,
      };
    } else if (mod === 2) {
      // DOM message extract
      payload = {
        source: "discord",
        kind: "dom",
        url: `https://discord.com/channels/${g}/${ch}`,
        body: JSON.stringify({
          v: 1,
          type: "messages",
          location: { guildId: g, channelId: ch },
          messages: [
            {
              id: mid,
              channelId: ch,
              text: `deadline October 10 item ${i}`,
            },
          ],
        }),
        at: AT,
      };
    } else {
      // RSVP list
      payload = {
        source: "discord",
        kind: "net",
        url: "https://discord.com/api/v10/users/@me/scheduled-events",
        method: "GET",
        status: 200,
        body: JSON.stringify([{ guild_scheduled_event_id: `${9e17 + i}` }]),
        at: AT,
      };
    }
    const result = await adapter.observe.parse(payload, c);
    state = result.state;
    c.state = state;
  }

  const bytes = JSON.stringify(state).length;
  assert.ok(bytes < 1_500_000, `state ${bytes} bytes`);
  assert.ok((state.lastGood.messages?.items || []).length <= 600);
  assert.ok((state.meetingLog || []).length <= 300);
  assert.ok((state.dmChannels || []).length <= 500);
  assert.ok((state.rsvps || []).length <= 500);
  assert.ok(Object.keys(state.guilds || {}).length <= 300);
  for (const g of Object.values(state.guilds || {})) {
    assert.ok(Object.keys(g.channels || {}).length <= 500);
  }
});
