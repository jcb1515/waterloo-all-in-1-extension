// @ts-check
// Application lifecycle correctness: every status transition produces
// exactly one bell update through observe.parse + diffApplications, and
// re-reading the same state produces none. Also: page-2/3 apps older
// than 7 days never ring "new", and an interview booking removes the
// job's open interview-timeslot task.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseHTML } from "linkedom";
import { extractDates } from "../../extension/src/lib/textdates/index.js";
import * as parsers from "../../extension/src/sources/waterlooworks/parsers.js";
import adapter from "../../extension/src/sources/waterlooworks/index.js";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "waterlooworks"
);
const WW = "https://waterlooworks.uwaterloo.ca/myAccount/co-op/full";
const NOW = new Date("2026-09-20T12:00:00.000Z");
const AT = NOW.toISOString();

const fixture = (name) => readFileSync(path.join(FIXTURES, name), "utf8");

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

const appsPayload = (html, at = AT) => ({
  source: "waterlooworks",
  kind: "net",
  url: `${WW}/applications.htm`,
  body: html,
  at,
});

const detailPayload = (name) => ({
  source: "waterlooworks",
  kind: "net",
  url: `${WW}/interviews.htm`,
  body: fixture(name),
  at: AT,
});

const APPS_HTML = fixture("applications.html");

/** Replace the App Status cell of the row whose Job ID is `jobId`. */
const setStatus = (html, jobId, status) =>
  html.replace(
    new RegExp(
      `(<td>${jobId}</td>[\\s\\S]*?<span class="table__value">)[^<]*(</span>)`
    ),
    `$1${status}$2`
  );

const readApps = (html, state, at) =>
  adapter.observe.parse(appsPayload(html, at), makeCtx(state));

/**
 * One transition: a starting-state read, the transition read (exactly one
 * "status" update with the replay-stable id), then a same-state reread
 * (no update at all).
 * @param {string} jobId
 * @param {string} fromText   WW cell text for the start state
 * @param {string} toText     WW cell text for the end state
 * @param {string} toStatus   contract status expected after the change
 * @param {string} label      STATUS_LABEL text expected in the update
 */
async function transition(jobId, fromText, toText, toStatus, label) {
  const first = await readApps(setStatus(APPS_HTML, jobId, fromText));
  assert.equal(first.updates.length, 0, "baseline read emits nothing");
  const second = await readApps(setStatus(APPS_HTML, jobId, toText), first.state);
  assert.deepEqual(
    second.updates.map((u) => u.id),
    [`waterlooworks:${jobId}:${toStatus}`]
  );
  assert.equal(second.updates[0].kind, "status");
  assert.match(second.updates[0].text, new RegExp(`^${label}: `));
  const third = await readApps(setStatus(APPS_HTML, jobId, toText), second.state);
  assert.equal(third.updates.length, 0, "re-reading the same state emits nothing");
}

test("applied -> not-selected: one bell update, none on reread", () =>
  transition("488135", "Applied", "Not Selected", "not-selected", "Not selected"));

test("applied -> selected-for-interview -> interview-scheduled", async () => {
  const first = await readApps(setStatus(APPS_HTML, "488135", "Applied"));
  const second = await readApps(
    setStatus(APPS_HTML, "488135", "Selected for Interview"),
    first.state
  );
  assert.deepEqual(
    second.updates.map((u) => u.id),
    ["waterlooworks:488135:selected-for-interview"]
  );
  const third = await readApps(
    setStatus(APPS_HTML, "488135", "Interview Scheduled"),
    second.state
  );
  assert.deepEqual(
    third.updates.map((u) => u.id),
    ["waterlooworks:488135:interview-scheduled"]
  );
  assert.equal(third.updates[0].text.slice(0, 16), "Interview booked");
  const fourth = await readApps(
    setStatus(APPS_HTML, "488135", "Interview Scheduled"),
    third.state
  );
  assert.equal(fourth.updates.length, 0);
});

test("selected-for-interview -> alternate", () =>
  transition("488310", "Selected for Interview", "Alternate", "alternate", "Alternate"));

test("selected-for-interview -> offer -> declined", async () => {
  const first = await readApps(setStatus(APPS_HTML, "488310", "Selected for Interview"));
  const second = await readApps(setStatus(APPS_HTML, "488310", "Offer"), first.state);
  assert.deepEqual(second.updates.map((u) => u.id), ["waterlooworks:488310:offer"]);
  const third = await readApps(
    setStatus(APPS_HTML, "488310", "Declined"),
    second.state
  );
  assert.deepEqual(third.updates.map((u) => u.id), ["waterlooworks:488310:declined"]);
  const fourth = await readApps(setStatus(APPS_HTML, "488310", "Declined"), third.state);
  assert.equal(fourth.updates.length, 0);
});

test("ranked -> matched", async () => {
  const first = await readApps(setStatus(APPS_HTML, "488135", "Ranked"));
  const second = await readApps(setStatus(APPS_HTML, "488135", "Matched"), first.state);
  assert.deepEqual(second.updates.map((u) => u.id), ["waterlooworks:488135:matched"]);
  const third = await readApps(setStatus(APPS_HTML, "488135", "Matched"), second.state);
  assert.equal(third.updates.length, 0);
});

test("applied -> withdrawn", () =>
  transition("488135", "Applied", "Withdrawn", "withdrawn", "Withdrawn"));

test("page-2 apps submitted >7 days ago seed silently (no 'new' flood)", async () => {
  const page1 = await readApps(fixture("applications-pending.html"));
  assert.equal(page1.updates.length, 0, "first read seeds silently");
  assert.equal(page1.state.applications.length, 3);

  // Same page-2 fixture, but both rows' submitted dates moved >7 days back:
  // first seeing them must produce NO "new" updates while still storing.
  const oldPage2 = fixture("applications-page2.html")
    .replace("Sep 15, 2026 4:12 PM", "Aug 01, 2026 4:12 PM")
    .replace("09/25/2026 12:01 PM", "08/02/2026 12:01 PM");
  const page2 = await readApps(oldPage2, page1.state);
  assert.equal(page2.state.applications.length, 5);
  assert.equal(
    page2.updates.length,
    0,
    "old first-seen apps emit no updates"
  );
  // …and their status history still seeded.
  for (const app of page2.state.applications.filter((a) =>
    ["611010", "611011"].includes(a.jobId)
  )) {
    assert.equal(app.history.length, 1);
    assert.equal(app.history[0].status, "applied");
  }
});

test("interview booking removes the open timeslot task for that job", async () => {
  const first = await adapter.observe.parse(
    detailPayload("interview-detail-unbooked.html"),
    makeCtx()
  );
  const timeslot = first.items.find(
    (i) => i.id === "waterlooworks:timeslot:400001"
  );
  assert.ok(timeslot, "unbooked detail produced the timeslot deadline");
  assert.equal(timeslot.type, "deadline");
  assert.equal(timeslot.category, "interview-timeslot");
  assert.equal(timeslot.status, "open");

  // The same job's detail now reads booked — the deadline is gone and a
  // real interview item exists.
  const second = await adapter.observe.parse(
    detailPayload("interview-detail-booked-400001.html"),
    makeCtx(first.state)
  );
  assert.ok(
    !second.items.some(
      (i) => i.id === "waterlooworks:timeslot:400001" && i.status === "open"
    ),
    "no open interview-timeslot task remains"
  );
  const interview = second.items.find(
    (i) => i.id === "waterlooworks:interview:400001"
  );
  assert.ok(interview, "a booked interview item exists for the job");
  assert.equal(interview.type, "interview");
});
