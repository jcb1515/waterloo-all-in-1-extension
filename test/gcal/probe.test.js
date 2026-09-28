// @ts-check
// Google Calendar reader probe: page kinds, selector counts, ok flags,
// hints and the privacy rule (counts only — never text).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { probe, CHECKLIST } from "../../extension/src/sources/gcal/probe.js";
import { gcalExtract } from "../../extension/src/sources/gcal/dom.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "gcal");
const html = (name) => fs.readFileSync(path.join(DIR, `${name}.html`), "utf8");
const docOf = (name) => parseHTML(html(name)).document;

const GC = "https://calendar.google.com/calendar/u/0/r/";
const NOW = new Date("2026-09-28T12:00:00.000Z");

const FIXTURES = [
  { name: "gcal-week", url: GC + "week/2026/9/29", page: "gcal-week" },
  { name: "gcal-day", url: GC + "day/2026/10/1", page: "gcal-day" },
  { name: "gcal-month", url: GC + "month/2026/10/1", page: "gcal-month" },
  { name: "gcal-schedule", url: GC + "agenda", page: "gcal-schedule" },
  { name: "gcal-shortid", url: GC + "day/2026/10/1", page: "gcal-day" },
];

test("probe: page kind, ok and kind counts match the extract", () => {
  for (const f of FIXTURES) {
    const doc = docOf(f.name);
    const r = probe(doc, f.url);
    assert.equal(r.page, f.page, f.name);
    assert.equal(r.ok, true, f.name);
    const ex = gcalExtract(doc, f.url, { now: NOW });
    for (const kind of ["own", "subscribed", "unknown"]) {
      assert.equal(
        r.counts[kind],
        ex.events.filter((e) => e.calendarKind === kind).length,
        `${f.name}.${kind}`,
      );
    }
    // In these fixtures every parseable chip maps 1:1 to an event (the
    // week popup merges into its chip rather than adding).
    assert.equal(r.counts.labeled, ex.events.length, f.name);
    assert.ok(r.counts.decodedIds <= r.counts.eventChips, f.name);
    assert.equal(r.counts.account, 1, f.name);
  }
});

test("probe: exact counts on the week fixture", () => {
  const r = probe(docOf("gcal-week"), GC + "week/2026/9/29");
  assert.deepEqual(r.counts, {
    eventChips: 6,
    labeled: 5,
    decodedIds: 4,
    own: 1,
    subscribed: 3,
    unknown: 1,
    detailPopup: 1,
    account: 1,
  });
});

test("probe: a bare /r URL still reads the view from the DOM", () => {
  const r = probe(docOf("gcal-week"), GC);
  assert.equal(r.page, "gcal-week");
  assert.equal(r.ok, true);
});

test("probe: detailPopup only where a dialog reads", () => {
  for (const f of FIXTURES) {
    const r = probe(docOf(f.name), f.url);
    assert.equal(r.counts.detailPopup, f.name === "gcal-week" ? 1 : 0, f.name);
  }
});

test("probe: empty docs, other pages and garbage fail soft with hints", () => {
  const { document: empty } = parseHTML("<html><body></body></html>");
  for (const url of [GC + "week/2026/9/29", GC + "agenda", GC + "settings"]) {
    const r = probe(empty, url);
    assert.equal(r.ok, false, url);
    assert.ok(r.hints.length > 0, url);
  }
  assert.equal(probe(empty, GC + "settings").page, "gcal-other");
  assert.equal(probe(empty, "https://example.com/").page, "unknown");
  const r = probe(null, "not a url");
  assert.equal(r.page, "unknown");
  assert.equal(r.ok, false);
  assert.deepEqual(r.counts, {});
});

test("probe: results are counts only — no text, names or addresses", () => {
  const secrets = [
    "jane.student@example.com",
    "jane.student@gmail.com",
    "@",
    "Chat about robotics",
    "Jane Student",
    "Friend Name",
    "Hackathon",
  ];
  for (const f of FIXTURES) {
    const r = probe(docOf(f.name), f.url);
    for (const [k, v] of Object.entries(r.counts)) {
      assert.equal(typeof v, "number", `${f.name}.${k}`);
    }
    const blob = JSON.stringify(r);
    for (const s of secrets) assert.ok(!blob.includes(s), `${f.name} leaked ${s}`);
  }
});

test("probe CHECKLIST: unique ids, filled fields, known pages", () => {
  const ids = new Set();
  const pages = new Set([
    "gcal-day", "gcal-week", "gcal-month", "gcal-schedule", "gcal-other", "unknown",
  ]);
  for (const c of CHECKLIST) {
    assert.ok(!ids.has(c.id), c.id);
    ids.add(c.id);
    assert.ok(c.label.length > 0, c.id);
    assert.ok(c.how.length > 0, c.id);
    assert.ok(pages.has(c.page), c.id);
  }
});
