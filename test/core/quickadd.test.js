// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseQuickAdd,
  manualItemFrom,
  manualUpsertResult,
  manualDeleteResult,
} from "../../extension/src/core/quickadd.js";
import { applyResult, recompute } from "../../extension/src/core/merge.js";

// Wednesday, Sep 30 2026 12:00 EDT.
const NOW = new Date("2026-09-30T16:00:00.000Z");
const ORGS = ["ECE 105", "MATH 117", "WATonomous", "ECE 2027"];

const parse = (text, orgs = ORGS) => parseQuickAdd(text, { now: NOW, orgs });

test("course code + quiz + weekday time -> dueAt that day", () => {
  const p = parse("ECE 105 quiz Friday 3pm");
  assert.equal(p.org, "ECE 105");
  assert.equal(p.type, "quiz");
  // Friday = Oct 2, 15:00 EDT.
  assert.equal(p.dueAt, "2026-10-02T19:00:00.000Z");
  assert.equal(p.startAt, undefined);
  assert.equal(p.location, "");
  assert.equal(p.title, "Quiz");
});

test("range + room + team name", () => {
  const p = parse("WATonomous meeting tomorrow 6-7pm E7 2324");
  assert.equal(p.org, "WATonomous");
  assert.equal(p.type, "meeting");
  assert.equal(p.startAt, "2026-10-01T22:00:00.000Z");
  assert.equal(p.endAt, "2026-10-01T23:00:00.000Z");
  assert.equal(p.location, "E7 2324");
  assert.equal(p.title, "Meeting");
});

test("all-day hit + due word -> dueAt 23:59 Toronto", () => {
  const p = parse("Resume due Oct 10");
  assert.equal(p.type, "deadline");
  assert.equal(p.allDay, true);
  // Oct 10 23:59 EDT = Oct 11 03:59Z.
  assert.equal(p.dueAt, "2026-10-10T23:59:00-04:00" && "2026-10-11T03:59:00.000Z");
  assert.equal(p.title, "Resume");
});

test("known course code mid-string", () => {
  const p = parse("midterm MATH 117 Thursday");
  assert.equal(p.org, "MATH 117");
  assert.equal(p.type, "exam");
  // Thursday Oct 1 all-day.
  assert.equal(p.dueAt, "2026-10-02T03:59:00.000Z");
});

test("unknown leading course code still becomes the org", () => {
  const p = parse("STAT 230 quiz next Tuesday", []);
  assert.equal(p.org, "STAT 230");
  assert.equal(p.type, "quiz");
  assert.equal(p.dueAt, "2026-10-07T03:59:00.000Z");
});

test("course code with a suffix letter", () => {
  const p = parse("CS 246E assignment due Oct 8", []);
  assert.equal(p.org, "CS 246E");
  assert.equal(p.type, "deadline");
  assert.equal(p.dueAt, "2026-10-09T03:59:00.000Z");
});

test("the org code is never mistaken for a room", () => {
  const p = parse("ECE 105 quiz Friday 3pm E7 2324");
  assert.equal(p.org, "ECE 105");
  assert.equal(p.location, "E7 2324");
});

test("no date -> task with no anchor", () => {
  const p = parse("Buy poster board");
  assert.equal(p.type, "task");
  assert.equal(p.dueAt, undefined);
  assert.equal(p.startAt, undefined);
  assert.equal(p.confidence, 0);
  assert.equal(p.title, "Buy poster board");
});

test("timed non-keyword phrase -> event", () => {
  const p = parse("Coffee chat with Sam tomorrow 4pm", []);
  assert.equal(p.type, "event");
  assert.equal(p.startAt, "2026-10-01T20:00:00.000Z");
});

test("interview keyword + building room", () => {
  const p = parse("Interview with Acme Thursday 2pm MC 4020", []);
  assert.equal(p.type, "interview");
  assert.equal(p.startAt, "2026-10-01T18:00:00.000Z");
  assert.equal(p.location, "MC 4020");
});

test("lab + due stays a lab deadline", () => {
  const p = parse("ECE 105 lab report due Friday");
  assert.equal(p.org, "ECE 105");
  assert.equal(p.type, "lab");
  assert.equal(p.allDay, true);
  assert.equal(p.dueAt, "2026-10-03T03:59:00.000Z");
});

test("empty/blank input falls back to a Task", () => {
  const p = parse("   ", []);
  assert.equal(p.type, "task");
  assert.equal(p.title, "Task");
});

test("team name that looks like a course code", () => {
  const p = parse("ECE 2027 standup tomorrow 9am");
  assert.equal(p.org, "ECE 2027");
  assert.equal(p.type, "meeting");
  assert.equal(p.startAt, "2026-10-01T13:00:00.000Z");
});

test("multi-word room like DWE 1515", () => {
  const p = parse("Design review tomorrow 10am DWE 1515", []);
  assert.equal(p.location, "DWE 1515");
});

/* ------------------------- manual raw round trip ------------------------- */

test("manual upsert -> raw -> recompute shows the item; delete removes it", () => {
  const item = manualItemFrom(
    parse("ECE 105 quiz Friday 3pm"),
    { id: "manual:q1", now: NOW }
  );
  assert.equal(item.source, "manual");
  assert.equal(item.confidence, "exact");
  assert.equal(item.review, "auto");
  assert.equal(item.evidence.method, "manual");
  assert.equal(item.seenIn[0].scope, "manual");

  let raw = applyResult(null, manualUpsertResult(null, item), { mode: "sync" });
  let res = recompute({ raws: { manual: raw }, prevItems: {}, links: {}, uidMap: {}, userState: {}, now: NOW });
  assert.ok(res.items["manual:q1"], "manual item merges into the view");
  assert.equal(res.items["manual:q1"].title, "Quiz");

  // Upsert with the same id replaces, not duplicates.
  const edited = { ...item, title: "Quiz (edited)" };
  raw = applyResult(raw, manualUpsertResult(raw, edited), { mode: "sync" });
  res = recompute({ raws: { manual: raw }, prevItems: res.items, links: res.links, uidMap: res.uidMap, userState: {}, now: NOW });
  assert.equal(Object.keys(res.items).length, 1);
  assert.equal(res.items["manual:q1"].title, "Quiz (edited)");

  raw = applyResult(raw, manualDeleteResult(raw, "manual:q1"), { mode: "sync" });
  res = recompute({ raws: { manual: raw }, prevItems: res.items, links: res.links, uidMap: res.uidMap, userState: {}, now: NOW });
  assert.equal(res.items["manual:q1"], undefined);
});
