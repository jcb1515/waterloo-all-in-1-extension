// @ts-check
// Discord "reply needed" to-dos: generation triggers, DST-safe dueAt,
// completion by self messages / threads / references / POST responses,
// assigned-task completion via DONE_RE, and privacy guarantees.
import test from "node:test";
import assert from "node:assert/strict";
import { extractDates } from "../../extension/src/lib/textdates/index.js";
import { hashString } from "../../extension/src/capture/redact.js";
import adapter from "../../extension/src/sources/discord/index.js";

const NOW = new Date("2026-10-01T20:00:00.000Z");
const AT = NOW.toISOString();
const G = "1000000000000000001"; // Robotics Club
const CH = "2000000000000000002"; // pcb-design (watched/suggested)
const CH_MEMES = "2000000000000000006"; // memes (never watched)
const ME = "4200000000000000042";
const ALICE = "8800000000000000001"; // an assigner who isn't the user
const BOB = "8800000000000000002"; // a third party
const ROLE = "6600000000000000005";

const API = "https://discord.com/api/v10";

const SETTINGS = {
  watched: { "Robotics Club": { focus: ["electrical"] } },
  userId: ME,
  roleIds: [ROLE],
};

function makeCtx(state = {}, settings = SETTINGS) {
  return {
    state,
    now: NOW,
    settings,
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
  timestamp: "2026-09-29T20:05:00.000Z", // Tue Sep 29, 4:05 PM Toronto
  type: 0,
  mentions: [],
  mention_roles: [],
  mention_everyone: false,
  author: { id: ALICE },
  ...extra,
});

const inventory = {
  v: 1,
  type: "inventory",
  location: { guildId: G, channelId: CH },
  guilds: [{ guildId: G, name: "Robotics Club", unread: false, mentions: 0 }],
  channels: [
    {
      channelId: CH, guildId: G, name: "pcb-design", category: "ELECTRICAL",
      type: "text", order: 1, unread: false, mentions: 0, limited: false,
    },
    {
      channelId: CH_MEMES, guildId: G, name: "memes", type: "text",
      order: 4, unread: false, mentions: 0, limited: false,
    },
  ],
};

/** Inventory + one channel-history read; returns the parse result. */
async function readWithQuestion(messages, { chan = CH, state, settings } = {}) {
  const r1 = await adapter.observe.parse(
    dom(inventory),
    makeCtx(state, settings)
  );
  return adapter.observe.parse(
    net(`${API}/channels/${chan}/messages?limit=50`, messages),
    makeCtx(r1.state, settings)
  );
}

const mentionMe = (extra = {}) => ({ mentions: [{ id: ME }], ...extra });
const replyTo = (messageId, channelId = CH) => ({
  message_reference: { message_id: messageId, channel_id: channelId },
});

test("direct mention + question -> reply to-do with exact id/title/dueAt", async () => {
  const r = await readWithQuestion([
    restMsg("1001", CH, `<@${ME}> when are you free for the bring-up?`, {
      mentions: [{ id: ME }],
    }),
  ]);
  const reply = r.items.find((i) => i.category === "reply");
  assert.ok(reply, "reply item exists");
  assert.equal(reply.id, "discord:reply:1001");
  assert.equal(reply.source, "discord");
  assert.equal(reply.type, "task");
  assert.equal(reply.title, "Reply in #pcb-design (Robotics Club)");
  assert.equal(reply.status, "open");
  assert.equal(reply.review, "auto");
  assert.equal(reply.confidence, "exact");
  // Asked Tue Sep 29 4:05 PM Toronto -> due Thu Oct 1, 17:00 EDT.
  assert.equal(reply.dueAt, "2026-10-01T21:00:00.000Z");
  assert.equal(reply.url, `https://discord.com/channels/${G}/${CH}/1001`);
  assert.deepEqual(reply.meta?.reply, {
    channelId: CH,
    messageId: "1001",
    askedAt: "2026-09-29T20:05:00.000Z",
  });
  assert.equal(reply.meta?.assignedToMe, true);
  assert.equal(reply.meta?.via, "rest");
  assert.equal(reply.evidence?.method, "text");
  assert.ok(String(reply.evidence?.snippet).includes("when are you free"));
  assert.ok(String(reply.evidence?.snippet).length <= 300);
  const facts = /** @type {{label: string, value: string}[]} */ (
    reply.meta?.facts || []
  );
  assert.deepEqual(
    facts.map((f) => f.label),
    ["Server", "Channel", "Asked"]
  );
  assert.equal(facts[0].value, "Robotics Club");
  assert.equal(facts[1].value, "#pcb-design");
  assert.equal(facts[2].value, "Tue Sep 29, 4:05 PM");
});

test("dueAt is DST-safe: asked Oct 30 (EDT) -> Nov 1 17:00 EST", async () => {
  const r = await readWithQuestion([
    restMsg("1002", CH, `<@${ME}> thoughts on the layout?`, {
      mentions: [{ id: ME }],
      timestamp: "2026-10-30T20:00:00.000Z", // Fri Oct 30, 4 PM EDT
    }),
  ]);
  const reply = r.items.find((i) => i.category === "reply");
  // Nov 1 is after the Nov 1 02:00 fall-back: 17:00 EST = 22:00Z.
  assert.equal(reply?.dueAt, "2026-11-01T22:00:00.000Z");
});

test("role mention + request phrase -> exactly one to-do", async () => {
  const r = await readWithQuestion([
    restMsg("1003", CH, "please look at the new pcb spin", {
      mention_roles: [ROLE],
    }),
  ]);
  const mine = r.items.filter((i) => i.meta?.messageId === "1003");
  // "please" is also a task verb — the assigned task wins; no reply dupe.
  assert.equal(mine.length, 1);
  assert.equal(mine[0].type, "task");
  assert.notEqual(mine[0].category, "reply");

  // A role-pinged question that ISN'T a task verb gets the reply item.
  const r2 = await readWithQuestion(
    [
      restMsg("1004", CH, "any thoughts on the bring-up?", {
        mention_roles: [ROLE],
      }),
    ],
    { state: r.state }
  );
  const reply = r2.items.find(
    (i) => i.category === "reply" && i.meta?.messageId === "1004"
  );
  assert.ok(reply, "role ping + question phrase -> reply item");
  assert.equal(reply.id, "discord:reply:1004");
});

test("no question/request, @everyone, and self-authored asks -> none", async () => {
  const r = await readWithQuestion([
    restMsg("1101", CH, `<@${ME}> nice work on the boards`, {
      mentions: [{ id: ME }],
    }),
    restMsg("1102", CH, "@everyone when are you free?", {
      mention_everyone: true,
    }),
    restMsg("1103", CH, "lmk when the parts land?", {
      author: { id: ME },
    }),
  ]);
  const replies = r.items.filter((i) => i.category === "reply");
  assert.equal(replies.length, 0);
  // And none of the three produced any item at all.
  for (const mid of ["1101", "1102", "1103"]) {
    assert.equal(
      r.state.lastGood.messages.items.filter(
        (i) => i.meta?.messageId === mid
      ).length,
      0
    );
  }
});

test("reply items survive the filter in unwatched channels of watched guilds", async () => {
  const r = await readWithQuestion(
    [
      restMsg("1201", CH_MEMES, `<@${ME}> thoughts on this?`, {
        mentions: [{ id: ME }],
      }),
    ],
    { chan: CH_MEMES }
  );
  const reply = r.items.find((i) => i.category === "reply");
  assert.ok(reply, "assignedToMe reply shown despite unwatched channel");
  assert.equal(reply.title, "Reply in #memes (Robotics Club)");
});

test("completion: later self message in the same channel; earlier one doesn't", async () => {
  const r = await readWithQuestion([
    restMsg("2001", CH, `<@${ME}> when are you free to test?`, {
      mentions: [{ id: ME }],
    }),
    // Earlier self message in the same channel — before the ask.
    restMsg("1999", CH, "flashed the new firmware", {
      author: { id: ME },
      timestamp: "2026-09-28T15:00:00.000Z",
    }),
  ]);
  let reply = r.state.lastGood.messages.items.find(
    (i) => i.category === "reply"
  );
  assert.equal(reply?.status, "open");

  const r2 = await adapter.observe.parse(
    net(`${API}/channels/${CH}/messages?limit=50`, [
      restMsg("2002", CH, "tomorrow at 3 works", {
        author: { id: ME },
        timestamp: "2026-09-30T15:00:00.000Z",
      }),
    ]),
    makeCtx(r.state)
  );
  reply = r2.state.lastGood.messages.items.find(
    (i) => i.category === "reply"
  );
  assert.equal(reply?.status, "done");
  assert.ok(r2.state.repliesDone["2001"]);
  assert.equal(
    r2.items.find((i) => i.category === "reply")?.status,
    "done"
  );
});

test("completion: self message in the starter-message thread", async () => {
  const r = await readWithQuestion([
    restMsg("2101", CH, `<@${ME}> can someone fill me in?`, {
      mentions: [{ id: ME }],
    }),
  ]);
  // A thread rooted at the question uses the starter message's id as
  // its channel id.
  const r2 = await adapter.observe.parse(
    net(`${API}/channels/2101/messages?limit=50`, [
      restMsg("2102", "2101", "recap posted", {
        author: { id: ME },
        timestamp: "2026-09-30T15:00:00.000Z",
      }),
    ]),
    makeCtx(r.state)
  );
  assert.equal(
    r2.state.lastGood.messages.items.find((i) => i.category === "reply")
      ?.status,
    "done"
  );
  assert.ok(r2.state.repliesDone["2101"]);
});

test("completion: a self reply via message_reference", async () => {
  const r = await readWithQuestion([
    restMsg("2201", CH, `<@${ME}> what do you think of the layout?`, {
      mentions: [{ id: ME }],
    }),
  ]);
  // The reply could even live in a different channel — the reference is
  // what closes it.
  const r2 = await adapter.observe.parse(
    net(`${API}/channels/${CH_MEMES}/messages?limit=50`, [
      restMsg("2202", CH_MEMES, "looks good to me", {
        author: { id: ME },
        timestamp: "2026-09-30T15:00:00.000Z",
        ...replyTo("2201", CH),
      }),
    ]),
    makeCtx(r.state)
  );
  assert.equal(
    r2.state.lastGood.messages.items.find((i) => i.category === "reply")
      ?.status,
    "done"
  );
});

test("POST response learns selfId and completes the open reply", async () => {
  const r = await readWithQuestion([
    restMsg("2301", CH, `<@${ME}> are you available for the bring-up?`, {
      mentions: [{ id: ME }],
    }),
  ]);
  assert.equal(r.state.identity?.selfId, undefined); // never inferred
  assert.equal(
    r.state.lastGood.messages.items.find((i) => i.category === "reply")
      ?.status,
    "open"
  );

  // The user sends a reply: the POST response body is the sent message.
  const r2 = await adapter.observe.parse(
    net(
      `${API}/channels/${CH}/messages`,
      {
        id: "2302",
        channel_id: CH,
        content: "yes, 2pm works",
        timestamp: "2026-09-30T15:00:00.000Z",
        author: { id: ME },
      },
      { method: "POST", status: 200 }
    ),
    makeCtx(r.state, { watched: SETTINGS.watched }) // no userId in settings
  );
  assert.equal(r2.state.identity?.selfId, ME); // learned from the POST
  assert.equal(r2.session, "signed-in");
  assert.equal(
    r2.state.lastGood.messages.items.find((i) => i.category === "reply")
      ?.status,
    "done"
  );
  // POSTs never create candidate items.
  assert.equal(
    r2.state.lastGood.messages.items.filter(
      (i) => i.meta?.messageId === "2302"
    ).length,
    0
  );
});

test("done survives a re-read of the question message", async () => {
  const question = restMsg("2401", CH, `<@${ME}> thoughts on the layout?`, {
    mentions: [{ id: ME }],
  });
  const r = await readWithQuestion([question]);
  const r2 = await adapter.observe.parse(
    net(`${API}/channels/${CH}/messages?limit=50`, [
      restMsg("2402", CH, "lgtm", {
        author: { id: ME },
        timestamp: "2026-09-30T15:00:00.000Z",
      }),
    ]),
    makeCtx(r.state)
  );
  assert.equal(
    r2.state.lastGood.messages.items.find((i) => i.category === "reply")
      ?.status,
    "done"
  );
  // History re-read that still contains the question: repliesDone
  // re-applies "done" to the regenerated item.
  const r3 = await adapter.observe.parse(
    net(`${API}/channels/${CH}/messages?limit=50`, [question]),
    makeCtx(r2.state)
  );
  const reply = r3.state.lastGood.messages.items.find(
    (i) => i.category === "reply"
  );
  assert.equal(reply?.status, "done");
});

test("assigned task: DONE_RE reply from the assigner or self closes it", async () => {
  const taskMsg = restMsg("3001", CH, `<@${ME}> can you check the power section`, {
    mentions: [{ id: ME }],
    author: { id: ALICE },
  });
  const r = await readWithQuestion([taskMsg]);
  const task = r.state.lastGood.messages.items.find(
    (i) => i.meta?.messageId === "3001" && i.type === "task"
  );
  assert.ok(task);
  assert.equal(task.status, "open");
  assert.equal(task.meta?.category, undefined);
  assert.equal(task.meta?.assignerKey, hashString(ALICE));
  assert.notEqual(task.meta?.assignerKey, ALICE); // hash, never the raw id

  // Third party saying "done" does NOT close it.
  const r2 = await adapter.observe.parse(
    net(`${API}/channels/${CH}/messages?limit=50`, [
      restMsg("3002", CH, "done", {
        author: { id: BOB },
        timestamp: "2026-09-30T15:00:00.000Z",
        ...replyTo("3001"),
      }),
    ]),
    makeCtx(r.state)
  );
  const t2 = r2.state.lastGood.messages.items.find(
    (i) => i.meta?.messageId === "3001" && i.type === "task"
  );
  assert.equal(t2?.status, "open");

  // The assigner (hash-matched) saying "fixed" closes it.
  const r3 = await adapter.observe.parse(
    net(`${API}/channels/${CH}/messages?limit=50`, [
      restMsg("3003", CH, "fixed in the new spin", {
        author: { id: ALICE },
        timestamp: "2026-09-30T16:00:00.000Z",
        ...replyTo("3001"),
      }),
    ]),
    makeCtx(r2.state)
  );
  const t3 = r3.state.lastGood.messages.items.find(
    (i) => i.meta?.messageId === "3001" && i.type === "task"
  );
  assert.equal(t3?.status, "done");
  assert.ok(r3.state.tasksDone["3001"]);

  // Fresh task, closed by a self-authored "shipped" reply instead.
  const r4 = await readWithQuestion(
    [
      restMsg("3004", CH, `<@${ME}> can you check the bom`, {
        mentions: [{ id: ME }],
        author: { id: ALICE },
      }),
    ],
    { state: r3.state }
  );
  const r5 = await adapter.observe.parse(
    net(`${API}/channels/${CH}/messages?limit=50`, [
      restMsg("3005", CH, "shipped it", {
        author: { id: ME },
        timestamp: "2026-09-30T17:00:00.000Z",
        ...replyTo("3004"),
      }),
    ]),
    makeCtx(r4.state)
  );
  assert.equal(
    r5.state.lastGood.messages.items.find(
      (i) => i.meta?.messageId === "3004" && i.type === "task"
    )?.status,
    "done"
  );
});

test("privacy: no author id other than selfId lands in state", async () => {
  const r1 = await adapter.observe.parse(dom(inventory), makeCtx());
  // The mentions endpoint teaches identity.selfId and produces items.
  const r = await adapter.observe.parse(
    net(`${API}/users/@me/mentions?limit=25`, [
      restMsg("4001", CH, `<@${ME}> can you check the usb section`, {
        mentions: [{ id: ME }],
        author: { id: ALICE },
      }),
      restMsg("4002", CH, `<@${ME}> lmk when firmware lands?`, {
        mentions: [{ id: ME }],
        author: { id: BOB },
      }),
    ]),
    makeCtx(r1.state)
  );
  const json = JSON.stringify(r.state);
  assert.equal(r.state.identity?.selfId, ME);
  assert.ok(json.includes(ME), "selfId is stored");
  assert.ok(!json.includes(ALICE), "assigner id never persisted");
  assert.ok(!json.includes(BOB), "other author ids never persisted");
  const task = r.state.lastGood.messages.items.find(
    (i) => i.meta?.messageId === "4001"
  );
  assert.equal(task?.meta?.assignerKey, hashString(ALICE));
  assert.notEqual(task?.meta?.assignerKey, ALICE);
});
