// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { teamCards, assignedToMe } from "../../extension/src/panel/model/teams.js";

// Wednesday, Sep 30 2026 noon.
const NOW = new Date("2026-09-30T16:00:00.000Z");
const HOUR = 3600000;
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

const item = (id, over) => ({
  id,
  source: "discord",
  type: "task",
  title: id,
  org: "WATonomous",
  status: "open",
  confidence: "exact",
  review: "auto",
  ...over,
});

const sourceState = {
  discord: {
    state: {
      guilds: { "9102": { name: "WATonomous" }, "8804": { name: "ECE 2027" } },
      unreadWatched: [
        { guildId: "9102", guildName: "WATonomous", channelId: "1", name: "general", url: "https://d/1", mentions: 2 },
        { guildId: "8804", guildName: "ECE 2027", channelId: "2", name: "labs", url: "https://d/2", mentions: 0 },
      ],
      sweepQueue: [],
    },
  },
};

const settings = {
  sources: { discord: { watched: { WATonomous: { focus: ["electrical"] }, "ECE 2027": { focus: [] } } } },
};

test("one card per watched team with focus tags and unread channels", () => {
  const { teams } = teamCards({ items: {}, sourceState, settings, now: NOW });
  assert.equal(teams.length, 2);
  assert.equal(teams[0].name, "WATonomous");
  assert.deepEqual(teams[0].focus, ["electrical"]);
  assert.equal(teams[0].unread.length, 1);
  assert.equal(teams[0].unread[0].name, "general");
  assert.equal(teams[1].unread.length, 1);
});

test("next meeting, weekly flag, tasks, deadlines, pending count", () => {
  const items = {
    m1: item("m1", {
      type: "meeting",
      title: "Sync (weekly)",
      startAt: iso(NOW.getTime() + 26 * HOUR),
      meta: { recurrence: { freq: "WEEKLY" } },
    }),
    t1: item("t1", { meta: { assignedToMe: true }, dueAt: iso(NOW.getTime() + 2 * DAY) }),
    t2: item("t2", {
      meta: { facts: [{ label: "Assigned to you", value: "Yes" }] },
      dueAt: iso(NOW.getTime() + 3 * DAY),
    }),
    t3: item("t3", { dueAt: iso(NOW.getTime() + 2 * DAY) }), // not assigned
    d1: item("d1", { type: "deadline", dueAt: iso(NOW.getTime() + 4 * DAY) }),
    p1: item("p1", { review: "pending", dueAt: iso(NOW.getTime() + DAY) }),
    done1: item("done1", { status: "done", dueAt: iso(NOW.getTime() + DAY), meta: { assignedToMe: true } }),
  };
  const { teams } = teamCards({ items, sourceState, settings, now: NOW });
  const wato = teams.find((t) => t.name === "WATonomous");
  assert.equal(wato.nextMeeting.id, "m1");
  assert.equal(wato.weekly, true);
  assert.deepEqual(wato.tasks.map((t) => t.id), ["t1", "t2"]);
  // Unassigned tasks with a due date still list under Deadlines.
  assert.deepEqual(wato.deadlines.map((d) => d.id), ["t3", "d1"]);
  assert.equal(wato.pendingCount, 1);
  assert.deepEqual(wato.week.map((w) => w.id).sort(), ["d1", "m1", "t1", "t2", "t3"]);
});

test("unwatched teams fall back to teams seen in discord items", () => {
  const items = { a: item("a", { org: "Rocketry" }), b: item("b", { org: "WATonomous" }) };
  const { teams, watchedEmpty } = teamCards({
    items,
    sourceState: {},
    settings: { sources: { discord: { watched: {} } } },
    now: NOW,
  });
  assert.equal(watchedEmpty, true);
  assert.deepEqual(teams.map((t) => t.name), ["Rocketry", "WATonomous"]);
});

test("hidden and done items stay out of the card lists", () => {
  const items = {
    h: item("h", { dueAt: iso(NOW.getTime() + DAY), meta: { assignedToMe: true } }),
    s: item("s", {
      dueAt: iso(NOW.getTime() + DAY),
      meta: { assignedToMe: true },
    }),
  };
  const userState = { h: { hidden: true }, s: { snoozedUntil: iso(NOW.getTime() + 3 * DAY) } };
  const { teams } = teamCards({ items, userState, sourceState, settings, now: NOW });
  assert.equal(teams[0].tasks.length, 0);
});

test("assignedToMe via meta flag or the fact", () => {
  assert.equal(assignedToMe(item("x", { meta: { assignedToMe: true } })), true);
  assert.equal(
    assignedToMe(item("x", { meta: { facts: [{ label: "Assigned to you", value: "Yes" }] } })),
    true
  );
  assert.equal(assignedToMe(item("x", {})), false);
});
