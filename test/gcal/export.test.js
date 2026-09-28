// @ts-check
// The fetch-type gcal read: zip.js entry extraction + caps, ics.js
// unfolding/dates/RRULE expansion (DST, ordinals, EXDATE, RECURRENCE-ID),
// calendar filtering, and the adapter.sync export/fallback paths.

import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import adapter from "../../extension/src/sources/gcal/index.js";
import { readZip } from "../../extension/src/sources/gcal/zip.js";
import { parseIcs, tzOf } from "../../extension/src/sources/gcal/ics.js";
import { gcalGate, SETTLE_MS, SETTLE_EMPTY_MS, HEARTBEAT_MS } from "../../extension/src/sources/gcal/dom.js";

const NOW = new Date("2026-10-15T12:00:00.000Z"); // Wed, still EDT until Nov 1
const enc = new TextEncoder();

/* ------------------------------ zip helper ------------------------------ */

/** A minimal spec-valid zip: local headers + data + central dir + EOCD (crc 0 — the reader doesn't verify it). */
function buildZip(entries) {
  /** @type {Uint8Array[]} */
  const chunks = [];
  /** @type {Uint8Array[]} */
  const central = [];
  let off = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const comp = e.method === 8 ? deflateRawSync(Buffer.from(e.data)) : Buffer.from(e.data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(8, e.method, true);
    lh.setUint32(18, comp.length, true);
    lh.setUint32(22, e.data.length, true);
    lh.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(lh.buffer), name, new Uint8Array(comp));
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(10, e.method, true);
    ch.setUint32(20, comp.length, true);
    ch.setUint32(24, e.data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, off, true);
    central.push(new Uint8Array(ch.buffer), name);
    off += 30 + name.length + comp.length;
  }
  const cdStart = off;
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdStart, true);
  const parts = [...chunks, ...central, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(parts.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of parts) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

const ICS_HEAD = "BEGIN:VCALENDAR\r\nPRODID:-//Test//EN\r\nVERSION:2.0\r\nX-WR-CALNAME:Mine\r\n";
const ICS_TAIL = "END:VCALENDAR\r\n";
const icsOf = (body, head = ICS_HEAD) => head + body + ICS_TAIL;

/* --------------------------------- zip ---------------------------------- */

test("zip: stored and deflated entries come back by name", async () => {
  const zip = buildZip([
    { name: "basic.ics", method: 0, data: enc.encode("STORED-TEXT") },
    { name: "other.ics", method: 8, data: enc.encode("DEFLATED ".repeat(100)) },
  ]);
  const out = await readZip(zip);
  assert.equal(out.length, 2);
  const byName = Object.fromEntries(out.map((e) => [e.name, new TextDecoder().decode(e.bytes)]));
  assert.equal(byName["basic.ics"], "STORED-TEXT");
  assert.equal(byName["other.ics"], "DEFLATED ".repeat(100));
});

test("zip: entry-count cap and declared-size cap", async () => {
  const many = buildZip(
    Array.from({ length: 51 }, (_, i) => ({ name: `e${i}.ics`, method: 0, data: enc.encode("x") })),
  );
  await assert.rejects(readZip(many), /too many entries/);
  // An entry whose central directory claims > 20 MB uncompressed is
  // rejected before any decompression.
  const fat = buildZip([{ name: "big.ics", method: 8, data: enc.encode("x") }]);
  const dv = new DataView(fat.buffer);
  for (let p = 0; p + 46 <= fat.length; p++) {
    if (dv.getUint32(p, true) === 0x02014b50) dv.setUint32(p + 24, 21 * 1024 * 1024, true);
  }
  await assert.rejects(readZip(fat), /entry too large/);
  await assert.rejects(readZip(enc.encode("not a zip")), /end record/);
});

/* --------------------------------- ics ---------------------------------- */

const vevent = (body) => `BEGIN:VEVENT\r\n${body}END:VEVENT\r\n`;

test("ics: folding, escapes, calendar name, non-VEVENT blocks ignored", () => {
  const ics = icsOf(
    "X-WR-CALNAME:My long calend\r\n ar name\r\n" +
      vevent(
        "UID:u1\r\nSUMMARY:Hello\\, wor\n ld\\; \\\\next\\nline\r\n" +
          "DTSTART;TZID=America/Toronto:20261020T100000\r\nDTEND;TZID=America/Toronto:20261020T110000\r\n" +
          "DESCRIPTION:secret notes\r\nLOCATION:room\r\nATTENDEE:someone\r\n",
      ) +
      "BEGIN:VTIMEZONE\r\nTZID:X\r\nEND:VTIMEZONE\r\n",
  );
  const cal = parseIcs(ics, { now: NOW });
  assert.equal(cal.name, "My long calendar name");
  assert.equal(cal.wa1, false);
  assert.equal(cal.events.length, 1);
  assert.equal(cal.events[0].title, "Hello, world; \\next line"); // \n unescapes, then collapses to a space
  assert.equal(cal.events[0].startAt, "2026-10-20T14:00:00.000Z");
  assert.equal(cal.events[0].endAt, "2026-10-20T15:00:00.000Z");
});

test("ics: UTC Z, floating Toronto, Windows TZID, all-day, DURATION", () => {
  const ics = icsOf(
    vevent("UID:z\r\nSUMMARY:utc\r\nDTSTART:20261020T150000Z\r\n") +
      vevent("UID:f\r\nSUMMARY:float\r\nDTSTART:20261020T093000\r\n") +
      vevent("UID:w\r\nSUMMARY:win\r\nDTSTART;TZID=Eastern Standard Time:20261020T100000\r\n") +
      vevent("UID:a\r\nSUMMARY:aday\r\nDTSTART;VALUE=DATE:20261123\r\n") +
      vevent("UID:d\r\nSUMMARY:dur\r\nDTSTART;TZID=America/Toronto:20261020T100000\r\nDURATION:PT1H30M\r\n"),
  );
  const cal = parseIcs(ics, { now: NOW });
  const by = (t) => cal.events.find((e) => e.title === t);
  assert.equal(by("utc").startAt, "2026-10-20T15:00:00.000Z");
  assert.equal(by("float").startAt, "2026-10-20T13:30:00.000Z"); // floating -> Toronto (EDT)
  assert.equal(by("win").startAt, "2026-10-20T14:00:00.000Z");
  assert.equal(by("aday").allDay, true);
  assert.equal(by("aday").startAt, "2026-11-23T05:00:00.000Z"); // EST midnight
  assert.equal(by("dur").endAt, "2026-10-20T15:30:00.000Z");
  assert.equal(tzOf("Pacific Standard Time"), "America/Los_Angeles");
  assert.equal(tzOf("Bogus/Zone"), "America/Toronto");
});

test("ics: weekly BYDAY + UNTIL keeps 10:00 local across the Nov 1 DST change", () => {
  const ics = icsOf(
    vevent(
      "UID:r\r\nSUMMARY:standup\r\nDTSTART;TZID=America/Toronto:20261026T100000\r\n" +
        "DTEND;TZID=America/Toronto:20261026T103000\r\n" +
        "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261110T000000Z\r\n",
    ),
  );
  const cal = parseIcs(ics, { now: NOW });
  const starts = cal.events.map((e) => e.startAt).sort();
  assert.deepEqual(starts, [
    "2026-10-26T14:00:00.000Z", // 10:00 EDT
    "2026-11-02T15:00:00.000Z", // 10:00 EST — wall time kept across DST
    "2026-11-09T15:00:00.000Z",
  ]);
  assert.equal(cal.events[0].endAt, "2026-10-26T14:30:00.000Z");
});

test("ics: COUNT, monthly 2TU, monthly -1FR, BYMONTHDAY", () => {
  const cal = parseIcs(
    icsOf(
      vevent(
        "UID:c\r\nSUMMARY:cnt\r\nDTSTART;TZID=America/Toronto:20261020T090000\r\nRRULE:FREQ=DAILY;COUNT=3\r\n",
      ) +
        vevent(
          "UID:2tu\r\nSUMMARY:2tu\r\nDTSTART;TZID=America/Toronto:20261013T090000\r\nRRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=3\r\n",
        ) +
        vevent(
          "UID:lfr\r\nSUMMARY:lfr\r\nDTSTART;TZID=America/Toronto:20261030T090000\r\nRRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=3\r\n",
        ) +
        vevent(
          "UID:md\r\nSUMMARY:md\r\nDTSTART;TZID=America/Toronto:20261015T090000\r\nRRULE:FREQ=MONTHLY;BYMONTHDAY=15;COUNT=2\r\n",
        ),
    ),
    { now: NOW },
  );
  const dates = (t) => cal.events.filter((e) => e.title === t).map((e) => e.startAt.slice(0, 10)).sort();
  assert.deepEqual(dates("cnt"), ["2026-10-20", "2026-10-21", "2026-10-22"]);
  assert.deepEqual(dates("2tu"), ["2026-10-13", "2026-11-10", "2026-12-08"]);
  assert.deepEqual(dates("lfr"), ["2026-10-30", "2026-11-27", "2026-12-25"]);
  assert.deepEqual(dates("md"), ["2026-10-15", "2026-11-15"]);
});

test("ics: EXDATE removes a slot; cancelled master drops", () => {
  const cal = parseIcs(
    icsOf(
      vevent(
        "UID:e\r\nSUMMARY:ex\r\nDTSTART;TZID=America/Toronto:20261026T100000\r\n" +
          "RRULE:FREQ=WEEKLY;COUNT=3\r\nEXDATE;TZID=America/Toronto:20261102T100000\r\n",
      ) +
        vevent(
          "UID:gone\r\nSUMMARY:gone\r\nDTSTART;TZID=America/Toronto:20261020T100000\r\nSTATUS:CANCELLED\r\n",
        ),
    ),
    { now: NOW },
  );
  const ex = cal.events.filter((e) => e.title === "ex").map((e) => e.startAt.slice(0, 10)).sort();
  assert.deepEqual(ex, ["2026-10-26", "2026-11-09"]);
  assert.equal(cal.events.some((e) => e.title === "gone"), false);
});

test("ics: RECURRENCE-ID overrides a slot, CANCELLED removes it", () => {
  const cal = parseIcs(
    icsOf(
      vevent(
        "UID:m\r\nSUMMARY:weekly\r\nDTSTART;TZID=America/Toronto:20261026T100000\r\n" +
          "DTEND;TZID=America/Toronto:20261026T110000\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\n",
      ) +
        // Override BEFORE the master in file order — grouping is by UID.
        "BEGIN:VEVENT\r\nUID:m\r\nSUMMARY:moved\r\nRECURRENCE-ID;TZID=America/Toronto:20261102T100000\r\n" +
        "DTSTART;TZID=America/Toronto:20261103T140000\r\nDTEND;TZID=America/Toronto:20261103T150000\r\nEND:VEVENT\r\n" +
        "BEGIN:VEVENT\r\nUID:m\r\nSUMMARY:weekly\r\nRECURRENCE-ID;TZID=America/Toronto:20261109T100000\r\n" +
        "DTSTART;TZID=America/Toronto:20261109T100000\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\n",
    ),
    { now: NOW },
  );
  const got = cal.events.map((e) => `${e.title}@${e.startAt}`).sort();
  assert.deepEqual(got, ["moved@2026-11-03T19:00:00.000Z", "weekly@2026-10-26T14:00:00.000Z"]);
  const moved = cal.events.find((e) => e.title === "moved");
  assert.equal(moved.endAt, "2026-11-03T20:00:00.000Z");
});

test("ics: only the window [now-7d, now+120d] is emitted", () => {
  const cal = parseIcs(
    icsOf(
      vevent("UID:a\r\nSUMMARY:in\r\nDTSTART:20261020T150000Z\r\n") +
        vevent("UID:b\r\nSUMMARY:too-old\r\nDTSTART:20261001T150000Z\r\n") + // > 7 d back
        vevent("UID:c\r\nSUMMARY:too-far\r\nDTSTART:20270301T150000Z\r\n") + // > 120 d out
        vevent("UID:d\r\nSUMMARY:old-rec\r\nDTSTART:20261001T150000Z\r\nRRULE:FREQ=DAILY;COUNT=3\r\n"),
    ),
    { now: NOW },
  );
  assert.deepEqual(cal.events.map((e) => e.title).sort(), ["in"]);
});

test("ics: Waterloo All-in-1 calendar flagged, others kept", () => {
  const feed = parseIcs(
    icsOf(vevent("UID:x\r\nSUMMARY:ours\r\nDTSTART:20261020T150000Z\r\n"), "BEGIN:VCALENDAR\r\nX-WR-CALNAME:Waterloo All-in-1\r\n"),
    { now: NOW },
  );
  assert.equal(feed.wa1, true);
  const mine = parseIcs(
    icsOf(vevent("UID:x\r\nSUMMARY:ours\r\nDTSTART:20261020T150000Z\r\n")),
    { now: NOW },
  );
  assert.equal(mine.wa1, false);
  assert.equal(mine.events[0].calendarKind, "own");
});

/* --------------------------------- gate --------------------------------- */

test("gcalGate: settle windows, churn resets, empty grid slower, heartbeat", () => {
  const g = gcalGate();
  // Populated grid: 1.5 s quiet.
  assert.deepEqual(g.tick(true, 3, "s1", 0), { send: false, settled: false, heartbeat: false });
  assert.equal(g.tick(true, 3, "s1", SETTLE_MS - 1).send, false);
  assert.deepEqual(g.tick(true, 3, "s1", SETTLE_MS), { send: true, settled: true, heartbeat: false });
  g.sent(SETTLE_MS);
  // A chip-set change restarts the quiet window.
  assert.equal(g.tick(true, 4, "s2", SETTLE_MS + 100).send, false);
  assert.equal(g.tick(true, 4, "s2", SETTLE_MS + 100 + SETTLE_MS).settled, true);

  const e = gcalGate();
  // Empty grid: 5 s.
  assert.equal(e.tick(true, 0, "z", 0).send, false);
  assert.equal(e.tick(true, 0, "z", SETTLE_EMPTY_MS - 1).send, false);
  assert.equal(e.tick(true, 0, "z", SETTLE_EMPTY_MS).settled, true);
  e.sent(SETTLE_EMPTY_MS);
  // Heartbeat re-sends even while unsettled.
  const hb = e.tick(true, 0, "z2", SETTLE_EMPTY_MS + HEARTBEAT_MS);
  assert.deepEqual(hb, { send: true, settled: false, heartbeat: true });
  // No grid: never sends, and no heartbeat arming.
  assert.equal(e.tick(false, 0, "z2", SETTLE_EMPTY_MS + 2 * HEARTBEAT_MS).send, false);
});

/* --------------------------------- sync --------------------------------- */

const zipPayload = (entries) => Buffer.from(buildZip(entries)).toString("base64");
const calZip = zipPayload([
  { name: "basic.ics", method: 8, data: enc.encode(icsOf(vevent("UID:x\r\nSUMMARY:gym\r\nDTSTART:20261020T150000Z\r\n"))) },
  {
    name: "abcd@group.calendar.google.com/basic.ics",
    method: 8,
    data: enc.encode(icsOf(vevent("UID:y\r\nSUMMARY:side\r\nDTSTART:20261021T150000Z\r\n"))),
  },
  {
    name: "feed@import.calendar.google.com/basic.ics",
    method: 8,
    data: enc.encode(icsOf(vevent("UID:z\r\nSUMMARY:ours\r\nDTSTART:20261020T150000Z\r\n"), "BEGIN:VCALENDAR\r\nX-WR-CALNAME:Waterloo All-in-1\r\n")),
  },
]);

const sctx = (over) => ({
  now: NOW,
  settings: { enabled: true },
  state: {},
  courses: [],
  terms: [],
  log: () => {},
  ...over,
});

test("sync: disabled short-circuits; status 0 is unreachable", async () => {
  let r = await adapter.sync(sctx({ settings: { enabled: false } }));
  assert.equal(r.session, "no-tab");
  assert.equal(r.complete, false);
  r = await adapter.sync(sctx({ fetch: async () => ({ status: 0 }) }));
  assert.equal(r.error && r.error.code, "unreachable");
  assert.equal(r.session, undefined);
});

test("sync: login redirect / html / non-zip all look signed-out", async () => {
  for (const res of [
    { status: 200, loginRedirect: true, base64: zipPayload([{ name: "a.ics", method: 0, data: enc.encode("x") }]) },
    { status: 200, contentType: "text/html", base64: Buffer.from("<html>").toString("base64") },
    { status: 200, contentType: "application/octet-stream", base64: Buffer.from("NOPE").toString("base64") },
  ]) {
    const prev = { events: [{ title: "k", startAt: "2026-10-20T15:00:00.000Z", allDay: false, calendarKind: "own" }] };
    const r = await adapter.sync(sctx({ state: prev, fetch: async () => res }));
    assert.equal(r.session, "signed-out");
    assert.deepEqual(r.state, prev); // state preserved
  }
});

test("sync: export zip parses calendars, skips import/group.v + the WA1 feed", async () => {
  const r = await adapter.sync(sctx({ fetch: async (url) => {
    assert.ok(url.endsWith("/calendar/u/0/exporticalzip"));
    return { status: 200, contentType: "application/zip", base64: calZip };
  } }));
  assert.equal(r.complete, true);
  assert.deepEqual(r.readOk, ["gcal"]);
  assert.equal(r.scope, "gcal");
  assert.equal(r.session, undefined);
  assert.deepEqual(
    r.state.events.map((e) => e.title).sort(),
    ["gym", "side"], // the @import entry is skipped
  );
  assert.equal(r.state.ics.calendars, 2);
  assert.equal(r.state.ics.events, 2);
});

test("sync: DOM subscribed/unknown events merge with export own events", async () => {
  const prev = {
    events: [
      { title: "feed event", startAt: "2026-10-20T15:00:00.000Z", allDay: false, calendarKind: "subscribed" },
      { title: "mystery", startAt: "2026-10-22T15:00:00.000Z", allDay: false, calendarKind: "unknown" },
      { title: "stale own", startAt: "2026-10-23T15:00:00.000Z", allDay: false, calendarKind: "own" },
    ],
  };
  const r = await adapter.sync(sctx({ state: prev, fetch: async () => ({ status: 200, base64: calZip, contentType: "application/zip" }) }));
  const ts = r.state.events.map((e) => `${e.title}:${e.calendarKind}`).sort();
  assert.deepEqual(ts, ["feed event:subscribed", "gym:own", "mystery:unknown", "side:own"]);
});

test("sync: export failure falls back to validated icalUrls only", async () => {
  const urls = [
    "https://calendar.google.com/calendar/ical/abc/private-secretkey/basic.ics",
    "https://evil.example.com/x.ics", // wrong host — never fetched
    "https://calendar.google.com/other/path.ics", // wrong path — never fetched
  ];
  const fetched = [];
  const r = await adapter.sync(
    sctx({
      settings: { enabled: true, icalUrls: urls },
      fetch: async (url) => {
        fetched.push(url);
        if (url.includes("exporticalzip")) return { status: 200, base64: Buffer.from("notzip").toString("base64"), contentType: "application/zip" };
        return { status: 200, text: icsOf(vevent("UID:fb\r\nSUMMARY:fallback\r\nDTSTART:20261020T150000Z\r\n")) };
      },
      log: (...a) => {
        for (const s of a) assert.ok(!String(s).includes("secretkey"), "secret iCal URL logged");
      },
    }),
  );
  assert.equal(r.complete, true);
  assert.equal(r.session, undefined);
  assert.deepEqual(r.state.events.map((e) => e.title), ["fallback"]);
  // Only the export URL and the valid iCal URL were fetched.
  assert.deepEqual(fetched.length, 2);
  assert.ok(fetched[0].includes("exporticalzip"));
  assert.ok(fetched[1].startsWith("https://calendar.google.com/calendar/ical/"));
  // The secret never lands in state.
  assert.ok(!JSON.stringify(r.state).includes("secretkey"));
});
