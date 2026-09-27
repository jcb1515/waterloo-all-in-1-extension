// @ts-check
// Candidate extraction: exact <t:> dates, text dates, triggers, privacy caps.
import test from "node:test";
import assert from "node:assert/strict";
import { extractDates } from "../../extension/src/lib/textdates/index.js";
import {
  candidatesForMessage,
  discordTimestamps,
  stripMarkup,
  domMessageToRest,
} from "../../extension/src/sources/discord/messages.js";

const NOW_ISO = "2026-10-01T12:00:00.000Z";
// 2026-10-08T22:00:00Z = Oct 8, 6 PM EDT
const TS_OCT8_6PM = 1791496800;
// 2026-10-06T01:00:00Z = Oct 5, 9 PM EDT (Toronto day is Oct 5)
const TS_OCT5_EVENING = 1791248400;
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

test("discordTimestamps converts unix seconds and ms; :d is all-day Toronto", () => {
  const [t] = discordTimestamps(`<t:${TS_OCT8_6PM}>`);
  assert.equal(t.startAt, "2026-10-08T22:00:00.000Z");
  const [ms] = discordTimestamps(`<t:${TS_OCT8_6PM}000>`);
  assert.equal(ms.startAt, t.startAt); // ms-width values accepted verbatim
  const [d] = discordTimestamps(`<t:${TS_OCT5_EVENING}:d>`);
  assert.equal(d.allDay, true);
  assert.equal(d.startAt, "2026-10-05T04:00:00.000Z"); // Toronto Oct 5
});

test("meeting trigger + exact <t:> -> meeting item, pending review", () => {
  const [item] = candidatesForMessage(
    msg(`design review at <t:${TS_OCT8_6PM}>`),
    O()
  );
  assert.equal(item.type, "meeting");
  assert.equal(item.startAt, "2026-10-08T22:00:00.000Z");
  assert.equal(item.confidence, "exact");
  assert.equal(item.review, "pending");
  assert.equal(item.org, "Robotics Club");
  assert.equal(item.url, "https://discord.com/channels/1001/2001/9001");
  assert.ok(item.evidence.snippet.length <= 300);
});

test("deadline trigger + text date -> deadline with dueAt", () => {
  const [item] = candidatesForMessage(
    msg("BOM is due October 10 at 5pm"),
    O()
  );
  assert.equal(item.type, "deadline");
  assert.equal(item.dueAt, "2026-10-10T21:00:00.000Z"); // 5pm EDT
  assert.equal(item.confidence, "tentative");
  assert.equal(item.meta.trigger, "due");
});

test('"by <date>" alone counts as a deadline trigger; all-day hits use startAt', () => {
  const [item] = candidatesForMessage(
    msg("can we all be ready by October 12"),
    O()
  );
  assert.equal(item.type, "deadline");
  assert.equal(item.startAt, "2026-10-12T04:00:00.000Z");
  assert.equal(item.allDay, true);
});

test("assigned-to-me + task verb -> task; undated -> +7d follow-up", () => {
  const [item] = candidatesForMessage(
    msg("can you route the new connector footprints", {
      mentions: [{ id: "42" }],
    }),
    O()
  );
  assert.equal(item.type, "task");
  assert.equal(item.meta.assignedToMe, true);
  assert.equal(item.meta.undated, true);
  assert.equal(item.dueAt, "2026-10-08T20:00:00.000Z");
  assert.match(item.details || "", /No due date/);
});

test("items carry meta.facts (Server/Channel/Assigned/Due)", () => {
  const fmap = (it) =>
    Object.fromEntries((it.meta.facts || []).map((f) => [f.label, f.value]));
  const [task] = candidatesForMessage(
    msg("can you route the new connector footprints", {
      mentions: [{ id: "42" }],
    }),
    O()
  );
  const f = fmap(task);
  assert.equal(f.Server, "Robotics Club");
  assert.equal(f.Channel, "#elec-general");
  assert.equal(f["Assigned to you"], "Yes");
  assert.equal(f.Due, "No date given (follow-up in 7 days)");
  const [meeting] = candidatesForMessage(
    msg(`design review at <t:${TS_OCT8_6PM}>`),
    O()
  );
  const g = fmap(meeting);
  assert.equal(g.Server, "Robotics Club");
  assert.equal(g.Channel, "#elec-general");
  assert.equal(g["Assigned to you"], undefined);
  assert.equal(g.Due, undefined);
});

test("no trigger and no <t:> -> no item", () => {
  assert.equal(candidatesForMessage(msg("see you October 10"), O()).length, 0);
});

test("bare <t:> -> event only when the channel is watched", () => {
  const m = msg(`mark your calendars <t:${TS_OCT8_6PM}>`);
  assert.equal(candidatesForMessage(m, O())[0].type, "event");
  assert.equal(candidatesForMessage(m, O({ watched: false })).length, 0);
});

test("exact <t:> and a text hit on the same instant collapse to one", () => {
  // "October 8 at 6 PM" EDT == <t:1791496800> == 22:00Z
  const items = candidatesForMessage(
    msg(`meeting October 8 at 6 PM <t:${TS_OCT8_6PM}>`),
    O()
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].startAt, "2026-10-08T22:00:00.000Z");
});

test("a date hit more than a day before the message is dropped", () => {
  assert.equal(
    candidatesForMessage(msg("deadline was September 20"), O()).length,
    0
  );
});

test("markup is stripped before extraction (no url/mention/code dates)", () => {
  assert.equal(
    stripMarkup("<@42> check https://x.dev/2026-10-10 `Nov 5`"),
    "check"
  );
});

test('"Date:/Time:/Location:" block upgrades an all-day hit; @everyone != me', () => {
  const [item] = candidatesForMessage(
    msg(
      [
        "CLUB F26 ALL HANDS",
        "Hey @everyone !",
        "Come hear about the term plan and grab pizza.",
        "🗓️ All Hands Meeting",
        "Date: Monday, Sept 14, 2026",
        "Time: 5:00 PM EST",
        "Location: E5 3101",
      ].join("\n"),
      { mention_everyone: true, timestamp: "2026-09-10T20:00:00.000Z" }
    ),
    O()
  );
  assert.equal(item.type, "meeting");
  assert.equal(item.title, "CLUB F26 ALL HANDS");
  assert.equal(item.startAt, "2026-09-14T21:00:00.000Z"); // 5pm Toronto (EDT)
  assert.equal(item.allDay, undefined);
  assert.equal(item.location, "E5 3101");
  assert.equal(item.meta.assignedToMe, false);
});

test("a 'Time: 5:00–7:00 PM' range sets endAt; URLs beat Location:", () => {
  const [item] = candidatesForMessage(
    msg(
      "meeting\nDate: October 12, 2026\nTime: 5:00–7:00 PM\nLocation: Zoom https://x.dev\nhttps://meet.google.com/abc-defg-hij"
    ),
    O()
  );
  assert.equal(item.startAt, "2026-10-12T21:00:00.000Z");
  assert.equal(item.endAt, "2026-10-12T23:00:00.000Z");
  assert.equal(item.location, "https://meet.google.com/abc-defg-hij");
});

test("meeting links become location; otherwise #channelName", () => {
  const [a] = candidatesForMessage(
    msg(`sync <t:${TS_OCT8_6PM}> in https://meet.google.com/abc-defg-hij`),
    O()
  );
  assert.equal(a.location, "https://meet.google.com/abc-defg-hij");
  const [b] = candidatesForMessage(msg(`sync <t:${TS_OCT8_6PM}>`), O());
  assert.equal(b.location, "#elec-general");
});

test("role pings count as assignedToMe; bare @everyone does not", () => {
  const [item] = candidatesForMessage(
    msg("please update the layout", { mention_roles: ["77"] }),
    O()
  );
  assert.equal(item.meta.assignedToMe, true);
  assert.equal(item.type, "task");
  const none = candidatesForMessage(
    msg("please update the layout", { mention_everyone: true }),
    O({ fromMentions: true })
  );
  assert.equal(none.length, 0); // bare @everyone via mentions: not personal
});

test("domMessageToRest re-inserts times as <t:> markers (same ids)", () => {
  const dom = domMessageToRest(
    {
      messageId: "9001",
      timestamp: "2026-10-01T20:00:00.000Z",
      content: "design review moved to October 8 at 6 PM",
      times: ["2026-10-08T22:00:00.000Z"],
      mentionsMe: false,
    },
    "2001"
  );
  assert.match(dom.content, /<t:1791496800>/);
  const rest = msg(
    `design review moved to October 8 at 6 PM <t:${TS_OCT8_6PM}>`
  );
  assert.equal(
    candidatesForMessage(dom, O())[0].id,
    candidatesForMessage(rest, O())[0].id
  );
});

test("non-default/reply types and empty content produce nothing", () => {
  assert.equal(
    candidatesForMessage(msg("meeting October 8", { type: 7 }), O()).length,
    0
  );
  assert.equal(candidatesForMessage(msg("   "), O()).length, 0);
});

test("multi-line DOM message: the title is line one only", () => {
  const dom = domMessageToRest(
    {
      messageId: "9004",
      timestamp: "2026-10-01T20:12:00.000Z",
      content: "meeting Thursday at 6pm\nsecond line that is private",
      times: [],
      roleMentions: [],
      mentionsMe: false,
    },
    "2001"
  );
  const [item] = candidatesForMessage(dom, O({ via: "dom" }));
  assert.equal(item.title, "meeting Thursday at 6pm");
  assert.ok(!JSON.stringify(item).includes("private"));
  assert.equal(item.meta.via, "dom");
});

test("an @everyone DOM ping is not assignedToMe — deadline, not task", () => {
  const dom = domMessageToRest(
    {
      messageId: "9005",
      timestamp: "2026-10-01T20:15:00.000Z",
      content: "@everyone please submit the form by October 9 at 5pm",
      times: [],
      roleMentions: ["@everyone"], // rendered with the roleMention class
      mentionsMe: true,            // Discord highlights it for everyone
    },
    "2001"
  );
  assert.equal(dom.mention_everyone, true);
  assert.equal(dom.domMentionsMe, false);
  const [item] = candidatesForMessage(dom, O({ via: "dom" }));
  assert.equal(item.type, "deadline");
  assert.equal(item.meta.assignedToMe, false);
});
