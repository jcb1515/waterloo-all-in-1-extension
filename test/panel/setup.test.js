// @ts-check
// Panel setup model: Discord channel picker rows + the whole-map patch
// builders (channelTargets, outline urls, sections, groups).
import test from "node:test";
import assert from "node:assert/strict";
import {
  channelPicker,
  toggleChannelPatch,
  resetChannelsPatch,
  outlineUrlPatch,
  sectionsPatch,
  groupPatch,
  termLabel,
} from "../../extension/src/panel/model/setup.js";

const GUILD = (name, channels, extra = {}) => ({
  name,
  lastInventoryAt: "2026-10-01T00:00:00.000Z",
  channels,
  ...extra,
});

// Robotics Club: announcements + deadlines + elec-pcb suggested; memes and
// the voice lounge are not.
const STATE = {
  guilds: {
    g1: GUILD("Robotics Club", {
      c1: { name: "announcements", type: "text", category: "INFO", order: 0 },
      c2: { name: "elec-pcb", type: "text", category: "ELECTRICAL", order: 1 },
      c3: { name: "memes", type: "text", category: "CHILL", order: 0 },
      c4: { name: "deadlines", type: "text", category: "INFO", order: 1 },
      c5: { name: "voice-lounge", type: "voice", category: "VOICE", order: 0 },
    }),
    g2: GUILD("Rocket Team", {
      r1: { name: "general", type: "text", category: "TEAM", order: 0 },
      r2: { name: "meetings", type: "text", category: "TEAM", order: 1 },
    }),
  },
};

test("channelPicker: watched guilds only, live checked vs suggested", () => {
  const rows = channelPicker(STATE, { watched: {}, channelTargets: {} });
  assert.equal(rows.length, 2); // empty watched -> every guild watched
  const rob = rows.find((r) => r.name === "Robotics Club");
  assert.equal(rob.mode, "auto");
  assert.equal(rob.noInventory, false);
  // Voice channel excluded; sorted by category then order.
  assert.deepEqual(
    rob.channels.map((c) => c.id),
    ["c3", "c2", "c1", "c4"]
  );
  const byId = Object.fromEntries(rob.channels.map((c) => [c.id, c]));
  assert.equal(byId.c1.checked, true); // announcements suggested
  assert.equal(byId.c4.checked, true); // deadlines suggested
  assert.equal(byId.c2.checked, false); // elec-pcb: no focus -> score 0
  assert.equal(byId.c3.checked, false); // memes penalised
  assert.equal(byId.c1.suggested, true);
  assert.equal(byId.c2.suggested, false);
});

test("channelPicker: an exclusive watched list drops other guilds", () => {
  const rows = channelPicker(STATE, {
    watched: { "Robotics Club": {} },
    channelTargets: {},
  });
  assert.deepEqual(rows.map((r) => r.name), ["Robotics Club"]);
});

test("channelPicker: targets -> custom mode, checked follows the list", () => {
  const rows = channelPicker(STATE, {
    watched: {},
    channelTargets: { "Robotics Club": ["deadlines", "c9"] },
  });
  const rob = rows.find((r) => r.name === "Robotics Club");
  assert.equal(rob.mode, "custom");
  const byId = Object.fromEntries(rob.channels.map((c) => [c.id, c]));
  assert.equal(byId.c4.checked, true); // "deadlines" resolved to c4
  assert.equal(byId.c1.checked, false); // suggested but not targeted
  assert.equal(byId.c1.suggested, true); // suggested still shows the auto pick
  // The untargeted guild stays automatic.
  assert.equal(rows.find((r) => r.name === "Rocket Team").mode, "auto");
});

test("channelPicker: no inventory flags the guild", () => {
  const rows = channelPicker(
    { guilds: { g9: { name: "New Server", channels: {} } } },
    { watched: {} }
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].noInventory, true);
  assert.deepEqual(rows[0].channels, []);
});

test("toggleChannelPatch: auto mode seeds from checked ids", () => {
  const settings = { watched: {}, channelTargets: {} };
  const [rob] = channelPicker(STATE, settings).filter(
    (r) => r.name === "Robotics Club"
  );
  // Untick a suggested channel -> custom list of the still-checked ids.
  let next = toggleChannelPatch(settings, rob, "c1", false);
  assert.deepEqual(next, { "Robotics Club": ["c4"] });
  // Tick an unsuggested one -> checked set plus it.
  next = toggleChannelPatch(settings, rob, "c2", true);
  assert.deepEqual(next, { "Robotics Club": ["c1", "c4", "c2"] });
  // Unticking everything drops the key -> back to automatic.
  const onlyOne = { "Robotics Club": ["c4"] };
  const s2 = { watched: {}, channelTargets: onlyOne };
  const rob2 = channelPicker(STATE, s2).find((r) => r.name === "Robotics Club");
  next = toggleChannelPatch(s2, rob2, "c4", false);
  assert.deepEqual(next, {});
});

test("toggleChannelPatch: custom mode edits the stored list, names resolve", () => {
  const settings = {
    watched: {},
    channelTargets: { "robotics club": ["deadlines", "c9"] },
  };
  const rob = channelPicker(STATE, settings).find(
    (r) => r.name === "Robotics Club"
  );
  // Unticking c4 removes the "deadlines" entry that resolved to it, and the
  // unresolved "c9" is preserved. The existing key's spelling is kept.
  const next = toggleChannelPatch(settings, rob, "c4", false);
  assert.deepEqual(next, { "robotics club": ["c9"] });
  // Ticking an extra channel appends its id.
  const next2 = toggleChannelPatch(settings, rob, "c1", true);
  assert.deepEqual(next2, { "robotics club": ["deadlines", "c9", "c1"] });
});

test("toggleChannelPatch: custom via watched entry carries stored names", () => {
  const settings = {
    watched: { "Robotics Club": { channels: ["deadlines", "not-there"] } },
  };
  const rob = channelPicker(STATE, settings).find(
    (r) => r.name === "Robotics Club"
  );
  assert.equal(rob.mode, "custom");
  // Unticking the resolved channel drops its name but keeps the unresolved.
  const next = toggleChannelPatch(settings, rob, "c4", false);
  assert.deepEqual(next, { "Robotics Club": ["not-there"] });
  // Ticking a channel appends to the carried-over list.
  const next2 = toggleChannelPatch(settings, rob, "c1", true);
  assert.deepEqual(next2, { "Robotics Club": ["deadlines", "not-there", "c1"] });
});

test("resetChannelsPatch removes the guild (any key spelling)", () => {
  const settings = {
    channelTargets: { "robotics club": ["c1"], "Rocket Team": ["r1"] },
  };
  assert.deepEqual(resetChannelsPatch(settings, "Robotics Club"), {
    "Rocket Team": ["r1"],
  });
  assert.deepEqual(resetChannelsPatch(settings, "Nobody"), {
    "robotics club": ["c1"],
    "Rocket Team": ["r1"],
  });
});

test("outlineUrlPatch sets and removes by normalised code", () => {
  const settings = { sources: { outline: { urls: { "ECE 105": "u1" } } } };
  const next = outlineUrlPatch(settings, "math117", "https://x/viewer/view/a");
  assert.deepEqual(next, {
    "ECE 105": "u1",
    "MATH 117": "https://x/viewer/view/a",
  });
  assert.deepEqual(outlineUrlPatch(settings, "ECE105", null), {});
  // Empty string removes too; unknown/blank codes are no-ops.
  assert.deepEqual(outlineUrlPatch(settings, "ECE 105", "  "), {});
  assert.deepEqual(outlineUrlPatch(settings, "   ", "u"), { "ECE 105": "u1" });
});

test("sectionsPatch parses a comma list, empty removes", () => {
  const settings = {
    profile: { sections: { "ECE 105": ["LEC 001"], "MATH 117": ["LEC 002"] } },
  };
  const next = sectionsPatch(settings, "ece105", "lec 002,  tut   104");
  assert.deepEqual(next, {
    "ECE 105": ["LEC 002", "TUT 104"],
    "MATH 117": ["LEC 002"],
  });
  assert.deepEqual(sectionsPatch(settings, "ECE 105", ""), {
    "MATH 117": ["LEC 002"],
  });
});

test("groupPatch sets and clears", () => {
  const settings = { profile: { groups: { "ECE 190": "5" } } };
  assert.deepEqual(groupPatch(settings, "ece190", " 7 "), { "ECE 190": "7" });
  assert.deepEqual(groupPatch(settings, "ECE 190", ""), {});
});

test("termLabel renders UW term codes", () => {
  assert.equal(termLabel(1269), "Fall 2026 (1269)");
  assert.equal(termLabel(1271), "Winter 2027 (1271)");
  assert.equal(termLabel("x"), "x");
});
