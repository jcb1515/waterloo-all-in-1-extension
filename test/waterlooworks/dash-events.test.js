// @ts-check
// Dashboard "Upcoming Events / Workshops": every dated row becomes an event
// item (registered = auto, the rest pending), keyed by the digits-only
// eventId that buildSnapshot preserves on the row.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseHTML } from "linkedom";
import { extractDates } from "../../extension/src/lib/textdates/index.js";
import * as parsers from "../../extension/src/sources/waterlooworks/parsers.js";
import {
  dashboardEventItems,
  eventOrg,
} from "../../extension/src/sources/waterlooworks/map.js";
import { buildSnapshot } from "../../extension/src/sources/waterlooworks/refresh.js";
import adapter from "../../extension/src/sources/waterlooworks/index.js";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "waterlooworks"
);
const WW = "https://waterlooworks.uwaterloo.ca/myAccount";
const NOW = new Date("2026-09-20T12:00:00.000Z");
const AT = NOW.toISOString();

const fixture = (name) => readFileSync(path.join(FIXTURES, name), "utf8");
const DASH_URL = `${WW}/dashboard.htm`;

function makeCtx(state = {}) {
  return {
    state,
    now: NOW,
    settings: {},
    async parseHtml(html, name, opts) {
      const exportName = name.split("/")[1];
      return parsers[exportName](parseHTML(html).document, opts);
    },
    textDates: extractDates,
    log() {},
  };
}

const dashPayload = (body) => ({
  source: "waterlooworks",
  kind: "dom",
  url: DASH_URL,
  body,
  at: AT,
});

const eventsPayload = (body) => ({
  source: "waterlooworks",
  kind: "net",
  url: `${WW}/co-op/full/events.htm`,
  body,
  at: AT,
});

/** The fixture HTML through the real snapshot scrubber. */
const snapshotOf = (html, doc) =>
  buildSnapshot(doc || parseHTML(html).document);

test("buildSnapshot keeps data-wa1-event-id digits, never the token", () => {
  const snap = snapshotOf(fixture("dashboard-events-live.html"));
  assert.ok(snap, "snapshot produced");
  assert.match(snap, /data-wa1-event-id="4701"/);
  assert.match(snap, /data-wa1-event-id="4709"/);
  assert.ok(!/buildForm/.test(snap), "no buildForm call survives");
  assert.ok(!/'action'/.test(snap), "no action key survives");
  assert.ok(!/orbisAppSr/.test(snap), "no token helper survives");
  assert.ok(!/javascript:/i.test(snap), "no javascript: href survives");
});

test("dashboard events: rows, review states, orgs, ids", async () => {
  const snap = snapshotOf(fixture("dashboard-events-live.html"));
  const res = await adapter.observe.parse(dashPayload(snap), makeCtx());
  const events = res.items.filter((i) => i.type === "event");

  // 8 dated rows in the Sep-28 table + 1 in the Oct-7 table; the stray
  // one-cell row and the undated "Coming Soon" table emit nothing.
  assert.equal(events.length, 9);

  const byEv = Object.fromEntries(
    events.map((i) => [i.meta.eventId, i])
  );
  assert.deepEqual(
    Object.keys(byEv).sort(),
    ["4701", "4702", "4703", "4704", "4705", "4706", "4707", "4708", "4709"]
  );
  assert.equal(byEv["4701"].id, "waterlooworks:event:4701");

  // Review: only the Registered badge is auto; everything else is pending.
  assert.equal(byEv["4703"].review, "auto");
  assert.equal(byEv["4703"].meta.registered, true);
  for (const id of ["4701", "4702", "4705", "4708", "4709"]) {
    assert.equal(byEv[id].review, "pending", `event ${id} pending`);
  }
  assert.equal(byEv["4701"].meta.registered, false);
  assert.equal(byEv["4704"].meta.registered, false);
  assert.equal(byEv["4704"].meta.waitlisted, true);
  assert.equal(byEv["4705"].meta.registered, undefined, "no badge -> undefined");

  // Org extraction: with / hosted by / presented by on the last segment.
  assert.equal(byEv["4701"].org, "Initech Corp");
  assert.equal(byEv["4703"].org, "Centre for Career Development");
  assert.equal(byEv["4704"].org, "Engineering Society");
  assert.equal(byEv["4708"].org, undefined, "no host named");
  assert.equal(byEv["4702"].org, undefined, "no em-dash segment");

  // Titles: "| -" collapsed to " — ", "| " without a dash left alone.
  assert.equal(
    byEv["4701"].title,
    "Explore Opportunities at Initech Corp — IN-PERSON Information Session with Initech Corp"
  );
  assert.match(byEv["4702"].title, /^Globex Industries \| Globex:/);

  // All-day row: dated but no time -> date-only startAt + allDay.
  assert.equal(byEv["4707"].allDay, true);
  assert.equal(byEv["4707"].startAt, "2026-09-28");
  assert.equal(byEv["4707"].endAt, undefined);

  // Virtual link wins over the empty <small> for location + url.
  assert.equal(byEv["4708"].location, "https://teams.example.test/join/abc123");
  assert.equal(byEv["4708"].url, "https://teams.example.test/join/abc123");
  assert.equal(byEv["4701"].location, "Tatham Centre 2218");

  // Cancelled badge -> cancelled status.
  assert.equal(byEv["4706"].status, "cancelled");

  // Evidence carries the page URL, never a javascript: or details URL.
  assert.equal(byEv["4701"].evidence.method, "html");
  assert.equal(byEv["4701"].evidence.url, DASH_URL);
});

test("dashboard event ids are stable across two reads", async () => {
  const snap = snapshotOf(fixture("dashboard-events-live.html"));
  const first = await adapter.observe.parse(dashPayload(snap), makeCtx());
  const second = await adapter.observe.parse(
    dashPayload(snap),
    makeCtx(first.state)
  );
  assert.deepEqual(
    second.items.filter((i) => i.type === "event").map((i) => i.id).sort(),
    first.items.filter((i) => i.type === "event").map((i) => i.id).sort()
  );
});

test("a registrations-grid row folds into the dashboard event", async () => {
  const first = await adapter.observe.parse(
    dashPayload(snapshotOf(fixture("dashboard-events-live.html"))),
    makeCtx()
  );
  // The grid row (title + startAt identical to dash event 4709) is read.
  const second = await adapter.observe.parse(
    eventsPayload(fixture("events.html")),
    makeCtx(first.state)
  );
  const matches = second.items.filter(
    (i) => i.type === "event" && i.title === "Employer Info Session: Initech Corp"
  );
  assert.equal(matches.length, 1, "one canonical item");
  assert.equal(matches[0].id, "waterlooworks:event:4709");
  assert.equal(matches[0].review, "auto", "grid read proves registration");
  assert.equal(matches[0].meta.registered, true);
  // The two other grid rows still emit their own items.
  assert.ok(second.items.some((i) => i.title === "Resume Critiques"));
  assert.ok(second.items.some((i) => i.title === "Mock Interview Night"));
});

test("dashboardEventItems: no time without a date, fnv fallback ids", () => {
  const items = dashboardEventItems(
    [
      { name: "Mystery", startAt: "2026-09-28T15:30:00.000Z" }, // no date
      { name: "No Key Row", date: "2026-09-29" },              // no eventId -> fnv
    ],
    NOW
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "No Key Row");
  assert.match(items[0].id, /^waterlooworks:event:[0-9a-f]+$/);
});

test("eventOrg: host clauses and modality tails", () => {
  assert.equal(
    eventOrg("Big Night — IN-PERSON Information Session with Wayne Enterprises"),
    "Wayne Enterprises"
  );
  assert.equal(eventOrg("Fair — VIRTUAL Career Fair hosted by Alumni Office"), "Alumni Office");
  assert.equal(eventOrg("Workshop presented by Co-op Office"), "Co-op Office");
  assert.equal(eventOrg("Drop-in Hours | no separator"), undefined);
  assert.equal(eventOrg("plain title"), undefined);
  assert.equal(eventOrg(""), undefined);
});
