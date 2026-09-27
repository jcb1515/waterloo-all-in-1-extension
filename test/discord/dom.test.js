// @ts-check
// Pure DOM readers on the synthetic sidebar/message fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseHTML } from "linkedom";
import {
  readLocation,
  readGuilds,
  readChannels,
  readMessages,
  inventoryExtract,
} from "../../extension/src/sources/discord/dom.js";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "discord"
);
const doc = (name) => parseHTML(readFileSync(path.join(FIXTURES, name), "utf8")).document;

test("readLocation parses guild and DM paths", () => {
  assert.deepEqual(
    readLocation("https://discord.com/channels/1001/2001"),
    { guildId: "1001", channelId: "2001" }
  );
  assert.deepEqual(readLocation("https://discord.com/channels/@me"), {
    guildId: "@me",
    channelId: undefined,
  });
  assert.equal(readLocation("https://discord.com/"), null);
});

test("readGuilds strips unread/mention prefixes from aria-labels", () => {
  const guilds = readGuilds(doc("sidebar.html"));
  const byId = Object.fromEntries(guilds.map((g) => [g.guildId, g]));
  assert.deepEqual(byId["1000000000000000001"], {
    guildId: "1000000000000000001", name: "Robotics Club", unread: false, mentions: 0,
  });
  assert.deepEqual(byId["1000000000000000002"], {
    guildId: "1000000000000000002", name: "Rocket Team", unread: true, mentions: 3,
  });
  assert.ok(!guilds.some((g) => g.guildId === "home")); // DM rail excluded
});

test("readChannels: categories, types, unread/mentions, limited", () => {
  const channels = readChannels(doc("sidebar.html"));
  const byId = Object.fromEntries(channels.map((c) => [c.channelId, c]));
  assert.equal(channels.length, 8);
  const elec = byId["2000000000000000001"];
  assert.equal(elec.guildId, "1000000000000000001");
  assert.equal(elec.name, "elec-general");
  assert.equal(elec.category, "ELECTRICAL");
  assert.equal(elec.type, "text");
  assert.equal(elec.unread, true);
  const pcb = byId["2000000000000000002"];
  assert.equal(pcb.mentions, 2);
  assert.equal(pcb.limited, true);
  assert.equal(byId["2000000000000000004"].category, "MECHANICAL");
  assert.equal(byId["2000000000000000003"].type, "announcement");
  assert.equal(byId["2000000000000000007"].type, "voice");
  assert.equal(byId["2000000000000000008"].type, "stage");
  // Sidebar order preserved
  assert.ok(byId["2000000000000000001"].order < byId["2000000000000000006"].order);
});

test("readMessages: ids, timestamps, <time> datetimes, mentionsMe", () => {
  const msgs = readMessages(doc("chat-messages.html"));
  assert.equal(msgs.length, 4);
  const [m1, m2] = msgs;
  assert.equal(m1.channelId, "2000000000000000001");
  assert.equal(m1.messageId, "9000000000000000001");
  assert.equal(m1.timestamp, "2026-10-01T20:05:00.000Z");
  assert.deepEqual(m1.times, ["2026-10-06T22:00:00.000Z"]);
  assert.equal(m1.mentionsMe, false);
  assert.equal(m2.mentionsMe, true);
  assert.deepEqual(m2.roleMentions, ["@electrical"]);
  // <br> becomes a real newline — the title's "first line" means line one.
  assert.equal(msgs[3].content, "meeting Thursday at 6pm\nsecond line that is private");
});

test("inventoryExtract bundles location + guilds + channels", () => {
  const inv = inventoryExtract(
    doc("sidebar.html"),
    "https://discord.com/channels/1000000000000000001/2000000000000000001"
  );
  assert.equal(inv.type, "inventory");
  assert.equal(inv.location.guildId, "1000000000000000001");
  assert.ok(inv.guilds.length >= 4);
  assert.equal(inv.channels.length, 8);
});
