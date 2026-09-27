// @ts-check
// Discord adapter end-to-end: REST + DOM payloads through observe.parse,
// the output filter, sweep/unread state, and the real scope-mode fold.
import test from "node:test";
import assert from "node:assert/strict";
import { extractDates } from "../../extension/src/lib/textdates/index.js";
import { applyResult } from "../../extension/src/core/merge.js";
import adapter from "../../extension/src/sources/discord/index.js";

const NOW = new Date("2026-10-01T20:00:00.000Z");
const AT = NOW.toISOString();
const G = "1000000000000000001"; // Robotics Club
const G2 = "1000000000000000002"; // Rocket Team
const CH = "2000000000000000002"; // pcb-design
const CH_DEAD = "2000000000000000005"; // deadlines
const CH_MEMES = "2000000000000000006"; // memes (never watched)
const DMCH = "3000000000000000099";
const ME = "4200000000000000042";
const TS_OCT8_6PM = 1791496800; // 2026-10-08T22:00Z

const API = "https://discord.com/api/v10";

/** Explicit settings — tests never rely on blank defaults. */
const SETTINGS = {
  watched: {
    "Robotics Club": { focus: ["electrical"] },
    "Rocket Team": {},
  },
};

function makeCtx(state = {}, extras = {}) {
  return {
    state,
    now: NOW,
    settings: extras.settings ?? SETTINGS,
    textDates: extractDates,
    log() {},
  };
}
const net = (url, body, { status = 200, method = "GET", at = AT } = {}) => ({
  source: "discord", kind: "net", url, method, status,
  body: typeof body === "string" ? body : JSON.stringify(body), at,
});
const dom = (extract, url = `https://discord.com/channels/${G}/${CH}`) => ({
  source: "discord", kind: "dom", url, body: JSON.stringify(extract), at: AT,
});

const restMsg = (id, channelId, content, extra = {}) => ({
  id,
  channel_id: channelId,
  guild_id: G,
  content,
  timestamp: "2026-10-01T19:00:00.000Z",
  type: 0,
  mentions: [],
  mention_roles: [],
  mention_everyone: false,
  ...extra,
});

/** Inventory extract covering Robotics Club: pcb-design + deadlines + memes. */
const inventory = {
  v: 1,
  type: "inventory",
  location: { guildId: G, channelId: CH },
  guilds: [
    { guildId: G, name: "Robotics Club", unread: false, mentions: 0 },
    { guildId: G2, name: "Rocket Team", unread: true, mentions: 4 },
    { guildId: "999", name: "Fan Community", unread: true, mentions: 9 },
  ],
  channels: [
    {
      channelId: CH, guildId: G, name: "pcb-design", category: "ELECTRICAL",
      type: "text", order: 1, unread: true, mentions: 2, limited: false,
    },
    {
      channelId: CH_DEAD, guildId: G, name: "deadlines", type: "text",
      order: 3, unread: false, mentions: 0, limited: false,
    },
    {
      channelId: CH_MEMES, guildId: G, name: "memes", type: "text",
      order: 4, unread: false, mentions: 0, limited: false,
    },
  ],
};

test("REST read before inventory: stored, hidden until the channel maps", async () => {
  const ctx = makeCtx();
  const r1 = await adapter.observe.parse(
    net(`${API}/channels/${CH}/messages?limit=50`, [
      restMsg("9101", CH, `BOM is due October 10 at 5pm`),
    ]),
    ctx
  );
  assert.equal(r1.scope, "discord");
  assert.equal(r1.session, "signed-in");
  assert.equal(r1.items.length, 0); // channel not mapped to a guild yet
  assert.equal(r1.state.lastGood.messages.items.length, 1); // but stored

  const r2 = await adapter.observe.parse(dom(inventory), makeCtx(r1.state));
  assert.equal(r2.items.length, 1);
  assert.equal(r2.items[0].org, "Robotics Club"); // resolved at output
  assert.equal(
    r2.items[0].url,
    `https://discord.com/channels/${G}/${CH}/9101`
  );
  assert.equal(r2.items[0].dueAt, "2026-10-10T21:00:00.000Z");
});

test("suggested channels become watched; sweep/unread state updates", async () => {
  const r = await adapter.observe.parse(dom(inventory), makeCtx());
  const st = r.state;
  // pcb-design (elec 3+cat 2) and deadlines (3) suggested; memes not.
  assert.ok(st.watch[G].channelIds.includes(CH));
  assert.ok(st.watch[G].channelIds.includes(CH_DEAD));
  assert.ok(!st.watch[G].channelIds.includes(CH_MEMES));
  assert.equal(st.watch[G].from, "suggested");
  // Sweep queue: watched channels not yet read, guild order then score.
  const ids = st.sweepQueue.map((e) => e.channelId);
  assert.ok(ids.includes(CH));
  assert.ok(ids.includes(CH_DEAD));
  assert.ok(!ids.includes(CH_MEMES));
  // Unread summaries.
  assert.equal(st.unreadWatched[0].channelId, CH);
  assert.equal(st.unreadWatched[0].mentions, 2);
  assert.ok(st.unreadGuilds.some((g) => g.guildId === G2 && g.mentions === 4));
  assert.ok(!st.unreadGuilds.some((g) => g.guildId === "999"));

  // A history read for CH_DEAD after the sweep started marks it done.
  const r2 = await adapter.observe.parse(
    net(`${API}/channels/${CH_DEAD}/messages?limit=50`, []),
    makeCtx(st)
  );
  assert.ok(
    !r2.state.sweepQueue.some((e) => e.channelId === CH_DEAD)
  );
  assert.ok(r2.state.sweep.done[CH_DEAD]);
});

test("unwatched channel filtered; assignedToMe overrides", async () => {
  const ctx = makeCtx({}, { settings: { userId: ME } });
  const r1 = await adapter.observe.parse(dom(inventory), ctx);
  const r2 = await adapter.observe.parse(
    net(`${API}/channels/${CH_MEMES}/messages?limit=50`, [
      restMsg("9201", CH_MEMES, `meeting October 8 at 6 PM`),
      restMsg("9202", CH_MEMES, `can you update the poster`, {
        mentions: [{ id: ME }],
      }),
    ]),
    makeCtx(r1.state, { settings: { userId: ME } })
  );
  // Both produced items in storage, but only the pinged message survives
  // the output filter (memes is never watched).
  assert.equal(r2.state.lastGood.messages.items.length, 2);
  assert.equal(r2.items.length, 1);
  assert.equal(r2.items[0].meta.messageId, "9202");
  assert.equal(r2.items[0].type, "task");
});

test("DM channels are purged and never stored again", async () => {
  const ctx = makeCtx();
  // A DM read arrives before we know it's a DM channel.
  const r1 = await adapter.observe.parse(
    net(`${API}/channels/${DMCH}/messages?limit=50`, [
      { ...restMsg("9301", DMCH, "meet October 8 at 6pm"), guild_id: undefined },
    ]),
    ctx
  );
  assert.equal(r1.state.lastGood.messages.items.length, 1);
  // DOM location read: this is a DM channel.
  const r2 = await adapter.observe.parse(
    dom(
      { v: 1, type: "location", location: { guildId: "@me", channelId: DMCH } },
      `https://discord.com/channels/@me/${DMCH}`
    ),
    makeCtx(r1.state)
  );
  assert.ok(r2.state.dmChannels.includes(DMCH));
  assert.equal(r2.state.lastGood.messages.items.length, 0); // purged
  // A later REST read for it stores nothing.
  const r3 = await adapter.observe.parse(
    net(`${API}/channels/${DMCH}/messages?limit=50`, [
      { ...restMsg("9302", DMCH, "meet October 9 at 6pm"), guild_id: undefined },
    ]),
    makeCtx(r2.state)
  );
  assert.equal(r3.state.lastGood.messages.items.length, 0);
});

test("same message via REST and DOM produces one item id", async () => {
  const ctx = makeCtx();
  const r1 = await adapter.observe.parse(dom(inventory), ctx);
  const r2 = await adapter.observe.parse(
    net(`${API}/channels/${CH}/messages?limit=50`, [
      restMsg("9401", CH, `design review <t:${TS_OCT8_6PM}>`),
    ]),
    makeCtx(r1.state)
  );
  const domExtract = {
    v: 1,
    type: "messages",
    location: { guildId: G, channelId: CH },
    messages: [
      {
        channelId: CH,
        messageId: "9401",
        timestamp: "2026-10-01T19:00:00.000Z",
        content: "design review October 8 at 6 PM",
        times: ["2026-10-08T22:00:00.000Z"],
        roleMentions: [],
        mentionsMe: false,
      },
    ],
  };
  const r3 = await adapter.observe.parse(dom(domExtract), makeCtx(r2.state));
  const items = r3.items.filter((i) => i.meta?.messageId === "9401");
  assert.equal(items.length, 1);
  assert.equal(items[0].id, `discord:${CH}:9401:2026-10-08T22:00:00.000Z`);
});

test("a re-read edited message replaces its own items", async () => {
  const ctx = makeCtx();
  const r1 = await adapter.observe.parse(dom(inventory), ctx);
  const r2 = await adapter.observe.parse(
    net(`${API}/channels/${CH}/messages?limit=50`, [
      restMsg("9501", CH, `meeting October 8 at 6 PM`),
      restMsg("9502", CH, `meeting October 9 at 6 PM`),
    ]),
    makeCtx(r1.state)
  );
  assert.equal(r2.items.length, 2);
  // The edit moves 9501 to October 15; 9502 is re-read unchanged.
  const r3 = await adapter.observe.parse(
    net(`${API}/channels/${CH}/messages?limit=50`, [
      {
        ...restMsg("9501", CH, `meeting October 15 at 6 PM`),
        edited_timestamp: "2026-10-02T00:00:00.000Z",
      },
      restMsg("9502", CH, `meeting October 9 at 6 PM`),
    ]),
    makeCtx(r2.state)
  );
  // (A weekly-meeting suggestion may also appear — filter to message items.)
  const ids = r3.items
    .filter((i) => i.meta?.messageId)
    .map((i) => i.id)
    .sort();
  assert.deepEqual(ids, [
    `discord:${CH}:9501:2026-10-15T22:00:00.000Z`,
    `discord:${CH}:9502:2026-10-09T22:00:00.000Z`,
  ]);
});

test("401 -> signed-out, cached union still returned", async () => {
  const ctx = makeCtx();
  const r1 = await adapter.observe.parse(dom(inventory), ctx);
  const r2 = await adapter.observe.parse(
    net(`${API}/channels/${CH}/messages?limit=50`, [
      restMsg("9601", CH, `meeting October 8 at 6 PM`),
    ]),
    makeCtx(r1.state)
  );
  assert.equal(r2.items.length, 1);
  const r3 = await adapter.observe.parse(
    net(`${API}/users/@me/mentions`, "Unauthorized", { status: 401 }),
    makeCtx(r2.state)
  );
  assert.equal(r3.session, "signed-out");
  assert.equal(r3.items.length, 1);
});

test("mentions payload infers identity; result folds through applyResult", async () => {
  const ctx = makeCtx();
  const r1 = await adapter.observe.parse(dom(inventory), ctx);
  const r2 = await adapter.observe.parse(
    net(`${API}/users/@me/mentions?limit=25`, [
      restMsg("9701", CH, `please review the boards`, {
        mentions: [{ id: ME }],
      }),
      restMsg("9702", CH, `please check the bom`, {
        mentions: [{ id: ME }, { id: "777" }],
      }),
    ]),
    makeCtx(r1.state)
  );
  assert.equal(r2.state.identity.selfId, ME);
  // Both pings the user -> two task items, all folded into the raw record.
  const raw = applyResult(null, r2, { mode: "scope", scope: r2.scope });
  assert.equal(raw.items.length, 2);
  // An empty parse of an unrelated read keeps the union (scope-mode replace
  // still carries every cached item).
  const r3 = await adapter.observe.parse(
    net(`${API}/channels/${CH}/messages?limit=50`, []),
    makeCtx(r2.state)
  );
  const raw2 = applyResult(raw, r3, { mode: "scope", scope: r3.scope });
  assert.equal(raw2.items.length, 2);
});

test("DOM read keeps REST items when the derived ids match, replaces on edit", async () => {
  const ctx = makeCtx();
  const r1 = await adapter.observe.parse(dom(inventory), ctx);
  const r2 = await adapter.observe.parse(
    net(`${API}/channels/${CH}/messages?limit=50`, [
      restMsg("9401", CH, `design review <t:${TS_OCT8_6PM}>`),
    ]),
    makeCtx(r1.state)
  );
  assert.equal(r2.items[0].meta.via, "rest");

  // Same message + same instant via DOM: identical ids → REST item kept.
  const domSame = {
    v: 1, type: "messages",
    location: { guildId: G, channelId: CH },
    messages: [{
      channelId: CH, messageId: "9401",
      timestamp: "2026-10-01T19:00:00.000Z",
      content: "design review October 8 at 6 PM", // renders differently, same instant
      times: ["2026-10-08T22:00:00.000Z"],
      roleMentions: [], mentionsMe: false,
    }],
  };
  const r3 = await adapter.observe.parse(dom(domSame), makeCtx(r2.state));
  const kept = r3.state.lastGood.messages.items.find(
    (i) => i.meta?.messageId === "9401"
  );
  assert.equal(kept.meta.via, "rest"); // not flip-flopped to the DOM text

  // An edited DOM read (different date) DOES replace — new id set. Discord
  // re-renders the text on edit, so the rendered date moves too.
  const domEdited = {
    ...domSame,
    messages: [{
      ...domSame.messages[0],
      content: "design review October 15 at 6 PM",
      times: ["2026-10-15T22:00:00.000Z"],
    }],
  };
  const r4 = await adapter.observe.parse(dom(domEdited), makeCtx(r3.state));
  const replaced = r4.state.lastGood.messages.items.find(
    (i) => i.meta?.messageId === "9401"
  );
  assert.equal(replaced.meta.via, "dom");
  assert.equal(replaced.id, `discord:${CH}:9401:2026-10-15T22:00:00.000Z`);
});

test("meetingLog dedupes re-reads of the same message", async () => {
  const ctx = makeCtx();
  const r1 = await adapter.observe.parse(dom(inventory), ctx);
  const body = [
    restMsg("9550", CH, `weekly sync <t:${TS_OCT8_6PM}>`),
    restMsg("9551", CH, `meeting October 9 at 6 PM`),
  ];
  let state = r1.state;
  for (let i = 0; i < 3; i++) {
    state = (
      await adapter.observe.parse(
        net(`${API}/channels/${CH}/messages?limit=50`, body),
        makeCtx(state)
      )
    ).state;
  }
  const entries = state.meetingLog.filter((e) => e.channelId === CH);
  const keys = entries.map((e) => `${e.channelId}|${e.messageId}`);
  assert.equal(new Set(keys).size, keys.length); // no dupes across re-reads
  assert.equal(entries.length, 2); // one occurrence entry per message
});

test("a settings.watched change applies without a new inventory", async () => {
  const ctx = makeCtx();
  const r1 = await adapter.observe.parse(dom(inventory), ctx);
  // memes is never suggested — an item there is stored but hidden.
  const r2 = await adapter.observe.parse(
    net(`${API}/channels/${CH_MEMES}/messages?limit=50`, [
      restMsg("9201", CH_MEMES, `meeting October 8 at 6 PM`),
    ]),
    makeCtx(r1.state)
  );
  assert.equal(r2.items.length, 0);
  // Now the user pins memes via settings — a payload-free setting change.
  const r3 = await adapter.observe.parse(
    net(`${API}/channels/${CH}/messages?limit=50`, []),
    makeCtx(r2.state, {
      settings: { watched: { "Robotics Club": { channels: ["memes"] } } },
    })
  );
  assert.deepEqual(r3.state.watch[G].channelIds, [CH_MEMES]);
  assert.equal(r3.state.watch[G].from, "settings");
  assert.equal(r3.items.length, 1);
  assert.equal(r3.items[0].meta.channelId, CH_MEMES);
});

test("sync returns the cached filtered union", async () => {
  const ctx = makeCtx();
  const r1 = await adapter.observe.parse(dom(inventory), ctx);
  const synced = await adapter.sync(makeCtx(r1.state));
  assert.equal(synced.complete, false);
  assert.equal(synced.session, "no-tab");
  assert.ok(Array.isArray(synced.items));
});

test("JSON.stringify(state) carries no message bodies or author ids", async () => {
  const ctx = makeCtx();
  const r1 = await adapter.observe.parse(dom(inventory), ctx);
  // The trigger sentence is persisted as a ≤300-char snippet — anything in
  // a different sentence must never reach state.
  const body =
    "please route the usb-cc section.\nthe secret-marker-xyz part stays private";
  const r2 = await adapter.observe.parse(
    net(`${API}/channels/${CH}/messages?limit=50`, [
      restMsg("9801", CH, body, { mentions: [{ id: ME }], author: { id: "8888" } }),
    ]),
    makeCtx(r1.state, { settings: { userId: ME } })
  );
  const json = JSON.stringify(r2.state);
  assert.ok(!json.includes("secret-marker-xyz"));
  assert.ok(!json.includes("8888")); // author id never persisted
});
