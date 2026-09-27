// @ts-check
// Watch config + channel scoring + watch selection.
import test from "node:test";
import assert from "node:assert/strict";
import {
  watchConfig,
  compareGuildNames,
  channelScore,
  watchForGuild,
} from "../../extension/src/sources/discord/rules.js";

const WATCHED = {
  "Robotics Club": { focus: ["electrical"] },
  "Rocket Team": {},
};

test("empty/missing settings.watched watches every guild, no focus", () => {
  assert.deepEqual(watchConfig("Robotics Club", {}), {
    team: "Robotics Club",
    focus: [],
  });
  assert.deepEqual(watchConfig("Fan Community", undefined), {
    team: "Fan Community",
    focus: [],
  });
});

test("a non-empty watched list is exclusive, matched case-insensitively", () => {
  const srv = watchConfig("  robotics club ", WATCHED);
  assert.equal(srv?.team, "Robotics Club"); // name as written in settings
  assert.deepEqual(srv?.focus, ["electrical"]);
  const rocket = watchConfig("ROCKET TEAM", WATCHED);
  assert.equal(rocket?.team, "Rocket Team");
  assert.deepEqual(rocket?.focus, []);
  assert.equal(watchConfig("Fan Community", WATCHED), null);
  assert.equal(watchConfig("Class Server", WATCHED), null);
});

test("sweep order: settings insertion order, then the rest alphabetically", () => {
  const cmp = compareGuildNames(WATCHED);
  const names = ["Zeta Club", "Robotics Club", "Alpha Club", "Rocket Team"];
  assert.deepEqual(names.sort(cmp), [
    "Robotics Club",
    "Rocket Team",
    "Alpha Club",
    "Zeta Club",
  ]);
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

test("a non-electrical focus boosts itself and is never penalised", () => {
  const focus = ["mechanical"];
  const mech = channelScore({ name: "mech-cad", category: "mechanical" }, focus);
  assert.ok(mech >= 5); // +3 name +2 category, no -2 subteam penalty
  const fw = channelScore({ name: "firmware-team" }, ["firmware"]);
  assert.ok(fw >= 3);
});

test("no focus: no subteam penalty at all", () => {
  const mech = channelScore({ name: "mech-cad", category: "mechanical" });
  assert.ok(mech >= 0);
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
