// @ts-check
// Recurring-meeting suggestions: occurrence grouping + the text rule.
import test from "node:test";
import assert from "node:assert/strict";
import {
  meetingKey,
  textWeeklyHint,
  recurringSuggestions,
} from "../../extension/src/sources/discord/recurring.js";

const NOW_MS = Date.parse("2026-10-30T12:00:00.000Z"); // Friday before fall-back
const NOW_ISO = new Date(NOW_MS).toISOString();

const occ = (startAt, endAt) => ({
  guildId: "1001",
  channelId: "2001",
  key: "design review",
  startAt,
  endAt,
  url: "https://discord.com/channels/1001/2001/x",
  at: NOW_ISO,
});

test("meetingKey strips dates/numbers/stopwords to 4 words", () => {
  assert.equal(meetingKey("Design review at 6pm October 8"), "design review");
  assert.equal(meetingKey("Weekly Sync!"), "sync");
  assert.equal(meetingKey(""), "");
});

test("three weekly occurrences -> one suggestion, DST-crossing stays 18:00 Toronto", () => {
  // Tuesdays 18:00 Toronto: Oct 27 (EDT, 22:00Z), Nov 3 + Nov 10 (EST, 23:00Z)
  const log = [
    occ("2026-10-27T22:00:00.000Z", "2026-10-27T23:00:00.000Z"),
    occ("2026-11-03T23:00:00.000Z", "2026-11-04T00:00:00.000Z"),
    occ("2026-11-10T23:00:00.000Z", "2026-11-11T00:00:00.000Z"),
  ];
  const [s] = recurringSuggestions(log, { nowMs: NOW_MS, nowIso: NOW_ISO });
  assert.equal(s.type, "meeting");
  assert.equal(s.category, "recurring");
  assert.equal(s.title, "Design review (weekly)");
  // Next Tuesday >= Oct 30 is Nov 3 — 18:00 EST = 23:00Z
  assert.equal(s.startAt, "2026-11-03T23:00:00.000Z");
  assert.equal(s.endAt, "2026-11-04T00:00:00.000Z"); // median 60 min
  assert.deepEqual(
    { freq: "WEEKLY", byDay: "TU", time: "18:00", tz: "America/Toronto" },
    {
      freq: s.meta.recurrence.freq,
      byDay: s.meta.recurrence.byDay,
      time: s.meta.recurrence.time,
      tz: s.meta.recurrence.tz,
    }
  );
  assert.equal(s.meta.recurrence.weeks, 3);
  assert.equal(s.id, "discord:recurring:1001:design-review:tue-1800");
});

test("a single occurrence is not enough", () => {
  assert.equal(
    recurringSuggestions([occ("2026-10-27T22:00:00.000Z")], {
      nowMs: NOW_MS,
      nowIso: NOW_ISO,
    }).length,
    0
  );
});

test("textWeeklyHint needs a weekly weekday AND a time", () => {
  assert.deepEqual(textWeeklyHint("electrical sync every tuesday at 6pm"), {
    weekday: 2,
    h: 18,
    mi: 0,
  });
  assert.deepEqual(textWeeklyHint("we meet Thursdays 6:30 PM"), {
    weekday: 4,
    h: 18,
    mi: 30,
  });
  assert.deepEqual(textWeeklyHint("standup every monday 9:00"), {
    weekday: 1,
    h: 9,
    mi: 0,
  });
  assert.equal(textWeeklyHint("every tuesday"), null);
  assert.equal(textWeeklyHint("at 6pm maybe"), null);
});

test("a fromText hint is a suggestion with weeks: 0", () => {
  const log = [
    {
      guildId: "1001",
      channelId: "2001",
      key: "electrical sync",
      url: "https://discord.com/channels/1001/2001/y",
      at: NOW_ISO,
      fromText: true,
      weekday: 2,
      hhmm: "18:00",
    },
  ];
  const [s] = recurringSuggestions(log, { nowMs: NOW_MS, nowIso: NOW_ISO });
  assert.equal(s.meta.recurrence.fromText, true);
  assert.equal(s.meta.recurrence.weeks, 0);
  assert.equal(s.startAt, "2026-11-03T23:00:00.000Z");
});
