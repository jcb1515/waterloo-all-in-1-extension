// @ts-check
// Server matching + channel scoring + watch selection.
import test from "node:test";
import assert from "node:assert/strict";
import {
  serverFor,
  channelScore,
  watchForGuild,
} from "../../extension/src/sources/discord/rules.js";

test("SERVERS match guild names case-insensitively after trim", () => {
  assert.equal(serverFor("  watonomous ")?.team, "WATonomous");
  assert.equal(serverFor("WARG")?.team, "WARG");
  assert.equal(
    serverFor("Waterloo Aerial Robotics Group")?.team,
    "WARG"
  );
  assert.equal(serverFor("ECE Waterloo '31")?.team, "ECE '31");
  assert.equal(serverFor("Random Fan Server"), null);
});

test("a settings.watched guild outside SERVERS becomes watched", () => {
  const srv = serverFor("My Capstone Group", {
    "My Capstone Group": { focus: ["electrical"] },
  });
  assert.equal(srv?.team, "My Capstone Group");
  assert.deepEqual(srv?.focus, ["electrical"]);
});

test("electrical guild: elec words outrank subteam words; off-topic sinks", () => {
  const focus = ["electrical"];
  const elec = channelScore({ name: "elec-tasks", category: "electrical" }, focus);
  const mech = channelScore({ name: "mech-cad", category: "mechanical" }, focus);
  const off = channelScore({ name: "memes", category: "general" }, focus);
  assert.ok(elec > mech); // +3 elec +2 category +3 tasks vs -2 mech
  assert.ok(elec >= 3);
  assert.ok(mech < 3); // -2 subteam, below the suggestion bar
  assert.ok(off < 0);
});

test("voice/stage channels are never suggested", () => {
  assert.equal(channelScore({ name: "announcements", type: "voice" }), -Infinity);
  assert.equal(channelScore({ name: "events", type: "stage" }), -Infinity);
});

test("watchForGuild: suggestions top-12 by score, settings replace", () => {
  const guild = {
    channels: {
      c1: { name: "announcements", type: "text", order: 0 },
      c2: { name: "elec-pcb", type: "text", category: "electrical", order: 1 },
      c3: { name: "random", type: "text", order: 2 },
      c4: { name: "deadlines", type: "text", order: 3 },
    },
  };
  const sug = watchForGuild(guild, ["electrical"]);
  assert.equal(sug.from, "suggested");
  assert.ok(sug.channelIds.includes("c1"));
  assert.ok(sug.channelIds.includes("c4"));
  assert.ok(sug.channelIds.includes("c2"));
  assert.ok(!sug.channelIds.includes("c3")); // -5: random

  const set = watchForGuild(guild, ["electrical"], { channels: ["random", "c9"] });
  assert.equal(set.from, "settings");
  assert.deepEqual(set.channelIds.sort(), ["c3", "c9"]); // name + unknown id kept
});
