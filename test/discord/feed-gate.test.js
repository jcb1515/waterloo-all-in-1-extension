// @ts-check
// Reply / book-a-call to-dos stay off the calendar feed unless to-dos are
// opted in (calendar include.todos, set by the publisher from
// settings.todos.includeInCalendar). Ordinary items are unaffected.
import test from "node:test";
import assert from "node:assert/strict";
import { extractDates } from "../../extension/src/lib/textdates/index.js";
import adapter from "../../extension/src/sources/discord/index.js";
import { buildFeedPayload } from "../../extension/src/calendar/payload.js";

const NOW = new Date("2026-10-01T20:00:00.000Z");
const AT = NOW.toISOString();
const G = "1000000000000000001";
const CH = "2000000000000000002";
const ME = "4200000000000000042";
const SETTINGS = { watched: { "Robotics Club": { focus: ["electrical"] } }, userId: ME };
const ctx = (state = {}) => ({ state, now: NOW, settings: SETTINGS, textDates: extractDates, log() {} });

const CAL = {
  enabled: true,
  include: { classes: true, tentative: true, completed: true, termDates: true },
  alarms: false,
};

/** A real Discord reply to-do (and a meeting) from the adapter. */
async function discordItems() {
  const r1 = await adapter.observe.parse(
    {
      source: "discord",
      kind: "dom",
      url: `https://discord.com/channels/${G}/${CH}`,
      at: AT,
      body: JSON.stringify({
        v: 1,
        type: "inventory",
        location: { guildId: G, channelId: CH },
        guilds: [{ guildId: G, name: "Robotics Club", unread: false, mentions: 0 }],
        channels: [
          { channelId: CH, guildId: G, name: "pcb-design", category: "ELECTRICAL", type: "text", order: 1 },
        ],
      }),
    },
    ctx()
  );
  const r2 = await adapter.observe.parse(
    {
      source: "discord",
      kind: "net",
      method: "GET",
      status: 200,
      at: AT,
      url: `https://discord.com/api/v10/channels/${CH}/messages?limit=50`,
      body: JSON.stringify([
        {
          id: "3001", channel_id: CH, guild_id: G, type: 0,
          content: `<@${ME}> when are you free for the bring-up?`,
          timestamp: "2026-09-30T20:05:00.000Z",
          mentions: [{ id: ME }], mention_roles: [], mention_everyone: false,
          author: { id: "8800000000000000001" },
        },
        {
          id: "3002", channel_id: CH, guild_id: G, type: 0,
          content: "design review <t:1791583200>",
          timestamp: "2026-09-30T20:06:00.000Z",
          mentions: [], mention_roles: [], mention_everyone: false,
          author: { id: "8800000000000000001" },
        },
      ]),
    },
    ctx(r1.state)
  );
  return r2.items;
}

const asMap = (items) => Object.fromEntries(items.map((i) => [i.id, i]));
const ids = (res) => res.payload.events.map((e) => e.id);

test("reply to-dos are excluded from the feed by default, included when opted in", async () => {
  const items = await discordItems();
  const reply = items.find((i) => i.category === "reply");
  assert.ok(reply, "adapter produced a reply to-do");
  const meeting = items.find((i) => i.type === "meeting");
  assert.ok(meeting, "adapter produced a meeting");

  const off = buildFeedPayload(asMap(items), {}, CAL, NOW, { acceptPending: true });
  assert.ok(!ids(off).includes(reply.id), "reply to-do kept off the feed");
  assert.ok(ids(off).includes(meeting.id), "ordinary items still publish");

  const on = buildFeedPayload(
    asMap(items),
    {},
    { ...CAL, include: { ...CAL.include, todos: true } },
    NOW,
    { acceptPending: true }
  );
  assert.ok(ids(on).includes(reply.id), "opted-in to-dos publish");
});

test("email reply and book-a-call tasks follow the same gate; other tasks don't", () => {
  const base = { status: "open", confidence: "exact", review: "auto", dueAt: "2026-10-03T21:00:00.000Z" };
  const items = asMap([
    { ...base, id: "gmail:reply:thr-1", source: "gmail", type: "task", category: "reply", title: "Reply to Jane Smith: Lab" },
    { ...base, id: "gmail:book:thr-2", source: "gmail", type: "task", category: "book-call", title: "Book a call with Sam" },
    { ...base, id: "manual:t1", source: "manual", type: "task", title: "Upload forms" },
  ]);
  const off = ids(buildFeedPayload(items, {}, CAL, NOW));
  assert.deepEqual(off, ["manual:t1"]);
  const on = ids(buildFeedPayload(items, {}, { ...CAL, include: { ...CAL.include, todos: true } }, NOW)).sort();
  assert.deepEqual(on, ["gmail:book:thr-2", "gmail:reply:thr-1", "manual:t1"]);
});
