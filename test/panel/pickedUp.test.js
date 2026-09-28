// @ts-check
// pickedUpGroups: source/seenIn matching, Outlook's gmail/email aliasing,
// group order, upcoming-vs-earlier split and the pending-review pass-through.

import test from "node:test";
import assert from "node:assert/strict";
import { pickedUpGroups } from "../../extension/src/panel/model/pickedUp.js";

// Mid-day local time — "start of today" is this date's local midnight.
const NOW = new Date(2026, 8, 28, 15, 0, 0);
const TODAY_START = new Date(2026, 8, 28).getTime();
const iso = (ms) => new Date(ms).toISOString();

/** @param {any} o */
const item = (o) => ({ id: o.id || `i${Math.random()}`, type: "event", ...o });

test("matches item.source and any seenIn[].source", () => {
  const items = {
    a: item({ id: "a", source: "waterlooworks", dueAt: iso(TODAY_START + 3600000) }),
    b: item({
      id: "b",
      source: "portal",
      seenIn: [{ source: "waterlooworks", key: "k", at: iso(TODAY_START) }],
      dueAt: iso(TODAY_START + 3600000),
    }),
    c: item({ id: "c", source: "learn", dueAt: iso(TODAY_START + 3600000) }),
  };
  const groups = pickedUpGroups(items, "waterlooworks", NOW);
  const all = groups.flatMap((g) => [...g.upcoming, ...g.earlier]);
  assert.deepEqual(
    all.map((i) => i.id).sort(),
    ["a", "b"],
    "source + seenIn match; learn excluded"
  );
});

test("outlook matches gmail/outlook/email items; other sources don't", () => {
  const items = {
    g: item({ id: "g", source: "gmail", dueAt: iso(TODAY_START + 3600000) }),
    o: item({ id: "o", source: "outlook", dueAt: iso(TODAY_START + 3600000) }),
    e: item({ id: "e", source: "email", dueAt: iso(TODAY_START + 3600000) }),
    w: item({ id: "w", source: "waterlooworks", dueAt: iso(TODAY_START + 3600000) }),
  };
  const all = pickedUpGroups(items, "outlook", NOW).flatMap((g) => [
    ...g.upcoming,
    ...g.earlier,
  ]);
  assert.deepEqual(all.map((i) => i.id).sort(), ["e", "g", "o"]);
  const gmail = pickedUpGroups(items, "gmail", NOW).flatMap((g) => [
    ...g.upcoming,
    ...g.earlier,
  ]);
  assert.deepEqual(gmail.map((i) => i.id), ["g"], "gmail id only matches itself");
});

test("groups come out in the fixed order and skip empty ones", () => {
  const types = [
    ["other", "presentation"], // falls through to Other
    ["class", "tutorial"],
    ["exam", "exam"],
    ["term", "term-date"],
    ["interview", "interview"],
    ["deadline", "application-deadline"],
    ["event", "meeting"],
    ["deadline", "quiz"],
  ];
  const items = {};
  for (const [key, type] of types) {
    items[`${key}-${type}`] = item({
      id: `${key}-${type}`,
      source: "waterlooworks",
      type,
      dueAt: iso(TODAY_START + 3600000),
    });
  }
  const groups = pickedUpGroups(items, "waterlooworks", NOW);
  assert.deepEqual(
    groups.map((g) => g.key),
    ["exam", "interview", "deadline", "event", "class", "term", "other"]
  );
  const deadline = groups.find((g) => g.key === "deadline");
  assert.equal(deadline.count, 2, "quiz + application-deadline both deadline-like");
  assert.equal(groups.find((g) => g.key === "class").collapsed, true);
  assert.equal(groups.find((g) => g.key === "exam").collapsed, false);
});

test("upcoming sorts ascending, earlier descending, by the dueAt||startAt anchor", () => {
  const items = {
    soon: item({ id: "soon", source: "waterlooworks", type: "deadline", dueAt: iso(TODAY_START + 3600000) }),
    later: item({ id: "later", source: "waterlooworks", type: "deadline", dueAt: iso(TODAY_START + 3 * 86400000) }),
    todayEdge: item({ id: "todayEdge", source: "waterlooworks", type: "deadline", dueAt: iso(TODAY_START) }),
    yesterday: item({ id: "yesterday", source: "waterlooworks", type: "deadline", dueAt: iso(TODAY_START - 1000) }),
    weekAgo: item({ id: "weekAgo", source: "waterlooworks", type: "deadline", dueAt: iso(TODAY_START - 7 * 86400000) }),
    noAnchor: item({ id: "noAnchor", source: "waterlooworks", type: "deadline" }),
  };
  const [g] = pickedUpGroups(items, "waterlooworks", NOW);
  assert.equal(g.key, "deadline");
  assert.deepEqual(
    g.upcoming.map((i) => i.id),
    ["todayEdge", "soon", "later"],
    "anchor >= start of today, ascending"
  );
  assert.deepEqual(
    g.earlier.map((i) => i.id),
    ["yesterday", "weekAgo", "noAnchor"],
    "earlier descending; anchorless last"
  );
});

test("startAt anchors when dueAt is absent; review:pending items are kept", () => {
  const items = {
    timed: item({
      id: "timed",
      source: "discord",
      type: "event",
      startAt: iso(TODAY_START + 2 * 3600000),
      review: "pending",
    }),
    past: item({
      id: "past",
      source: "discord",
      type: "event",
      startAt: iso(TODAY_START - 3600000),
      review: "auto",
    }),
  };
  const [g] = pickedUpGroups(items, "discord", NOW);
  assert.deepEqual(
    g.upcoming.map((i) => i.id),
    ["timed"],
    "startAt-only item counts as upcoming"
  );
  assert.equal(g.upcoming[0].review, "pending", "pending items pass through");
  assert.equal(g.earlier.length, 1);
});

test("an empty match set returns no groups", () => {
  assert.deepEqual(pickedUpGroups({}, "waterlooworks", NOW), []);
  assert.deepEqual(
    pickedUpGroups({ a: item({ source: "learn" }) }, "gcal", NOW),
    []
  );
});
