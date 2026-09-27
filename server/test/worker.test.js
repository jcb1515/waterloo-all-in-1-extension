import test from "node:test";
import assert from "node:assert/strict";
import worker, { applyPublish, buildCalendar, feedGroupOf, serializeState } from "../src/worker.js";
import { fakeD1 } from "./fake-d1.js";

const T1 = new Date("2026-09-01T12:00:00Z");
const T2 = new Date("2026-09-02T12:00:00Z");
const T3 = new Date("2026-09-03T12:00:00Z");

const ev = (over = {}) => ({
  id: "learn:a1",
  type: "deadline",
  title: "Quiz #3",
  dueAt: "2026-09-14T20:00:00.000Z",
  ...over
});

const payload = (events, extra = {}) => ({ version: 2, events, ...extra });

const icsTime = (date) =>
  date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

const icsLines = (ics) => ics.replace(/\r\n /g, "").split("\r\n");

const vevents = (ics) => {
  const blocks = [];
  let current = null;
  for (const line of icsLines(ics)) {
    if (line === "BEGIN:VEVENT") current = [];
    if (current) current.push(line);
    if (line === "END:VEVENT") {
      blocks.push(current);
      current = null;
    }
  }
  return blocks;
};

const blockFor = (ics, uid) =>
  vevents(ics).find((block) => block.includes(`UID:${uid}`));
const prop = (block, name) => block.find((line) => line.startsWith(name));

const call = (request, db, ctx) =>
  worker.fetch(request, { DB: db }, ctx ?? { pending: [], waitUntil(p) { this.pending.push(p); } });

const req = (method, path, body, token) =>
  new Request(`https://feed.test${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body)
  });

// --- SEQUENCE / UID stability ---------------------------------------------

test("republishing the same payload produces byte-identical ICS", () => {
  const p = payload([
    ev(),
    ev({ id: "learn:b2", type: "exam", title: "Midterm", dueAt: undefined,
      startAt: "2026-12-10T14:00:00Z", endAt: "2026-12-10T16:30:00Z" })
  ]);
  const { state: s1, accepted } = applyPublish(null, p, T1);
  assert.equal(accepted, 2);
  const { state: s2 } = applyPublish(s1, p, T2);
  assert.equal(buildCalendar(s1), buildCalendar(s2));
});

test("moved dueAt keeps the UID, bumps SEQUENCE and refreshes LAST-MODIFIED", () => {
  const { state: s1 } = applyPublish(null, payload([ev()]), T1);
  const { state: s2 } = applyPublish(
    s1,
    payload([ev({ dueAt: "2026-09-15T20:00:00.000Z" })]),
    T2
  );
  const block = blockFor(buildCalendar(s2), "learn:a1@waterloo-all-in-1");
  assert.equal(prop(block, "SEQUENCE:"), "SEQUENCE:1");
  assert.equal(prop(block, "DTSTAMP:"), `DTSTAMP:${icsTime(T2)}`);
  assert.equal(prop(block, "LAST-MODIFIED:"), `LAST-MODIFIED:${icsTime(T2)}`);
  assert.equal(prop(block, "DTSTART:"), "DTSTART:20260915T200000Z");
});

test("a removed item's UID leaves the feed and returns with a higher SEQUENCE", () => {
  const A = ev({ id: "learn:a" });
  const B = ev({ id: "learn:b", title: "Essay" });
  const { state: s1 } = applyPublish(null, payload([A, B]), T1);
  const { state: s2 } = applyPublish(s1, payload([A]), T2);
  assert.ok(!buildCalendar(s2).includes("UID:learn:b@"));
  assert.ok(s2.tombstones["learn:b@waterloo-all-in-1"]);
  const { state: s3 } = applyPublish(s2, payload([A, B]), T3);
  const block = blockFor(buildCalendar(s3), "learn:b@waterloo-all-in-1");
  assert.equal(prop(block, "SEQUENCE:"), "SEQUENCE:1");
  assert.ok(s3.seqs["learn:b@waterloo-all-in-1"].seq > s1.seqs["learn:b@waterloo-all-in-1"].seq);
});

// --- group feeds -----------------------------------------------------------

test("feedGroupOf resolves explicit feedGroup, then source, then type", () => {
  assert.equal(feedGroupOf({ type: "meeting", feedGroup: "deadlines" }), "deadlines");
  assert.equal(feedGroupOf({ type: "meeting", feedGroup: "bogus" }), "other");
  assert.equal(feedGroupOf({ type: "meeting", source: "waterlooworks" }), "coop");
  assert.equal(feedGroupOf({ type: "meeting", source: "discord" }), "teams");
  assert.equal(feedGroupOf({ type: "tutorial" }), "classes");
  assert.equal(feedGroupOf({ type: "offer-deadline" }), "coop");
  assert.equal(feedGroupOf({ type: "term-date" }), "other");
});

test("group feeds contain only their events, with the same UIDs", () => {
  const events = [
    ev({ id: "cls", type: "class", title: "Lecture", dueAt: undefined,
      startAt: "2026-10-01T14:30:00Z", endAt: "2026-10-01T15:50:00Z" }),
    ev({ id: "tut", type: "tutorial", title: "Tutorial", dueAt: undefined,
      startAt: "2026-10-02T14:30:00Z" }),
    ev({ id: "quiz", type: "quiz", title: "Quiz" }),
    ev({ id: "ww", type: "meeting", title: "Interview prep", source: "waterlooworks",
      dueAt: undefined, startAt: "2026-10-03T14:30:00Z" }),
    ev({ id: "dm", type: "event", title: "Hack night", source: "discord",
      dueAt: undefined, startAt: "2026-10-04T14:30:00Z" }),
    ev({ id: "x", type: "meeting", title: "Pinned elsewhere", feedGroup: "teams",
      dueAt: undefined, startAt: "2026-10-05T14:30:00Z" })
  ];
  const { state } = applyPublish(null, payload(events), T1);
  const all = buildCalendar(state);
  const classes = buildCalendar(state, { group: "classes" });
  const coop = buildCalendar(state, { group: "coop" });
  const teams = buildCalendar(state, { group: "teams" });
  for (const uid of ["cls", "tut"]) {
    assert.ok(blockFor(all, `${uid}@waterloo-all-in-1`));
    assert.ok(blockFor(classes, `${uid}@waterloo-all-in-1`));
  }
  for (const uid of ["quiz", "ww", "dm", "x"]) {
    assert.ok(!classes.includes(`UID:${uid}@`));
  }
  assert.ok(blockFor(coop, "ww@waterloo-all-in-1"));
  assert.ok(blockFor(teams, "dm@waterloo-all-in-1"));
  assert.ok(blockFor(teams, "x@waterloo-all-in-1"));
  assert.match(classes, /X-WR-CALNAME:Waterloo All-in-1 · Classes/);
});

// --- timing ----------------------------------------------------------------

test("all-day events use VALUE=DATE with an exclusive DTEND", () => {
  const events = [
    // Oct 6 02:00Z is still Oct 5 in America/Toronto.
    ev({ id: "tz", allDay: true, title: "TZ", dueAt: undefined,
      startAt: "2026-10-06T02:00:00Z" }),
    ev({ id: "lit", allDay: true, title: "Literal", dueAt: "2026-10-05" }),
    ev({ id: "rng", allDay: true, title: "Range", dueAt: undefined,
      startAt: "2026-10-05", endAt: "2026-10-08" })
  ];
  const { state } = applyPublish(null, payload(events), T1);
  const ics = buildCalendar(state);
  assert.deepEqual(
    icsLines(ics).filter((l) => l.startsWith("DTSTART") || l.startsWith("DTEND")),
    [
      "DTSTART;VALUE=DATE:20261005",
      "DTEND;VALUE=DATE:20261006",
      "DTSTART;VALUE=DATE:20261005",
      "DTEND;VALUE=DATE:20261006",
      "DTSTART;VALUE=DATE:20261005",
      "DTEND;VALUE=DATE:20261009"
    ]
  );
});

test("timed events: due-only has no DTEND, start-only gets +60m, start+end respected", () => {
  const events = [
    ev({ id: "due", title: "Due only" }),
    ev({ id: "start", title: "Start only", dueAt: undefined,
      startAt: "2026-10-06T14:00:00Z" }),
    ev({ id: "span", title: "Span", dueAt: undefined,
      startAt: "2026-10-06T14:00:00Z", endAt: "2026-10-06T16:00:00Z" }),
    ev({ id: "backwards", title: "Backwards", dueAt: undefined,
      startAt: "2026-10-06T14:00:00Z", endAt: "2026-10-06T13:00:00Z" })
  ];
  const ics = buildCalendar(applyPublish(null, payload(events), T1).state);
  const due = blockFor(ics, "due@waterloo-all-in-1");
  assert.equal(prop(due, "DTSTART:"), "DTSTART:20260914T200000Z");
  assert.ok(!prop(due, "DTEND:"));
  const start = blockFor(ics, "start@waterloo-all-in-1");
  assert.equal(prop(start, "DTEND:"), "DTEND:20261006T150000Z");
  const span = blockFor(ics, "span@waterloo-all-in-1");
  assert.equal(prop(span, "DTEND:"), "DTEND:20261006T160000Z");
  const backwards = blockFor(ics, "backwards@waterloo-all-in-1");
  assert.equal(prop(backwards, "DTEND:"), "DTEND:20261006T150000Z");
});

// --- alarms -----------------------------------------------------------------

test("no VALARMs by default; type alarms map applies per event type", () => {
  const plain = buildCalendar(applyPublish(null, payload([ev()]), T1).state);
  assert.ok(!plain.includes("VALARM"));
  const { state } = applyPublish(
    null,
    payload([ev(), ev({ id: "cls", type: "class", dueAt: undefined, startAt: "2026-10-06T14:00:00Z" })],
      { alarms: { deadline: [30, 1440] } }),
    T1
  );
  const ics = buildCalendar(state);
  const deadline = blockFor(ics, "learn:a1@waterloo-all-in-1");
  assert.ok(deadline.includes("TRIGGER:-PT30M"));
  assert.ok(deadline.includes("TRIGGER:-PT1440M"));
  assert.equal(deadline.filter((l) => l.startsWith("TRIGGER")).length, 2);
  const cls = blockFor(ics, "cls@waterloo-all-in-1");
  assert.ok(!cls.some((l) => l.startsWith("TRIGGER")));
});

test("per-event alarms override the type list, even when empty", () => {
  const { state } = applyPublish(
    null,
    payload([
      ev({ alarms: [10] }),
      ev({ id: "off", alarms: [] })
    ], { alarms: { deadline: [30] } }),
    T1
  );
  const ics = buildCalendar(state);
  const overridden = blockFor(ics, "learn:a1@waterloo-all-in-1");
  assert.ok(overridden.includes("TRIGGER:-PT10M"));
  assert.ok(!overridden.includes("TRIGGER:-PT30M"));
  const off = blockFor(ics, "off@waterloo-all-in-1");
  assert.ok(!off.some((l) => l.startsWith("TRIGGER")));
});

test("invalid alarm minutes are dropped and lists cap at three", () => {
  const { state } = applyPublish(
    null,
    payload([ev({ alarms: [-5, 99999, 1.5, "x", 30, 10, 15, 20] })]),
    T1
  );
  const block = blockFor(buildCalendar(state), "learn:a1@waterloo-all-in-1");
  assert.deepEqual(
    block.filter((l) => l.startsWith("TRIGGER")),
    ["TRIGGER:-PT30M", "TRIGGER:-PT10M", "TRIGGER:-PT15M"]
  );
});

// --- summary / status / description -----------------------------------------

test("SUMMARY gets org prefix, status prefixes and STATUS value", () => {
  const events = [
    ev({ org: "ECE 105" }),
    ev({ id: "a2", title: "ece 105 quiz #3", org: "ECE 105" }),
    ev({ id: "a3", status: "submitted", org: "ECE 105" }),
    ev({ id: "a4", status: "cancelled", confidence: "tentative" })
  ];
  const ics = buildCalendar(applyPublish(null, payload(events), T1).state);
  assert.equal(prop(blockFor(ics, "learn:a1@waterloo-all-in-1"), "SUMMARY:"), "SUMMARY:ECE 105 · Quiz #3");
  assert.equal(prop(blockFor(ics, "a2@waterloo-all-in-1"), "SUMMARY:"), "SUMMARY:ece 105 quiz #3");
  assert.equal(prop(blockFor(ics, "a3@waterloo-all-in-1"), "SUMMARY:"), "SUMMARY:✓ ECE 105 · Quiz #3");
  const cancelled = blockFor(ics, "a4@waterloo-all-in-1");
  assert.equal(prop(cancelled, "SUMMARY:"), "SUMMARY:Cancelled: Quiz #3");
  assert.equal(prop(cancelled, "STATUS:"), "STATUS:CANCELLED");
  assert.equal(prop(blockFor(ics, "learn:a1@waterloo-all-in-1"), "STATUS:"), "STATUS:CONFIRMED");
});

test("DESCRIPTION carries details, weight, section, status, sources and link", () => {
  const { state } = applyPublish(null, payload([
    ev({
      id: "rich", title: "Midterm", type: "exam", org: "ECE 105", source: "learn",
      details: "Covers weeks 1-6", weight: 15, section: "LEC 002",
      location: "MC 4020", status: "submitted", confidence: "tentative",
      url: "https://learn.uwaterloo.ca/d2l/x",
      seenIn: [{ source: "learn" }, { source: "outline" }, { source: "outline" }]
    })
  ]), T1);
  const block = blockFor(buildCalendar(state), "rich@waterloo-all-in-1");
  const description = prop(block, "DESCRIPTION:");
  assert.ok(description.includes("Covers weeks 1-6"));
  assert.ok(description.includes("Weight: 15%"));
  assert.ok(description.includes("Section: LEC 002"));
  assert.ok(description.includes("Location: MC 4020"));
  assert.ok(description.includes("Status: Submitted"));
  assert.ok(description.includes("Date is tentative"));
  assert.ok(description.includes("Sources: Learn\\, Course outline"));
  assert.ok(description.includes("Open: https://learn.uwaterloo.ca/d2l/x"));
  assert.ok(block.includes("LOCATION:MC 4020"));
  assert.ok(block.includes("URL:https://learn.uwaterloo.ca/d2l/x"));
  assert.ok(block.includes("CATEGORIES:Exam"));
});

// --- validation --------------------------------------------------------------

test("invalid events are skipped with reasons", () => {
  const { accepted, skipped, state } = applyPublish(null, payload([
    { type: "deadline", title: "No id", dueAt: "2026-09-14T20:00:00Z" },
    { id: "badtype", type: "bogus", title: "x", dueAt: "2026-09-14T20:00:00Z" },
    { id: "notitle", type: "deadline", dueAt: "2026-09-14T20:00:00Z" },
    { id: "nodate", type: "deadline", title: "x" },
    { id: "baddate", type: "deadline", title: "x", dueAt: "not a date" },
    "not an object",
    ev({ id: "dup" }),
    ev({ id: "dup", title: "Duplicate" })
  ]), T1);
  assert.equal(accepted, 1);
  assert.deepEqual(
    skipped.map((s) => [s.id, s.reason]),
    [
      [null, "missing id"],
      ["badtype", "bad type"],
      ["notitle", "missing title"],
      ["nodate", "no valid date"],
      ["baddate", "no valid date"],
      [null, "missing id"],
      ["dup", "duplicate uid"]
    ]
  );
  assert.equal(state.events.length, 1);
});

test("events that share a calendar.uid are deduplicated", () => {
  const { accepted, skipped } = applyPublish(null, payload([
    ev({ id: "one", calendar: { uid: "shared@x" } }),
    ev({ id: "two", title: "Second", calendar: { uid: "shared@x" } })
  ]), T1);
  assert.equal(accepted, 1);
  assert.deepEqual(skipped, [{ id: "two", reason: "duplicate uid" }]);
});

test("empty events publish an empty calendar", () => {
  const { state, accepted, skipped } = applyPublish(null, payload([]), T1);
  assert.equal(accepted, 0);
  assert.deepEqual(skipped, []);
  const ics = buildCalendar(state);
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.ok(!ics.includes("BEGIN:VEVENT"));
});

test("non-https urls are dropped", () => {
  const { state } = applyPublish(null, payload([
    ev({ id: "http", url: "http://learn.uwaterloo.ca/x" }),
    ev({ id: "bad", url: "not a url" }),
    ev({ id: "ok", url: "https://outline.uwaterloo.ca/x" })
  ]), T1);
  const ics = buildCalendar(state);
  assert.ok(!blockFor(ics, "http@waterloo-all-in-1").some((l) => l.startsWith("URL:")));
  assert.ok(!blockFor(ics, "bad@waterloo-all-in-1").some((l) => l.startsWith("URL:")));
  assert.ok(prop(blockFor(ics, "ok@waterloo-all-in-1"), "URL:").includes("outline.uwaterloo.ca"));
});

test("calendar fields are clamped to their limits", () => {
  const { state } = applyPublish(null, {
    calendarName: "x".repeat(150),
    events: [ev({ title: "t".repeat(600), org: "o".repeat(150) })]
  }, T1);
  const ics = buildCalendar(state);
  assert.equal(state.calendarName.length, 100);
  assert.equal(state.events[0].title.length, 500);
  assert.equal(state.events[0].org.length, 100);
  assert.ok(icsLines(ics).includes(`X-WR-CALNAME:${"x".repeat(100)}`));
});

test("text is escaped and lines fold at 75 octets", () => {
  const { state } = applyPublish(null, payload([
    ev({ title: 'Part 1, "B"; C\\D', details: "line1\nline2", location: "RCH 101, second floor" }),
    ev({ id: "long", title: "T".repeat(200) })
  ]), T1);
  const ics = buildCalendar(state);
  const block = blockFor(ics, "learn:a1@waterloo-all-in-1");
  assert.equal(prop(block, "SUMMARY:"), 'SUMMARY:Part 1\\, "B"\\; C\\\\D');
  assert.ok(prop(block, "DESCRIPTION:").includes("line1\\nline2"));
  assert.equal(prop(block, "LOCATION:"), "LOCATION:RCH 101\\, second floor");
  const encoder = new TextEncoder();
  for (const line of ics.split("\r\n")) {
    assert.ok(encoder.encode(line).length <= 75, `line too long: ${line.slice(0, 40)}`);
  }
  assert.ok(blockFor(ics, "long@waterloo-all-in-1").join("\r\n").includes("T".repeat(200)));
});

// --- uid / client sequence ----------------------------------------------------

test("calendar.uid wins, bare ids get the default domain, client seq is a floor", () => {
  const events = [
    ev({ id: "a", calendar: { uid: "custom@example.com" } }),
    ev({ id: "b", calendar: { uid: "plain-uid" } }),
    ev({ id: "c", calendar: { seq: 7 } })
  ];
  const { state: s1 } = applyPublish(null, payload(events), T1);
  const ics = buildCalendar(s1);
  assert.ok(blockFor(ics, "custom@example.com"));
  assert.ok(blockFor(ics, "plain-uid@waterloo-all-in-1"));
  assert.equal(prop(blockFor(ics, "c@waterloo-all-in-1"), "SEQUENCE:"), "SEQUENCE:7");

  // Same content republished with a lower client seq keeps the higher stored seq.
  const { state: s2 } = applyPublish(s1, payload([
    ev({ id: "a", calendar: { uid: "custom@example.com" } }),
    ev({ id: "b", calendar: { uid: "plain-uid" } }),
    ev({ id: "c", calendar: { seq: 3 } })
  ]), T2);
  assert.equal(prop(blockFor(buildCalendar(s2), "c@waterloo-all-in-1"), "SEQUENCE:"), "SEQUENCE:7");

  // Changed content: seq = max(stored + 1, clientSeq).
  const { state: s3 } = applyPublish(s2, payload([
    ev({ id: "a", calendar: { uid: "custom@example.com" } }),
    ev({ id: "b", calendar: { uid: "plain-uid" } }),
    ev({ id: "c", title: "Changed", calendar: { seq: 2 } })
  ]), T3);
  assert.equal(prop(blockFor(buildCalendar(s3), "c@waterloo-all-in-1"), "SEQUENCE:"), "SEQUENCE:8");
});

// --- state size / timezone hash / date-only ---------------------------------

test("serializeState flags states too large for a D1 row", () => {
  const small = serializeState({ version: 2, events: [], seqs: {}, tombstones: {} });
  assert.equal(small.ok, true);
  const huge = serializeState({
    version: 2,
    events: [ev({ details: "x".repeat(2_000_000) })],
    seqs: {},
    tombstones: {}
  });
  assert.equal(huge.ok, false);
  assert.ok(huge.bytes > 1_900_000);
});

test("publishing a state larger than the D1 row limit returns 413", async () => {
  const db = fakeD1();
  // ~1.7 MB payload: under the 2 MiB body cap, but the stored state (events +
  // uid + seqs bookkeeping) exceeds the D1 row limit.
  const events = Array.from({ length: 3000 }, (_, i) =>
    ev({ id: `big:${i}`, title: `T${i}` + "x".repeat(490) }));
  const res = await call(req("POST", "/v1/calendars", payload(events)), db);
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: "Calendar feed is too large to store." });
  assert.equal(db.feeds.size, 0);
});

test("republishing with a different timeZone bumps SEQUENCE but keeps UIDs", () => {
  const { state: s1 } = applyPublish(null, payload([
    ev({ id: "day", title: "All day", allDay: true, dueAt: "2026-10-06T02:00:00Z" })
  ]), T1);
  const { state: s2 } = applyPublish(s1, payload([
    ev({ id: "day", title: "All day", allDay: true, dueAt: "2026-10-06T02:00:00Z" })
  ], { timeZone: "Pacific/Auckland" }), T2);
  const ics2 = buildCalendar(s2);
  const block = blockFor(ics2, "day@waterloo-all-in-1");
  assert.equal(prop(block, "SEQUENCE:"), "SEQUENCE:1");
  // Auckland is UTC+13, so Oct 6 02:00Z is still Oct 6 there but Oct 5 in Toronto.
  assert.equal(prop(block, "DTSTART;VALUE=DATE:"), "DTSTART;VALUE=DATE:20261006");
});

test("date-only startAt or dueAt implies an all-day event", () => {
  const { state } = applyPublish(null, payload([
    ev({ id: "d1", dueAt: "2026-10-05" }),
    ev({ id: "d2", title: "Start only", dueAt: undefined, startAt: "2026-10-05" }),
    ev({ id: "d3", title: "Timed", dueAt: undefined,
      startAt: "2026-10-05T14:00:00Z", endAt: "2026-10-05" })
  ]), T1);
  const ics = buildCalendar(state);
  assert.equal(prop(blockFor(ics, "d1@waterloo-all-in-1"), "DTSTART"), "DTSTART;VALUE=DATE:20261005");
  assert.equal(prop(blockFor(ics, "d2@waterloo-all-in-1"), "DTSTART"), "DTSTART;VALUE=DATE:20261005");
  // Timed startAt stays timed even when endAt is date-only.
  assert.equal(prop(blockFor(ics, "d3@waterloo-all-in-1"), "DTSTART"), "DTSTART:20261005T140000Z");
});

test("slim tombstones keep only seq and removedAt; fat ones still resurrect", () => {
  const { state: s1 } = applyPublish(null, payload([ev({ id: "a" }), ev({ id: "b", title: "B" })]), T1);
  const { state: s2 } = applyPublish(s1, payload([ev({ id: "a" })]), T2);
  assert.deepEqual(Object.keys(s2.tombstones["b@waterloo-all-in-1"]).sort(), ["removedAt", "seq"]);
  // A legacy fat tombstone {hash, seq, at, removedAt} still bumps on return.
  s2.tombstones["b@waterloo-all-in-1"] = { hash: "h", seq: 4, at: icsIso(T1), removedAt: icsIso(T2) };
  const { state: s3 } = applyPublish(s2, payload([ev({ id: "a" }), ev({ id: "b", title: "B" })]), T3);
  assert.equal(s3.seqs["b@waterloo-all-in-1"].seq, 5);
});

const icsIso = (d) => d.toISOString();

// --- legacy v1 ------------------------------------------------------------

test("legacy assignments payload keeps the published learn.uwaterloo.ca UIDs", async () => {
  const db = fakeD1();
  const res = await call(req("POST", "/v1/calendars", {
    assignments: [{
      id: "42", courseId: "1001", name: "Final report", courseName: "TEST 101",
      dueDate: "2026-09-14T20:00:00.000Z", url: "https://learn.uwaterloo.ca/d2l/example"
    }]
  }), db);
  assert.equal(res.status, 201);
  const { feedUrl } = await res.json();
  const ics = await (await call(new Request(feedUrl), db)).text();
  assert.ok(ics.includes("UID:1001-42@learn.uwaterloo.ca"));
  assert.ok(ics.includes("SUMMARY:TEST 101 · Final report"));
  assert.ok(ics.includes("DTSTART:20260914T200000Z"));
});

test("a stored v1 array row still renders", async () => {
  const db = fakeD1();
  const feedId = "a".repeat(24);
  db.feeds.set(feedId, {
    update_token_hash: "x",
    calendar_json: JSON.stringify([{
      id: "42", courseId: "1001", name: "Final report", courseName: "TEST 101",
      dueDate: "2026-09-14T20:00:00.000Z", url: "https://learn.uwaterloo.ca/d2l/example"
    }]),
    expires_at: Date.now() + 60_000,
    updated_at: Date.parse("2026-09-01T12:00:00Z")
  });
  const res = await call(req("GET", `/v1/calendars/${feedId}.ics`), db);
  assert.equal(res.status, 200);
  const ics = await res.text();
  assert.ok(ics.includes("UID:1001-42@learn.uwaterloo.ca"));
});

// --- routes over fake D1 -----------------------------------------------------

test("feed lifecycle: POST, GET, group alias GET, PUT auth + seq bump, DELETE", async () => {
  const db = fakeD1();
  const ctx = { pending: [], waitUntil(p) { this.pending.push(p); } };

  const created = await call(req("POST", "/v1/calendars", payload([
    ev({ id: "quiz", type: "quiz", title: "Quiz", org: "ECE 105" }),
    ev({ id: "lec", type: "class", title: "Lecture", dueAt: undefined,
      startAt: "2026-10-01T14:30:00Z" })
  ])), db, ctx);
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.ok(body.feedId && body.updateToken && body.feedUrl && body.expiresAt);
  assert.equal(body.accepted, 2);
  assert.deepEqual(body.skipped, []);
  assert.deepEqual(
    Object.keys(body.groupFeeds).sort(),
    ["classes", "coop", "deadlines", "other", "teams"]
  );
  for (const group of Object.values(body.groupFeeds)) {
    assert.ok(group.feedId && group.feedUrl.endsWith(".ics"));
  }

  const feedPath = new URL(body.feedUrl).pathname;
  const main = await call(req("GET", feedPath), db, ctx);
  assert.equal(main.status, 200);
  assert.equal(main.headers.get("content-type"), "text/calendar; charset=utf-8");
  assert.equal(
    main.headers.get("content-disposition"),
    "inline; filename=waterloo-all-in-1.ics"
  );
  const ics = await main.text();
  assert.ok(ics.includes("UID:quiz@waterloo-all-in-1"));
  assert.ok(ics.includes("UID:lec@waterloo-all-in-1"));

  const classesPath = new URL(body.groupFeeds.classes.feedUrl).pathname;
  const classesRes = await call(req("GET", classesPath), db, ctx);
  const classesIcs = await classesRes.text();
  assert.ok(classesIcs.includes("UID:lec@waterloo-all-in-1"));
  assert.ok(!classesIcs.includes("UID:quiz@"));

  const badPut = await call(req("PUT", feedPath, payload([ev()]), "wrong-token"), db, ctx);
  assert.equal(badPut.status, 401);

  const put = await call(req("PUT", feedPath, payload([
    ev({ id: "quiz", type: "quiz", title: "Quiz", org: "ECE 105",
      dueAt: "2026-09-16T20:00:00.000Z" })
  ]), body.updateToken), db, ctx);
  assert.equal(put.status, 200);
  const putBody = await put.json();
  assert.ok(!("updateToken" in putBody));
  assert.equal(Object.keys(putBody.groupFeeds).length, 5);

  const updated = await (await call(req("GET", feedPath), db, ctx)).text();
  assert.equal(
    prop(blockFor(updated, "quiz@waterloo-all-in-1"), "SEQUENCE:"),
    "SEQUENCE:1"
  );
  assert.ok(!updated.includes("UID:lec@")); // removed -> tombstone

  const aliasId = body.groupFeeds.classes.feedId;
  assert.equal((await call(req("PUT", `/v1/calendars/${aliasId}.ics`, payload([]), body.updateToken), db, ctx)).status, 404);
  assert.equal((await call(req("DELETE", `/v1/calendars/${aliasId}.ics`, undefined, body.updateToken), db, ctx)).status, 404);

  const health = await call(req("GET", "/health"), db, ctx);
  assert.deepEqual(await health.json(), { ok: true, feeds: 1 });

  assert.equal((await call(req("DELETE", feedPath, undefined, body.updateToken), db, ctx)).status, 204);
  assert.equal((await call(req("GET", feedPath), db, ctx)).status, 404);
  assert.equal((await call(req("GET", classesPath), db, ctx)).status, 404);
});

test("PUT backfills group aliases for feeds created before the aliases table", async () => {
  const db = fakeD1();
  const created = await call(req("POST", "/v1/calendars", payload([ev()])), db);
  const body = await created.json();
  db.aliases.clear(); // simulate a pre-0002 feed row
  const put = await call(
    req("PUT", new URL(body.feedUrl).pathname, payload([ev()]), body.updateToken),
    db
  );
  assert.equal(put.status, 200);
  const putBody = await put.json();
  assert.equal(Object.keys(putBody.groupFeeds).length, 5);
  assert.equal(db.aliases.size, 5);
});

test("over-limit payloads and malformed bodies get 4xx", async () => {
  const db = fakeD1();
  const many = await call(req("POST", "/v1/calendars", payload(
    Array.from({ length: 3001 }, (_, i) => ev({ id: `e${i}` }))
  )), db);
  assert.equal(many.status, 413);

  const notJson = await call(req("POST", "/v1/calendars", "this is not json"), db);
  assert.equal(notJson.status, 400);

  const notArray = await call(req("POST", "/v1/calendars", { events: "nope" }), db);
  assert.equal(notArray.status, 400);

  const empty = await call(req("POST", "/v1/calendars", payload([])), db);
  assert.equal(empty.status, 201);
  assert.equal((await empty.json()).accepted, 0);
});

test("expired feeds return 410 and are deleted", async () => {
  const db = fakeD1();
  const ctx = { pending: [], waitUntil(p) { this.pending.push(p); } };
  const feedId = "b".repeat(24);
  const aliasId = "c".repeat(24);
  db.feeds.set(feedId, {
    update_token_hash: "x",
    calendar_json: JSON.stringify({ version: 2, events: [], seqs: {}, tombstones: {} }),
    expires_at: Date.now() - 1000,
    updated_at: Date.now() - 2000
  });
  db.aliases.set(aliasId, { feed_id: feedId, feed_group: "classes" });
  const res = await call(req("GET", `/v1/calendars/${feedId}.ics`), db, ctx);
  assert.equal(res.status, 410);
  await Promise.all(ctx.pending);
  assert.ok(!db.feeds.has(feedId));
  assert.ok(!db.aliases.has(aliasId));
});

test("scheduled cleanup removes expired feeds and orphan aliases", async () => {
  const db = fakeD1();
  const ctx = { pending: [], waitUntil(p) { this.pending.push(p); } };
  db.feeds.set("d".repeat(24), {
    update_token_hash: "x", calendar_json: "[]",
    expires_at: Date.now() - 1000, updated_at: Date.now() - 2000
  });
  db.aliases.set("e".repeat(24), { feed_id: "d".repeat(24), feed_group: "classes" });
  db.aliases.set("f".repeat(24), { feed_id: "missing-feed", feed_group: "coop" });
  await worker.scheduled({}, { DB: db }, ctx);
  await Promise.all(ctx.pending);
  assert.equal(db.feeds.size, 0);
  assert.equal(db.aliases.size, 0);
});
