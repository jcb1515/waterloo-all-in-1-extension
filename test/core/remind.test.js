// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import {
  nextReminders,
  quietEndMs,
  briefingText,
  reminderCopy,
} from "../../extension/src/core/remind.js";
import { zonedIso } from "../../extension/src/lib/textdates/index.js";

const NOW = new Date("2026-10-01T16:00:00.000Z"); // Thu Oct 1, 12:00 EDT

const SETTINGS = (over = {}) => ({
  reminders: {
    enabled: true,
    leads: {
      deadline: [1440, 120],
      quiz: [1440, 60],
      exam: [4320, 1440],
      interview: [1440, 60],
      meeting: [30],
      class: [],
    },
    quietHours: { enabled: true, start: "23:00", end: "08:00" },
    briefing: { enabled: true, time: "08:00" },
    includeTentative: false,
    ...over,
  },
});

const item = (id, over = {}) => ({
  id,
  source: "learn",
  type: "deadline",
  title: id,
  status: "open",
  confidence: "exact",
  review: "auto",
  ...over,
});

test("leads produce <id>:<lead> keys, soonest first", () => {
  const items = { a: item("a", { dueAt: "2026-10-05T03:59:00Z" }) };
  const r = nextReminders(items, {}, SETTINGS(), NOW);
  // deadline leads [1440, 120]: the longer lead fires first.
  assert.deepEqual(
    r.map((x) => x.key),
    ["a:1440", "a:120"]
  );
  assert.equal(r[0].itemId, "a");
  assert.equal(r[0].fireAt, Date.parse("2026-10-05T03:59:00Z") - 1440 * 60000);
  assert.equal(r[1].fireAt, Date.parse("2026-10-05T03:59:00Z") - 120 * 60000);
});

test("timed events anchor on startAt, deadlines on dueAt", () => {
  const items = {
    exam: item("exam", { type: "exam", startAt: "2026-10-04T19:00:00Z", dueAt: "2026-10-09T00:00:00Z" }),
  };
  const r = nextReminders(items, {}, SETTINGS(), NOW);
  // exam leads [4320,1440] both land in the future measured from startAt:
  // 4320 -> Oct 1 19:00, 1440 -> Oct 3 19:00 (the dueAt is ignored).
  assert.deepEqual(
    r.map((x) => x.key),
    ["exam:4320", "exam:1440"]
  );
  assert.equal(r[0].fireAt, Date.parse("2026-10-04T19:00:00Z") - 4320 * 60000);
});

test("sent keys are skipped; snoozed keys refire at the snooze end", () => {
  const items = { a: item("a", { dueAt: "2026-10-05T03:59:00Z" }) };
  const sent = { "a:1440": NOW.toISOString() };
  const r = nextReminders(items, {}, SETTINGS(), NOW, sent);
  assert.deepEqual(
    r.map((x) => x.key),
    ["a:120"]
  );

  // Snoozed to a later time: fireAt becomes the snooze end.
  const items2 = { b: item("b", { dueAt: "2026-10-01T20:30:00Z" }) };
  const snoozed = { "b:120": "2026-10-01T20:00:00Z" };
  const r2 = nextReminders(items2, {}, SETTINGS(), NOW, {}, snoozed);
  const s = r2.find((x) => x.key === "b:120");
  assert.equal(s.fireAt, Date.parse("2026-10-01T20:00:00Z"));
});

test("done, submitted, hidden, snoozed-item and past anchors are excluded", () => {
  const items = {
    done: item("done", { dueAt: "2026-10-05T03:59:00Z", status: "done" }),
    sub: item("sub", { dueAt: "2026-10-05T03:59:00Z", status: "submitted" }),
    hidden: item("hidden", { dueAt: "2026-10-05T03:59:00Z" }),
    past: item("past", { dueAt: "2026-09-30T03:59:00Z" }),
    nodate: item("nodate"),
    reviewPending: item("reviewPending", { dueAt: "2026-10-05T03:59:00Z", review: "pending" }),
  };
  const us = { hidden: { hidden: true } };
  assert.equal(nextReminders(items, us, SETTINGS(), NOW).length, 0);
});

test("tentative items need includeTentative", () => {
  const items = { t: item("t", { dueAt: "2026-10-05T03:59:00Z", confidence: "tentative" }) };
  assert.equal(nextReminders(items, {}, SETTINGS(), NOW).length, 0);
  assert.equal(
    nextReminders(items, {}, SETTINGS({ includeTentative: true }), NOW).length,
    2
  );
});

test("types with empty lead lists get nothing; disabled kills all", () => {
  const items = {
    cls: item("cls", { type: "class", startAt: "2026-10-02T14:00:00Z" }),
    dl: item("dl", { dueAt: "2026-10-05T03:59:00Z" }),
  };
  const r = nextReminders(items, {}, SETTINGS(), NOW);
  assert.deepEqual(r.map((x) => x.itemId), ["dl", "dl"]); // both deadline leads
  assert.equal(nextReminders(items, {}, SETTINGS({ enabled: false }), NOW).length, 0);
});

test("user-marked done via userState is excluded", () => {
  const items = { a: item("a", { dueAt: "2026-10-05T03:59:00Z" }) };
  const us = { a: { done: true } };
  assert.equal(nextReminders(items, us, SETTINGS(), NOW).length, 0);
});

test("quiet hours: inside 23:00-08:00 Toronto defers to 08:00", () => {
  const quiet = { enabled: true, start: "23:00", end: "08:00" };
  // 23:30 Toronto on Oct 1 (EDT, UTC-4) -> 03:30 UTC Oct 2.
  const late = Date.parse(zonedIso(2026, 10, 1, 23, 30));
  const end = quietEndMs(late, quiet);
  assert.equal(end, Date.parse(zonedIso(2026, 10, 2, 8, 0)));

  // 03:00 Toronto -> today's 08:00.
  const early = Date.parse(zonedIso(2026, 10, 1, 3, 0));
  assert.equal(quietEndMs(early, quiet), Date.parse(zonedIso(2026, 10, 1, 8, 0)));

  // Noon Toronto -> null.
  const noon = Date.parse(zonedIso(2026, 10, 1, 12, 0));
  assert.equal(quietEndMs(noon, quiet), null);

  // Disabled -> null even inside the window.
  assert.equal(quietEndMs(late, { enabled: false, start: "23:00", end: "08:00" }), null);
});

test("quiet hours survive the spring-forward gap (DST-safe)", () => {
  // March 8 2026: 02:00-03:00 does not exist in Toronto. Quiet end at 07:30
  // must still resolve to a real instant.
  const quiet = { enabled: true, start: "01:00", end: "07:30" };
  const inside = Date.parse(zonedIso(2026, 3, 8, 1, 30));
  const end = quietEndMs(inside, quiet);
  assert.ok(end && end > inside);
  // 07:30 Toronto on Mar 8 is EDT (UTC-4): 11:30 UTC.
  assert.equal(end, Date.parse("2026-03-08T11:30:00Z"));
});

test("briefingText counts today's classes and due items, names the next", () => {
  const items = {
    cls1: item("cls1", { type: "class", startAt: zonedIso(2026, 10, 1, 13, 30), org: "MATH 117", title: "Lecture" }),
    cls2: item("cls2", { type: "class", startAt: zonedIso(2026, 10, 1, 15, 30), org: "ECE 105", title: "Lecture" }),
    dl: item("dl", { dueAt: zonedIso(2026, 10, 1, 23, 59), org: "ECE 105", title: "Quiz #3", type: "quiz" }),
    later: item("later", { dueAt: zonedIso(2026, 10, 5, 23, 59), org: "ECE 190", title: "Deliverable" }),
  };
  const text = briefingText(items, {}, NOW);
  assert.match(text, /^Today: 2 classes · 1 due/);
  assert.match(text, /next: MATH 117 Lecture/);
});

test("briefingText is null on an empty day and mentions clashes", () => {
  assert.equal(briefingText({}, {}, NOW), null);
  const items = {
    a: item("a", { type: "exam", startAt: zonedIso(2026, 10, 1, 19, 0), endAt: zonedIso(2026, 10, 1, 20, 0), title: "Midterm", org: "MATH 117" }),
    b: item("b", { type: "class", startAt: zonedIso(2026, 10, 1, 19, 30), endAt: zonedIso(2026, 10, 1, 20, 30), title: "Review", org: "ECE 105" }),
  };
  const text = briefingText(items, {}, NOW);
  assert.match(text, /1 clash/);
});

test("reminderCopy: org · title, due-in lead, time, location", () => {
  const it = item("x", {
    type: "quiz",
    title: "Quiz #3",
    org: "ECE 105",
    dueAt: "2026-10-01T17:00:00Z", // 1 h after NOW
  });
  const c = reminderCopy(it, NOW.getTime());
  assert.equal(c.title, "ECE 105 · Quiz #3");
  assert.match(c.message, /Due in 1 hour/);

  const timed = item("y", {
    type: "interview",
    title: "Interview",
    org: "Acme",
    startAt: "2026-10-01T17:30:00Z",
    location: "Video call",
  });
  const c2 = reminderCopy(timed, NOW.getTime());
  assert.match(c2.message, /Starts in/);
  assert.match(c2.message, /Video call/);
});
