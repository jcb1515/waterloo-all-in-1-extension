// @ts-check
// WaterlooWorks probe: exact counts per fixture, degraded-page hints,
// and the no-text/no-names privacy guarantee.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseHTML } from "linkedom";
import {
  probe,
  CHECKLIST,
} from "../../extension/src/sources/waterlooworks/probe.js";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "waterlooworks"
);
const WW = "https://waterlooworks.uwaterloo.ca/myAccount/co-op/full";
const doc = (name) => parseHTML(readFileSync(path.join(FIXTURES, name), "utf8")).document;

test("applications page counts rows, status and deadlines", () => {
  const r = probe(doc("applications.html"), `${WW}/applications.htm`);
  assert.equal(r.page, "applications");
  assert.equal(r.ok, true);
  assert.deepEqual(r.counts, {
    tables: 1,
    rows: 3,
    withStatus: 3,
    withDeadline: 3,
  });
  assert.deepEqual(r.hints, []);
});

test("empty applications grid is not ok and hints the user", () => {
  const r = probe(doc("applications-empty.html"), `${WW}/applications.htm`);
  assert.equal(r.page, "applications");
  assert.equal(r.ok, false);
  assert.equal(r.counts.rows, 0);
  assert.equal(r.counts.tables, 1); // the header row is still there
  assert.ok(r.hints.length > 0);
});

test("interviews page counts rows and datetimes", () => {
  const r = probe(doc("interviews.html"), `${WW}/interviews.htm`);
  assert.equal(r.page, "interviews");
  assert.deepEqual(r.counts, { rows: 3, withDateTime: 3 });
  assert.equal(r.ok, true);
});

test("interview detail counts fields and slot availability", () => {
  const booked = probe(
    doc("interview-detail-booked.html"),
    `${WW}/interviews.htm`
  );
  assert.equal(booked.page, "interview-detail");
  assert.deepEqual(booked.counts, { fields: 13, slots: 2, availableSlots: 0 });
  assert.equal(booked.ok, true);
  assert.deepEqual(booked.hints, []); // booked: missing slots are normal

  const unbooked = probe(
    doc("interview-detail-unbooked.html"),
    `${WW}/interviews.htm`
  );
  assert.deepEqual(unbooked.counts, { fields: 9, slots: 3, availableSlots: 2 });

  const otherJob = probe(
    doc("interview-detail-booked-400001.html"),
    `${WW}/interviews.htm`
  );
  assert.deepEqual(otherJob.counts, {
    fields: 9,
    slots: 0,
    availableSlots: 0,
  });
});

test("posting pages count fields and the deadline field", () => {
  for (const [name, fields] of [
    ["posting.html", 17],
    ["posting-divs.html", 6],
    ["posting-past.html", 2],
  ]) {
    const r = probe(doc(name), `${WW}/jobs.htm`);
    assert.equal(r.page, "posting", name);
    assert.deepEqual(r.counts, { fields, deadline: 1 });
    assert.equal(r.ok, true);
  }
});

test("dashboard counts event rows", () => {
  assert.deepEqual(probe(doc("dashboard.html"), "").counts, { eventRows: 1 });
  assert.equal(probe(doc("dashboard.html"), "").page, "dashboard");
  assert.deepEqual(probe(doc("events.html"), "").counts, { eventRows: 3 });
});

test("messages inbox and message detail", () => {
  const inbox = probe(doc("messages.html"), `${WW}/messages.htm`);
  assert.equal(inbox.page, "messages");
  assert.deepEqual(inbox.counts, { rows: 2 });
  for (const name of ["message-detail.html", "message-detail-dates.html"]) {
    const r = probe(doc(name), `${WW}/messages.htm`);
    assert.equal(r.page, "message-detail", name);
    assert.deepEqual(r.counts, { subject: 1, body: 1 });
  }
});

test("rankings page counts the notice", () => {
  const r = probe(
    doc("rankings-closed.html"),
    "https://waterlooworks.uwaterloo.ca/myAccount/co-op/rankings.htm"
  );
  assert.equal(r.page, "rankings");
  assert.deepEqual(r.counts, { notice: 1 });
  assert.equal(r.ok, true);
});

test("signed-out page is not ok and tells the user to sign in", () => {
  const r = probe(
    doc("not-logged-in.html"),
    "https://waterlooworks.uwaterloo.ca/notLoggedIn.htm"
  );
  assert.equal(r.page, "signed-out");
  assert.equal(r.ok, false);
  assert.deepEqual(r.counts, {});
  assert.ok(r.hints.some((h) => /sign in/i.test(h)));
});

test("unknown/empty/garbage docs never throw and report unknown", () => {
  for (const bad of [
    doc("applications-missing.html"), // no recognised structure
    doc("coop-important-dates.html"), // not a WaterlooWorks page
    parseHTML("").document, // empty
    parseHTML("garbage text").document,
    null,
    undefined,
    {},
  ]) {
    const r = probe(bad, "");
    assert.equal(r.page, "unknown");
    assert.equal(r.ok, false);
    assert.deepEqual(r.counts, {});
    assert.ok(r.hints.length > 0);
  }
});

test("probe output carries no page text — counts only", () => {
  for (const name of [
    "applications.html",
    "interviews.html",
    "interview-detail-booked.html",
    "posting.html",
    "message-detail.html",
    "messages.html",
    "dashboard.html",
  ]) {
    const r = probe(doc(name), "");
    const json = JSON.stringify(r);
    for (const secret of [
      "Globex",
      "Analog/Mixed-Signal",
      "Pat Example",
      "Cycle 1 applications due",
      "Casey Advisor",
      "confidential",
      "Virtual Room",
    ]) {
      assert.ok(!json.includes(secret), `${name} leaked "${secret}"`);
    }
    for (const v of Object.values(r.counts)) {
      assert.equal(typeof v, "number");
    }
  }
});

test("CHECKLIST is a list of {id, label, how} entries", () => {
  assert.ok(CHECKLIST.length >= 8);
  for (const item of CHECKLIST) {
    assert.ok(item.id && item.label && item.how);
  }
});
