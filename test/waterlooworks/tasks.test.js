// @ts-check
// Shared task seam: meta.action / meta.employer on derived to-dos —
// timeslot booking, respond-to-offer message dates, submit-rankings,
// shortlist apply deadlines and dashboard submit-document notices.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseHTML } from "linkedom";
import { extractDates } from "../../extension/src/lib/textdates/index.js";
import * as parsers from "../../extension/src/sources/waterlooworks/parsers.js";
import {
  interviewDetailItems,
  messageDateItems,
  noticeItems,
  rankingsTaskItems,
  applyItems,
} from "../../extension/src/sources/waterlooworks/map.js";
import adapter from "../../extension/src/sources/waterlooworks/index.js";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "waterlooworks"
);
const NOW = new Date("2026-09-20T12:00:00.000Z");
const NOW_ISO = NOW.toISOString();
const fixture = (name) => readFileSync(path.join(FIXTURES, name), "utf8");

const doc = (name) => parseHTML(fixture(name)).document;

// --- timeslot: book-interview + employer -------------------------------

test("timeslot task carries book-interview + employer from the detail", () => {
  const [item] = interviewDetailItems(
    {
      ok: true,
      jobId: "161616",
      jobTitle: "Firmware Engineering Co-op",
      employer: "Northbay  Software",
      booked: false,
      slots: [
        { state: "available", startAt: "2026-10-05T15:00:00.000Z" },
        { state: "booked", startAt: "2026-10-06T15:00:00.000Z" },
      ],
    },
    NOW
  );
  assert.equal(item.type, "deadline");
  assert.equal(item.meta.action, "book-interview");
  assert.equal(item.meta.employer, "Northbay  Software"); // as WW shows it
});

test("timeslot employer falls back to the stored application", () => {
  const [item] = interviewDetailItems(
    {
      ok: true,
      jobId: "161616",
      jobTitle: "Firmware Engineering Co-op",
      booked: false,
      slots: [{ state: "available", startAt: "2026-10-05T15:00:00.000Z" }],
    },
    NOW,
    { apps: [{ jobId: "161616", employer: "Northbay Software" }] }
  );
  assert.equal(item.meta.employer, "Northbay Software");
  assert.equal(item.org, undefined); // detail itself had no employer
});

// --- respond-offer ------------------------------------------------------

const offerMsg = {
  subject: "Job Offer - Northbay Software",
  sentAt: "2026-09-18T14:00:00.000Z",
  text: "Please respond to your job offer by October 10, 2026.",
  url: "https://waterlooworks.uwaterloo.ca/x",
  category: "Offers",
  employer: "Northbay Software",
  jobId: "161616",
};

test("an offer message with a response deadline emits respond-offer", () => {
  const items = messageDateItems(offerMsg, extractDates, NOW_ISO);
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.type, "deadline");
  assert.equal(item.title, "Respond to offer — Northbay Software");
  assert.equal(item.meta.action, "respond-offer");
  assert.equal(item.meta.employer, "Northbay Software");
  assert.equal(item.meta.jobId, "161616");
  assert.match(item.dueAt, /^2026-10-10/);
  assert.equal(item.startAt, undefined); // deadline anchored on dueAt only
});

test("an offer message with no date emits nothing", () => {
  const items = messageDateItems(
    { ...offerMsg, text: "You have a job offer waiting." },
    extractDates,
    NOW_ISO
  );
  assert.equal(items.length, 0);
});

test("a non-offer message with a date stays a generic item", () => {
  const items = messageDateItems(
    {
      ...offerMsg,
      subject: "Interview scheduled",
      category: "Interviews",
      text: "Your interview is on October 12, 2026.",
    },
    extractDates,
    NOW_ISO
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].meta.action, undefined);
});

// --- submit-rankings ----------------------------------------------------

const inFlightApp = (cycle, status = "selected-for-interview") => ({
  jobId: "1",
  cycle,
  status,
});
const rankingsDue = (workTerm, dueAt) => ({
  type: "cycle-date",
  category: "rankings-due",
  dueAt,
  meta: { workTerm },
});

test("one rankings task per in-flight term, due from the coop-date", () => {
  const items = rankingsTaskItems(
    {
      applications: [
        inFlightApp("2027 - Winter"),
        { jobId: "2", cycle: "2027 - Winter", status: "applied" },
      ],
      cycleItems: [
        rankingsDue("Winter 2027", "2026-11-20T05:00:00.000Z"),
        rankingsDue("Winter 2027", "2026-11-25T05:00:00.000Z"),
      ],
      rankings: { term: "2027 - Winter", open: false },
    },
    NOW
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "waterlooworks:rankings:winter-2027");
  assert.equal(items[0].type, "deadline");
  assert.equal(items[0].title, "Submit your rankings — Winter 2027");
  assert.equal(items[0].dueAt, "2026-11-20T05:00:00.000Z"); // earliest
  assert.equal(items[0].org, "Co-op");
  assert.equal(items[0].meta.action, "submit-rankings");
  assert.equal(items[0].meta.employer, "Co-op");
  assert.equal(items[0].meta.workTerm, "Winter 2027");
});

test("apps in two terms produce two rankings tasks", () => {
  const items = rankingsTaskItems(
    {
      applications: [
        inFlightApp("2027 - Winter"),
        { jobId: "2", cycle: "2027 - Spring", status: "offer" },
      ],
      cycleItems: [
        rankingsDue("Winter 2027", "2026-11-20T05:00:00.000Z"),
        rankingsDue("Spring 2027", "2027-03-01T05:00:00.000Z"),
      ],
    },
    NOW
  );
  assert.equal(items.length, 2);
});

test("no in-flight app or a ranked/matched app yields no rankings task", () => {
  assert.equal(
    rankingsTaskItems(
      { applications: [{ jobId: "1", cycle: "2027 - Winter", status: "applied" }] },
      NOW
    ).length,
    0
  );
  assert.equal(
    rankingsTaskItems(
      {
        applications: [
          inFlightApp("2027 - Winter"),
          { jobId: "2", cycle: "2027 - Winter", status: "ranked" },
        ],
        cycleItems: [rankingsDue("Winter 2027", "2026-11-20T05:00:00.000Z")],
      },
      NOW
    ).length,
    0
  );
});

test("open rankings without a coop-date fall back to the undated rule", () => {
  const items = rankingsTaskItems(
    {
      applications: [inFlightApp("2027 - Winter")],
      cycleItems: [],
      rankings: {
        term: "2027 - Winter",
        open: true,
        at: "2026-09-20T12:00:00.000Z",
      },
    },
    NOW
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "task");
  assert.equal(items[0].meta.undated, true);
  // anchor Sep 20 + 2d at 17:00 Toronto = Sep 22 21:00Z (EDT).
  assert.equal(items[0].dueAt, "2026-09-22T21:00:00.000Z");
});

// --- shortlist / apply --------------------------------------------------

test("parseShortlist reads the shortlist grid under its own marker", () => {
  const parsed = parsers.parseAll(doc("shortlist.html"), {
    url: "https://waterlooworks.uwaterloo.ca/myAccount/co-op/full/jobs.htm",
  });
  assert.equal(parsed.page, "shortlist");
  assert.equal(parsed.shortlist.rows.length, 4);
  assert.equal(parsed.shortlist.rows[0].jobId, "161616");
  assert.equal(parsed.shortlist.rows[0].employer, "Northbay Software");
  assert.match(parsed.shortlist.rows[0].appDeadline || "", /^2026-09-30/);
});

test("a generic job grid with an inactive Shortlist tab yields nothing", () => {
  const parsed = parsers.parseAll(doc("job-search-not-shortlist.html"), {
    url: "https://waterlooworks.uwaterloo.ca/myAccount/co-op/full/jobs.htm",
  });
  assert.notEqual(parsed.page, "shortlist");
  assert.equal(parsed.shortlist, undefined);
  assert.equal(parsers.parseShortlist(doc("job-search-not-shortlist.html")).rows.length, 0);
});

test("applyItems: future deadlines only, applied jobs skipped", () => {
  const rows = parsers.parseShortlist(doc("shortlist.html")).rows;
  const items = applyItems(rows, [{ jobId: "161619", status: "applied" }], NOW);
  assert.deepEqual(
    items.map((i) => i.meta.jobId),
    ["161616", "161617"]
  );
  const [first] = items;
  assert.equal(first.id, "waterlooworks:apply:161616");
  assert.equal(first.type, "deadline");
  assert.equal(first.meta.category, "apply");
  assert.equal(first.meta.action, "apply");
  assert.equal(first.title, "Apply: Firmware Engineering Co-op — Northbay Software");
  assert.equal(first.meta.employer, "Northbay Software"); // collapsed space
});

// --- dashboard notices: submit-document --------------------------------

test("noticeItems emits a submit-document deadline only on doc+due+date", () => {
  const dash = parsers.parseDashboard(doc("dashboard-notices.html"));
  assert.ok(dash.notices.length >= 3);
  const items = noticeItems(dash.notices, extractDates, NOW_ISO);
  assert.equal(items.length, 1);
  const [item] = items;
  assert.equal(item.type, "deadline");
  assert.equal(item.title, "Work Term Report");
  assert.equal(item.org, "Co-op");
  assert.equal(item.meta.action, "submit-document");
  assert.equal(item.meta.employer, "Co-op");
  assert.match(item.dueAt, /^2026-10-15/);
  assert.match(item.id, /^waterlooworks:notice:[0-9a-f]+$/);
});

test("notice negatives: video post, study-term alert, rankings closed", () => {
  const items = noticeItems(
    [
      { heading: "Navigating Interview Processes", text: "Posted May 22, 2026" },
      { heading: "Student is on a 'Study' Term", text: "Student is on a 'Study' Term" },
      {
        heading: "RANKING (2027 - Winter)",
        text: "Rankings are not open at this time. Visit the calendar to see when rankings will be open.",
      },
      { heading: "Reminder", text: "Forms are fun." }, // doc noun, no due cue
      { heading: "Report due soon", text: "Your report is due soon." }, // no date
    ],
    extractDates,
    NOW_ISO
  );
  assert.equal(items.length, 0);
});

// --- adapter-level: notices + shortlist + readOk scopes ------------------

const AT = NOW_ISO;
function makeCtx(state = {}) {
  return {
    state,
    now: NOW,
    settings: {},
    async parseHtml(html, name, opts) {
      return parsers[name.split("/")[1]](parseHTML(html).document, opts);
    },
    textDates: extractDates,
    log() {},
  };
}
const domPayload = (name, url) => ({
  source: "waterlooworks",
  kind: "dom",
  url,
  body: fixture(name),
  at: AT,
});

test("complete dashboard snapshot stores notice items + page readOk scope", async () => {
  const result = await adapter.observe.parse(
    domPayload(
      "dashboard-notices.html",
      "https://waterlooworks.uwaterloo.ca/myAccount/dashboard.htm"
    ),
    makeCtx()
  );
  assert.equal(result.complete, true);
  assert.ok(result.readOk.includes("waterlooworks:dashboard"));
  const notice = result.items.find((i) => i.meta?.action === "submit-document");
  assert.ok(notice);
  assert.equal(notice.title, "Work Term Report");
});

test("shortlist snapshot emits apply deadlines, hides applied + superseded posting deadline", async () => {
  const ctx = makeCtx({
    applications: [
      { id: "waterlooworks:161619", jobId: "161619", status: "applied" },
    ],
    lastGood: {
      posting: {
        items: [
          {
            id: "waterlooworks:deadline:161616",
            source: "waterlooworks",
            type: "deadline",
            title: "Posting deadline",
            dueAt: "2026-09-30T04:00:00.000Z",
            meta: { jobId: "161616" },
          },
        ],
        at: AT,
      },
    },
  });
  const result = await adapter.observe.parse(
    domPayload(
      "shortlist.html",
      "https://waterlooworks.uwaterloo.ca/myAccount/co-op/full/jobs.htm"
    ),
    ctx
  );
  assert.ok(result.readOk.includes("waterlooworks:shortlist"));
  const applyIds = result.items
    .filter((i) => i.meta?.action === "apply")
    .map((i) => i.meta.jobId)
    .sort();
  assert.deepEqual(applyIds, ["161616", "161617"]); // 161618 past, 161619 applied
  // The viewed-posting deadline for 161616 is superseded by the apply task.
  assert.equal(
    result.items.find((i) => i.id === "waterlooworks:deadline:161616"),
    undefined
  );
});

test("counts-only landings report their page scope", async () => {
  const apps = await adapter.observe.parse(
    domPayload(
      "applications-landing.html",
      "https://waterlooworks.uwaterloo.ca/myAccount/co-op/full/applications.htm"
    ),
    makeCtx()
  );
  assert.equal(apps.complete, true);
  assert.ok(apps.readOk.includes("waterlooworks:applications"));

  const iv = await adapter.observe.parse(
    domPayload(
      "interviews-landing.html",
      "https://waterlooworks.uwaterloo.ca/myAccount/co-op/full/interviews.htm"
    ),
    makeCtx()
  );
  assert.equal(iv.complete, true);
  assert.ok(iv.readOk.includes("waterlooworks:interviews"));
});

test("a complete snapshot of an empty list still reports the page scope", async () => {
  const result = await adapter.observe.parse(
    {
      source: "waterlooworks",
      kind: "dom",
      url: "https://waterlooworks.uwaterloo.ca/myAccount/co-op/full/applications.htm",
      body: `<html data-wa1-complete="1"><body>${fixture(
        "applications-empty.html"
      )}</body></html>`,
      at: AT,
    },
    makeCtx()
  );
  assert.equal(result.complete, true);
  assert.ok(result.readOk.includes("waterlooworks:applications"));
  assert.deepEqual(result.applications, []);
});

test("an incomplete snapshot emits no per-page readOk scopes", async () => {
  const result = await adapter.observe.parse(
    {
      source: "waterlooworks",
      kind: "dom",
      url: "https://waterlooworks.uwaterloo.ca/myAccount/dashboard.htm",
      body: fixture("dashboard-notices.html").replace(
        'data-wa1-complete="1"',
        'data-wa1-complete="0"'
      ),
      at: AT,
    },
    makeCtx()
  );
  assert.equal(result.complete, false);
  assert.equal(result.readOk, undefined);
});
