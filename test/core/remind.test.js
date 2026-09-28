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

test("leads produce <id>:<lead>:<anchor> keys, soonest first", () => {
  const A = Date.parse("2026-10-05T03:59:00Z");
  const items = { a: item("a", { dueAt: "2026-10-05T03:59:00Z" }) };
  const r = nextReminders(items, {}, SETTINGS(), NOW);
  // deadline leads [1440, 120]: the longer lead fires first.
  assert.deepEqual(
    r.map((x) => x.key),
    [`a:1440:${A}`, `a:120:${A}`]
  );
  assert.equal(r[0].itemId, "a");
  assert.equal(r[0].fireAt, A - 1440 * 60000);
  assert.equal(r[1].fireAt, A - 120 * 60000);
});

test("a moved date is a new key and fires again", () => {
  const A1 = Date.parse("2026-10-05T03:59:00Z");
  const A2 = Date.parse("2026-10-07T03:59:00Z");
  // The 1440-min reminder for the old date already went out.
  const sent = { [`a:1440:${A1}`]: NOW.toISOString() };
  const before = nextReminders({ a: item("a", { dueAt: "2026-10-05T03:59:00Z" }) }, {}, SETTINGS(), NOW, sent);
  assert.ok(!before.some((x) => x.lead === 1440), "old key is suppressed by sent");
  const moved = nextReminders({ a: item("a", { dueAt: "2026-10-07T03:59:00Z" }) }, {}, SETTINGS(), NOW, sent);
  assert.ok(
    moved.some((x) => x.key === `a:1440:${A2}`),
    "the moved date earns a fresh reminder"
  );
});

test("timed events anchor on startAt, deadlines on dueAt", () => {
  const S = Date.parse("2026-10-04T19:00:00Z");
  const items = {
    exam: item("exam", { type: "exam", startAt: "2026-10-04T19:00:00Z", dueAt: "2026-10-09T00:00:00Z" }),
  };
  const r = nextReminders(items, {}, SETTINGS(), NOW);
  // exam leads [4320,1440] both land in the future measured from startAt:
  // 4320 -> Oct 1 19:00, 1440 -> Oct 3 19:00 (the dueAt is ignored).
  assert.deepEqual(
    r.map((x) => x.key),
    [`exam:4320:${S}`, `exam:1440:${S}`]
  );
  assert.equal(r[0].fireAt, S - 4320 * 60000);
});

test("sent keys are skipped; snoozed keys refire at the snooze end", () => {
  const A = Date.parse("2026-10-05T03:59:00Z");
  const items = { a: item("a", { dueAt: "2026-10-05T03:59:00Z" }) };
  const sent = { [`a:1440:${A}`]: NOW.toISOString() };
  const r = nextReminders(items, {}, SETTINGS(), NOW, sent);
  assert.deepEqual(
    r.map((x) => x.key),
    [`a:120:${A}`]
  );

  // Snoozed to a later time: fireAt becomes the snooze end.
  const A2 = Date.parse("2026-10-01T20:30:00Z");
  const items2 = { b: item("b", { dueAt: "2026-10-01T20:30:00Z" }) };
  const snoozed = { [`b:120:${A2}`]: "2026-10-01T20:00:00Z" };
  const r2 = nextReminders(items2, {}, SETTINGS(), NOW, {}, snoozed);
  const s = r2.find((x) => x.key === `b:120:${A2}`);
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

test("items of archived projects get no reminders", () => {
  const items = {
    a: item("a", { dueAt: "2026-10-05T03:59:00Z", meta: { projectId: "p1" } }),
    b: item("b", { dueAt: "2026-10-05T03:59:00Z", meta: { projectId: "p2" } }),
    c: item("c", { dueAt: "2026-10-05T03:59:00Z" }),
  };
  const projects = [
    { id: "p1", status: "archived" },
    { id: "p2", status: "active" },
  ];
  const r = nextReminders(items, {}, SETTINGS(), NOW, {}, {}, projects);
  assert.deepEqual([...new Set(r.map((x) => x.itemId))].sort(), ["b", "c"]);
});

/* ----------------------------- reminders pause ----------------------------- */

test("pauseEndMs: active pause gives its end; expired/invalid are ignored", async () => {
  const { pauseEndMs, pauseUntilTomorrow } = await import(
    "../../extension/src/core/pause.js"
  );
  const now = Date.parse("2026-10-01T16:00:00Z");
  assert.equal(
    pauseEndMs({ pausedUntil: "2026-10-01T17:00:00Z" }, now),
    Date.parse("2026-10-01T17:00:00Z")
  );
  assert.equal(pauseEndMs({ pausedUntil: "2026-10-01T15:00:00Z" }, now), null);
  assert.equal(pauseEndMs({ pausedUntil: "not a date" }, now), null);
  assert.equal(pauseEndMs({ pausedUntil: null }, now), null);
  assert.equal(pauseEndMs({}, now), null);

  // "Pause until tomorrow" = next day 08:00 Toronto, DST-safe.
  assert.equal(pauseUntilTomorrow(now), "2026-10-02T12:00:00.000Z"); // Oct 2 08:00 EDT
  // Nov 1 2025 noon EDT -> Nov 2 08:00 EST (the day the clocks fall back).
  assert.equal(
    pauseUntilTomorrow(Date.parse("2025-11-01T16:00:00Z")),
    "2025-11-02T13:00:00.000Z"
  );
});

test("reminderHoldEnd: pause and quiet hours — the later end wins", async () => {
  const { reminderHoldEnd } = await import("../../extension/src/core/remind.js");
  // 23:30 Toronto Oct 1 — inside quiet hours (23:00-08:00).
  const late = Date.parse(zonedIso(2026, 10, 1, 23, 30));
  const quietEnd = Date.parse(zonedIso(2026, 10, 2, 8, 0));
  const rem = {
    quietHours: { enabled: true, start: "23:00", end: "08:00" },
    pausedUntil: null,
  };
  assert.equal(reminderHoldEnd(late, rem), quietEnd);
  // Pause beyond the quiet end wins.
  const later = quietEnd + 3600000;
  rem.pausedUntil = new Date(later).toISOString();
  assert.equal(reminderHoldEnd(late, rem), later);
  // A pause inside quiet hours defers to the quiet end.
  rem.pausedUntil = new Date(late + 3600000).toISOString();
  assert.equal(reminderHoldEnd(late, rem), quietEnd);
  // Expired pause + outside quiet hours -> null.
  const noon = Date.parse(zonedIso(2026, 10, 1, 12, 0));
  rem.pausedUntil = "2026-09-30T12:00:00Z";
  assert.equal(reminderHoldEnd(noon, rem), null);
});

test("briefing/digest alarms arm at the first occurrence past the pause", async () => {
  const { rescheduleBriefing, rescheduleDigest, BRIEFING_ALARM, DIGEST_ALARM } =
    await import("../../extension/src/core/remind.js");
  const now = new Date("2026-10-01T16:00:00Z"); // Thu Oct 1 noon EDT

  let bAt = null;
  let dAt = null;
  const alarm = (name, at) => {
    if (name === BRIEFING_ALARM) bAt = at;
    if (name === DIGEST_ALARM) dAt = at;
  };

  // Pause ends Fri Oct 3 08:00 EDT — that morning's briefing still fires.
  await rescheduleBriefing(
    { reminders: { briefing: { enabled: true, time: "08:00" }, pausedUntil: "2026-10-03T12:00:00Z" } },
    { alarm, now }
  );
  assert.equal(bAt, Date.parse(zonedIso(2026, 10, 3, 8, 0)));

  // A longer pause skips Oct 3 and Oct 4 briefings entirely.
  await rescheduleBriefing(
    { reminders: { briefing: { enabled: true, time: "08:00" }, pausedUntil: "2026-10-04T20:00:00Z" } },
    { alarm, now }
  );
  assert.equal(bAt, Date.parse(zonedIso(2026, 10, 5, 8, 0)));

  // Digest (Sun 18:00): next is Oct 4 — a pause past it moves to Oct 11.
  await rescheduleDigest(
    { reminders: { digest: { enabled: true, day: "sun", time: "18:00" }, pausedUntil: "2026-10-05T01:00:00Z" } },
    { alarm, now }
  );
  assert.equal(dAt, Date.parse(zonedIso(2026, 10, 11, 18, 0)));

  // No pause -> next Sunday as usual.
  await rescheduleDigest(
    { reminders: { digest: { enabled: true, day: "sun", time: "18:00" } } },
    { alarm, now }
  );
  assert.equal(dAt, Date.parse(zonedIso(2026, 10, 4, 18, 0)));
});

test("paused reminders defer to the pause end; ones past their event drop", async () => {
  const { fireDueReminders } = await import("../../extension/src/core/remind.js");
  const store = new Map();
  const fired = [];
  globalThis.chrome = /** @type {any} */ ({
    storage: {
      local: {
        get: async (keys) => {
          if (typeof keys === "string") return { [keys]: store.get(keys) };
          const out = /** @type {Record<string, any>} */ ({});
          for (const k of keys) out[k] = store.get(k);
          return out;
        },
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        },
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
    alarms: { create() {}, clear() {} },
    notifications: { create: async (id) => fired.push(id) },
  });
  try {
    const now = Date.now();
    const pauseEnd = new Date(now + 3600000).toISOString();
    store.set("wa1Settings", {
      reminders: {
        enabled: true,
        leads: { deadline: [30, 1560] },
        quietHours: { enabled: false },
        briefing: { enabled: false },
        digest: { enabled: false },
        pausedUntil: pauseEnd,
      },
    });
    store.set("items", {
      // Due now (anchor - 30min lead = now) and over before the pause ends.
      soon: item("soon", {
        source: "portal",
        dueAt: new Date(now + 30 * 60000).toISOString(),
      }),
      // Due now (anchor - 26h lead = now) and outlives the pause -> deferred.
      far: item("far", {
        source: "portal",
        dueAt: new Date(now + 26 * 3600000).toISOString(),
      }),
    });
    await fireDueReminders();
    const snoozed = store.get("reminderSnooze") || {};
    const sent = store.get("remindersSent") || {};
    assert.equal(fired.length, 0, "nothing notified during the pause");
    assert.ok(
      Object.keys(snoozed).some((k) => k.startsWith("far:")),
      "the far reminder is deferred"
    );
    assert.ok(
      Object.values(snoozed).some((until) => until === pauseEnd),
      "deferral lands on the pause end"
    );
    assert.ok(
      Object.keys(sent).some((k) => k.startsWith("soon:")),
      "the reminder whose event passed inside the pause is dropped"
    );
  } finally {
    delete /** @type {any} */ (globalThis).chrome;
  }
});
