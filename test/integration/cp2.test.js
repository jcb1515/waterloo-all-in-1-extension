// @ts-check
// CP2 integration: the real CP2 adapters + the real core merge pipeline over
// the redacted fixtures. parseHtml fakes dispatch to the real parser modules
// through linkedom, the same way the offscreen document does.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseHTML } from "linkedom";

import outlineAdapter from "../../extension/src/sources/outline/index.js";
import portalAdapter from "../../extension/src/sources/portal/index.js";
import wwAdapter from "../../extension/src/sources/waterlooworks/index.js";
import discordAdapter from "../../extension/src/sources/discord/index.js";
import { parseOutline } from "../../extension/src/sources/outline/parsers.js";
import * as wwParsers from "../../extension/src/sources/waterlooworks/parsers.js";
import { eventsModalExtract } from "../../extension/src/sources/discord/dom.js";
import { adapterSettings } from "../../extension/src/core/scheduler.js";
import { observePatternsFor, adapterForSource } from "../../extension/src/core/registry.js";
import {
  applyResult,
  recompute,
  mergeCourses,
} from "../../extension/src/core/merge.js";
import { extractDates } from "../../extension/src/lib/textdates/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTLINE_DIR = path.join(ROOT, "fixtures", "outline");
const PORTAL_DIR = path.join(ROOT, "fixtures", "portal");
const WW_DIR = path.join(ROOT, "fixtures", "waterlooworks");
const DISCORD_DIR = path.join(ROOT, "fixtures", "discord");
const fixture = (dir, name) => readFileSync(path.join(dir, name), "utf8");

const NOW = new Date("2026-09-27T16:00:00.000Z");
const AT = NOW.toISOString();

const PARSER_NAME = /^[a-z0-9_-]+\/[a-z0-9_-]+$/i;
const TABLE = {
  "outline/parseOutline": parseOutline,
  "waterlooworks/parseAll": wwParsers.parseAll,
};
function makeParseHtml() {
  return async (a, b, opts) => {
    const parser = PARSER_NAME.test(String(a)) ? a : b;
    const html = PARSER_NAME.test(String(a)) ? b : a;
    const fn = TABLE[parser];
    assert.ok(fn, `unknown parser ${parser}`);
    return fn(parseHTML(String(html)).document, opts);
  };
}

function makeCtx(state = {}, extras = {}) {
  return {
    state,
    now: NOW,
    settings: extras.settings || {},
    courses: extras.courses || [],
    terms: extras.terms || [],
    log() {},
    textDates: extractDates,
    fetch: extras.fetch || (async () => ({ status: 0, error: "unused" })),
    relay: extras.relay || (async () => ({ status: 0, error: "unused" })),
    parseHtml: makeParseHtml(),
  };
}

const net = (source, url, body, extra = {}) => ({
  source,
  kind: /** @type {const} */ ("net"),
  url,
  method: "GET",
  status: 200,
  body: typeof body === "string" ? body : JSON.stringify(body),
  at: AT,
  ...extra,
});
const dom = (source, extract, url) => ({
  source,
  kind: /** @type {const} */ ("dom"),
  url,
  body: JSON.stringify(extract),
  at: AT,
});

/* --------- 1+c. Portal observes fold into items, courses and the merge --------- */

const PORTAL_API = "https://portalapi2.uwaterloo.ca/v2";

test("portal observePatternsFor matches the portalapi2 endpoints the page calls", () => {
  // The recorder runs on portal.uwaterloo.ca; SITE_BY_HOST maps the page to
  // the "portal" adapter, and the page-world observer forwards any response
  // whose URL matches these patterns — cross-origin to portalapi2.
  const patterns = observePatternsFor("portal");
  assert.ok(patterns.length > 0);
  assert.equal(adapterForSource("portal"), portalAdapter);
  const re = patterns.map((p) => new RegExp(p));
  const match = (u) => re.some((r) => r.test(u));
  for (const u of [
    `${PORTAL_API}/student/CourseSchedule/`,
    `${PORTAL_API}/student/ExamSchedule/`,
    `${PORTAL_API}/student/CourseEnrollments/`,
    `${PORTAL_API}/Calendar/DailyEventsV2?start=2026-09-01&end=2026-12-31`,
  ]) {
    assert.ok(match(u), u);
  }
  assert.ok(!match(`${PORTAL_API}/Weather`));
});

test("portal fixtures -> applyResult -> recompute: class/exam items, courses", async () => {
  const parse = portalAdapter.observe.parse;
  const r1 = await parse(net("portal", `${PORTAL_API}/student/CourseSchedule/`, fixture(PORTAL_DIR, "schedule.json")), makeCtx());
  const r2 = await parse(net("portal", `${PORTAL_API}/student/ExamSchedule/`, fixture(PORTAL_DIR, "exams.json")), makeCtx(r1.state));
  const r3 = await parse(net("portal", `${PORTAL_API}/student/CourseEnrollments/`, fixture(PORTAL_DIR, "enrollments.json")), makeCtx(r2.state));

  let raw = applyResult(null, r1, { mode: "scope", scope: r1.scope });
  raw = applyResult(raw, r2, { mode: "scope", scope: r2.scope });
  raw = applyResult(raw, r3, { mode: "scope", scope: r3.scope });

  const { items } = recompute({ raws: { portal: raw }, now: NOW });
  const merged = Object.values(items);
  assert.ok(merged.some((i) => i.type === "class" && i.section === "LEC 002"));
  assert.ok(merged.some((i) => i.type === "exam" && i.category === "final"));
  assert.ok(merged.every((i) => i.source === "portal"));

  const courses = mergeCourses({ portal: raw });
  const ece = courses["ECE 150"];
  assert.ok(ece, "ECE 150 course merged");
  assert.ok(ece.sections.includes("LEC 002") && ece.sections.includes("TUT 102"));
  assert.equal(ece.outlineUrl, "https://outline.uwaterloo.ca/viewer/view/npch7t");
});

/* --------- 2. Portal sections reach the outline adapter via ctx.courses --------- */

test("outline sync uses Portal's sections from ctx.courses (pickSections)", async () => {
  const portalRes = await portalAdapter.observe.parse(
    net("portal", `${PORTAL_API}/student/CourseEnrollments/`, fixture(PORTAL_DIR, "enrollments.json")),
    makeCtx(),
  );
  const courses = portalRes.courses; // ECE 150: ["LEC 002", "TUT 102"]

  const ece150 = fixture(OUTLINE_DIR, "ECE150.html");
  const settings = adapterSettings("outline", {
    profile: { sections: { "ECE 150": ["LEC 001"] }, groups: {} }, // stale profile
    sources: { outline: { urls: ["https://outline.uwaterloo.ca/viewer/view/npch7t"] } },
  });
  const ctx = makeCtx(
    {},
    {
      settings,
      courses,
      fetch: async (url) =>
        url === settings.urls[0]
          ? { status: 200, url, contentType: "text/html", text: ece150 }
          : { status: 404, error: "not found" },
    },
  );
  const res = await outlineAdapter.sync(ctx);
  assert.equal(res.complete, true);

  const classes = res.items.filter((i) => i.type === "class" || i.type === "tutorial" || i.type === "lab");
  const sections = new Set(classes.map((i) => i.section));
  // Portal's enrollment wins over the stale profile section.
  assert.ok(sections.has("LEC 002"), `got ${[...sections]}`);
  assert.ok(sections.has("TUT 102"), `got ${[...sections]}`);
  assert.ok(!sections.has("LEC 001"));
  // The mismatch surfaces as a review update for the Updates feed.
  const mm = (res.updates || []).find((u) => u.kind === "review");
  assert.ok(mm, "expected a section-mismatch review update");
  assert.match(mm.text, /Portal lists ECE 150/);
});

/* ------ 3. Portal's exact final merges into the outline's tentative window ------ */

test("portal exact final lands inside the outline's tentative exam window", async () => {
  const math117 = fixture(OUTLINE_DIR, "MATH117.html");
  const settings = adapterSettings("outline", {
    sources: { outline: { urls: ["https://outline.uwaterloo.ca/viewer/math117"] } },
  });
  const outlineRes = await outlineAdapter.sync(
    makeCtx({}, {
      settings,
      fetch: async (url) => ({ status: 200, url, contentType: "text/html", text: math117 }),
    }),
  );
  const window = outlineRes.items.find((i) => i.id === "outline:MATH117:assess:final-exam");
  assert.ok(window && window.allDay && window.confidence === "tentative", "outline window item");

  const portalRes = await portalAdapter.observe.parse(
    net("portal", `${PORTAL_API}/student/ExamSchedule/`, fixture(PORTAL_DIR, "exams.json")),
    makeCtx(),
  );
  const exact = portalRes.items.find((i) => i.org === "MATH 117" && i.category === "final");
  assert.ok(exact && exact.confidence === "exact" && !exact.allDay, "portal exact final");

  const raws = {
    outline: applyResult(null, outlineRes, { mode: "replace" }),
    portal: applyResult(null, portalRes, { mode: "scope", scope: portalRes.scope }),
  };
  const { items } = recompute({ raws, now: NOW });
  const finals = Object.values(items).filter(
    (i) => i.org === "MATH 117" && i.type === "exam" && i.category === "final",
  );
  assert.equal(finals.length, 1, "the window and the exact final merge into one item");
  assert.equal(finals[0].confidence, "exact");
  assert.equal(finals[0].startAt, exact.startAt); // Portal's slot wins
  const sources = (finals[0].seenIn || []).map((s) => s.source);
  assert.ok(sources.includes("outline") && sources.includes("portal"));
});

/* --------------- 4. Discord: dated message -> pending, event -> meeting --------------- */

const G = "1000000000000000001"; // Robotics Club
const CH = "2000000000000000002"; // pcb-design (watched via suggestion)
const DISCORD_SETTINGS = { watched: { "Robotics Club": { focus: ["electrical"] } } };

const discordInventory = {
  v: 1,
  type: "inventory",
  location: { guildId: G, channelId: CH },
  guilds: [{ guildId: G, name: "Robotics Club", unread: false, mentions: 0 }],
  channels: [
    { channelId: CH, guildId: G, name: "pcb-design", category: "ELECTRICAL", type: "text", order: 1, unread: false, mentions: 0, limited: false },
  ],
};

test("discord: a dated message yields a pending item; a scheduled event is an exact meeting", async () => {
  const parse = discordAdapter.observe.parse;
  const r1 = await parse(dom("discord", discordInventory, `https://discord.com/channels/${G}/${CH}`), makeCtx({}, { settings: DISCORD_SETTINGS }));

  const r2 = await parse(
    net("discord", `https://discord.com/api/v10/channels/${CH}/messages?limit=50`, [
      {
        id: "9101",
        channel_id: CH,
        guild_id: G,
        content: "BOM is due October 10 at 5pm",
        timestamp: "2026-10-01T19:00:00.000Z",
        type: 0,
        mentions: [],
        mention_roles: [],
        mention_everyone: false,
      },
    ]),
    makeCtx(r1.state, { settings: DISCORD_SETTINGS }),
  );
  const bom = r2.items.find((i) => /BOM/.test(i.title));
  assert.ok(bom, "a pending item from the dated message");
  assert.equal(bom.review, "pending");
  assert.equal(bom.dueAt, "2026-10-10T21:00:00.000Z");

  // The Events modal DOM extract -> scheduled-event items.
  const doc = parseHTML(fixture(DISCORD_DIR, "events-modal.html")).document;
  const extract = eventsModalExtract(doc, `https://discord.com/channels/${G}/2001`);
  const r3 = await parse(dom("discord", extract, `https://discord.com/channels/${G}/2001`), makeCtx(r2.state, { settings: DISCORD_SETTINGS }));
  const meetings = r3.items.filter((i) => i.type === "meeting");
  assert.ok(meetings.length > 0, "expected scheduled-event items");
  const rover = meetings.find((i) => /Rover/.test(i.title));
  assert.ok(rover, "the Interested card's meeting");
  assert.equal(rover.confidence, "exact");
  assert.equal(rover.review, "auto");
});

/* ------------------- 5. WaterlooWorks message dates -> pending ------------------- */

const WW = "https://waterlooworks.uwaterloo.ca/myAccount/co-op/full";

test("waterlooworks message detail yields a pending item in the merged view", async () => {
  const res = await wwAdapter.observe.parse(
    net("waterlooworks", `${WW}/messages.htm`, fixture(WW_DIR, "message-detail-dates.html")),
    makeCtx(),
  );
  const derived = res.items.filter((i) => i.meta?.messageKey);
  assert.equal(derived.length, 1);
  assert.equal(derived[0].review, "pending");

  const raw = applyResult(null, res, { mode: "scope", scope: res.scope });
  const { items } = recompute({ raws: { waterlooworks: raw }, now: NOW });
  const merged = Object.values(items).filter((i) => i.meta?.messageKey);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].dueAt, "2026-10-02T20:00:00.000Z");
});

/* ------------------- 6. ENGL 192 pdf text via adapterSettings ------------------- */

test("adapterSettings maps pdf text into outline files; sync yields 22 classes + 16 items", async () => {
  const text = fixture(OUTLINE_DIR, "ENGL192-syllabus.txt");
  const settings = adapterSettings(
    "outline",
    { sources: { outline: { enabled: true } } },
    {
      courses: [{ code: "ENGL 192", term: 1269, sections: ["LEC 008"] }],
      outlineFiles: [
        { id: "f1", name: "ENGL 192 syllabus.pdf", kind: "pdf", size: 1000, base64: "QUJD", text },
        { id: "f2", name: "scan.pdf", kind: "pdf", size: 10, base64: "AAAA" }, // no text: skipped
      ],
    },
  );
  assert.deepEqual(settings.files, [
    { name: "ENGL 192 syllabus.pdf", kind: "pdf", text },
  ]);

  const res = await outlineAdapter.sync(
    makeCtx({}, { settings, courses: [{ code: "ENGL 192", term: 1269, sections: ["LEC 008"] }] }),
  );
  assert.equal(res.complete, true);
  assert.equal(res.items.filter((i) => i.type === "class").length, 22);
  assert.equal(res.items.filter((i) => i.type !== "class").length, 16);
  assert.ok(res.readOk.includes("ENGL 192"));
});
