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
  eventOrgTitle,
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

  // 10 dated rows in the Sep-28 table + 1 in the Oct-7 table; the stray
  // one-cell row and the undated "Coming Soon" table emit nothing.
  assert.equal(events.length, 11);

  const byEv = Object.fromEntries(
    events.map((i) => [i.meta.eventId, i])
  );
  assert.deepEqual(
    Object.keys(byEv).sort(),
    [
      "4701", "4702", "4703", "4704", "4705", "4706",
      "4707", "4708", "4709", "4710", "4711",
    ]
  );
  assert.equal(byEv["4701"].id, "waterlooworks:event:4701");

  // Review: only the Registered badge is auto; everything else is pending.
  assert.equal(byEv["4703"].review, "auto");
  assert.equal(byEv["4703"].meta.registered, true);
  for (const id of ["4701", "4702", "4705", "4708", "4709", "4710", "4711"]) {
    assert.equal(byEv[id].review, "pending", `event ${id} pending`);
  }
  assert.equal(byEv["4701"].meta.registered, false);
  assert.equal(byEv["4704"].meta.registered, false);
  assert.equal(byEv["4704"].meta.waitlisted, true);
  assert.equal(byEv["4705"].meta.registered, undefined, "no badge -> undefined");

  // Org extraction: employer-first pipes, host clauses, employer-category
  // colons and "X Info Session"/"X Tech Talk" shapes, then the Career
  // Centre default.
  assert.equal(byEv["4701"].org, "Initech Corp"); // rule 2 "with X"
  assert.equal(byEv["4702"].org, "Globex Industries"); // rule 1 "<Org> | …"
  assert.equal(byEv["4703"].org, "Centre for Career Development"); // hosted by
  assert.equal(byEv["4704"].org, "Engineering Society"); // presented by
  assert.equal(byEv["4706"].org, "Wayne Enterprises"); // cancelled, still org
  assert.equal(byEv["4707"].org, "Umbrella Corp"); // "<Org> Employer Info…"
  assert.equal(byEv["4709"].org, "Initech Corp"); // "Inside <Org>: …"
  assert.equal(byEv["4710"].org, "Wayne Enterprises"); // "<Org> Tech Talk"
  assert.equal(byEv["4705"].org, undefined, "no host named");
  assert.equal(byEv["4708"].org, undefined, "no host named");

  // meta.employer follows rules 1-4 only: the Career Centre colon title is
  // NOT rule 3 — it falls to the centre default, which is no employer.
  assert.equal(byEv["4702"].meta.employer, "Globex Industries");
  assert.equal(byEv["4707"].meta.employer, "Umbrella Corp");
  assert.equal(byEv["4709"].meta.employer, "Initech Corp");
  assert.equal(byEv["4710"].meta.employer, "Wayne Enterprises");
  assert.equal(byEv["4711"].org, "Centre for Career Development");
  assert.equal(byEv["4711"].meta.employer, undefined);
  assert.equal(byEv["4705"].meta.employer, undefined);

  // Titles: "| -" collapsed to " — "; a pipe title's employer segment is
  // dropped once it names the org; " - <modality>" normalizes to " — ".
  assert.equal(
    byEv["4701"].title,
    "Explore Opportunities at Initech Corp — IN-PERSON Information Session with Initech Corp"
  );
  assert.equal(
    byEv["4702"].title,
    "Globex: Building Better Widgets — VIRTUAL Information Session"
  );
  assert.equal(
    byEv["4709"].title,
    "Inside Initech Corp: Co-op Program Overview — VIRTUAL Information Session"
  );

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
    (i) =>
      i.type === "event" &&
      i.title ===
        "Inside Initech Corp: Co-op Program Overview — VIRTUAL Information Session"
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

test("eventOrgTitle: one case per rule, first match wins", () => {
  const EMP = "Employer Information Sessions";
  const CC = "Career Centre Events";
  const NPE = "Additional Networking and Professional Events";

  // Rule 1: "<Employer> | <Title>" — org is the first segment, the title
  // keeps the rest with " - <modality>" normalized to " — ".
  assert.deepEqual(
    eventOrgTitle(
      "Globex Industries | Globex: Building Better Widgets - VIRTUAL Information Session",
      EMP
    ),
    {
      org: "Globex Industries",
      employer: "Globex Industries",
      title: "Globex: Building Better Widgets — VIRTUAL Information Session",
      rule: 1,
    }
  );
  // First segment over the 6-word limit is not treated as an employer.
  const long = eventOrgTitle(
    "This Is A Very Long Employer Name Indeed | Panel - IN-PERSON Information Session",
    EMP
  );
  assert.notEqual(long.rule, 1);

  // Rule 2: with / hosted by / presented by — any category, modality cut.
  assert.equal(
    eventOrgTitle(
      "Big Night — IN-PERSON Information Session with Wayne Enterprises",
      EMP
    ).org,
    "Wayne Enterprises"
  );
  assert.equal(
    eventOrgTitle(
      "Info Session with Wayne Enterprises VIRTUAL Information Session",
      EMP
    ).org,
    "Wayne Enterprises"
  );
  assert.equal(
    eventOrgTitle("Fair — VIRTUAL Career Fair hosted by Alumni Office", NPE).org,
    "Alumni Office"
  );
  assert.equal(
    eventOrgTitle("Workshop presented by Co-op Office", CC).org,
    "Co-op Office"
  );

  // Rule 3: employer-category "<Org>: <Title>" with the opener stripped.
  assert.equal(
    eventOrgTitle("Webz Corporation: Operating at Scale — IN-PERSON Information Session", EMP)
      .org,
    "Webz Corporation"
  );
  assert.equal(
    eventOrgTitle(
      "Inside Wayne Enterprises: Our Products, Our People — IN-PERSON Information Session",
      EMP
    ).org,
    "Wayne Enterprises"
  );
  assert.equal(
    eventOrgTitle(
      "Explore Globex Industries (GLO): Internships & Recruitment — IN-PERSON Information Session",
      EMP
    ).org,
    "Globex Industries (GLO)"
  );
  // …but only for employer categories.
  assert.equal(
    eventOrgTitle("Teacher's college: planning for a successful application", CC).rule,
    5
  );

  // Rule 4: "<Org> [modality|Employer] Info Session" / "<Org> Tech Talk".
  assert.equal(
    eventOrgTitle("Wayne Enterprises IN-PERSON Information Session", EMP).org,
    "Wayne Enterprises"
  );
  assert.equal(
    eventOrgTitle(
      "Wayne Enterprises Employer Information Session — IN-PERSON Information Session",
      EMP
    ).org,
    "Wayne Enterprises"
  );
  assert.equal(
    eventOrgTitle("Acme Tech Talk — IN-PERSON Information Session", EMP).org,
    "Acme"
  );

  // Rule 5: the Career Centre default is an org but never an employer.
  const cc = eventOrgTitle("Resume drop-in hours", CC);
  assert.equal(cc.org, "Centre for Career Development");
  assert.equal(cc.employer, undefined);

  // Rule 6: no signal -> undefined, never "WaterlooWorks".
  assert.equal(eventOrgTitle("plain title", NPE).org, undefined);
  assert.equal(eventOrgTitle("", EMP).org, undefined);
  assert.equal(eventOrgTitle("WaterlooWorks | Panel - IN-PERSON", EMP).org, undefined);
});
