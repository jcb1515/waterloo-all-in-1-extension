// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeStatus, STATUS_LABEL } from "../../extension/src/sources/waterlooworks/status.js";

test("normalizeStatus maps not-selected variants before interview hits", () => {
  assert.equal(normalizeStatus("Not Selected for Interview"), "not-selected");
  assert.equal(normalizeStatus("unsuccessful"), "not-selected");
  assert.equal(normalizeStatus("Application Rejected"), "not-selected");
  assert.equal(normalizeStatus("not offered"), "not-selected");
  assert.equal(normalizeStatus("No longer under consideration"), "not-selected");
});

test("normalizeStatus maps withdrawn and declined", () => {
  assert.equal(normalizeStatus("Withdrawn"), "withdrawn");
  assert.equal(normalizeStatus("Withdrew application"), "withdrawn");
  assert.equal(normalizeStatus("Cancelled by student"), "withdrawn");
  assert.equal(normalizeStatus("Offer Declined"), "declined");
  assert.equal(normalizeStatus("Declined"), "declined");
});

test("normalizeStatus maps interview states in the right order", () => {
  assert.equal(normalizeStatus("Interview Scheduled"), "interview-scheduled");
  assert.equal(normalizeStatus("Interview Booked"), "interview-scheduled");
  assert.equal(normalizeStatus("interview confirmed"), "interview-scheduled");
  assert.equal(normalizeStatus("Selected for Interview"), "selected-for-interview");
  assert.equal(normalizeStatus("Interview Selected - Not Scheduled"), "selected-for-interview");
  assert.equal(normalizeStatus("Granted Interview"), "selected-for-interview");
  assert.equal(normalizeStatus("Selected to Interview"), "selected-for-interview");
});

test("normalizeStatus maps the remaining states", () => {
  assert.equal(normalizeStatus("Alternate"), "alternate");
  assert.equal(normalizeStatus("Matched"), "matched");
  assert.equal(normalizeStatus("Employed"), "matched");
  assert.equal(normalizeStatus("Ranked"), "ranked");
  assert.equal(normalizeStatus("Offer"), "offer");
  assert.equal(normalizeStatus("Offered"), "offer");
  assert.equal(normalizeStatus("Job Offer"), "offer");
  assert.equal(normalizeStatus("Applied"), "applied");
  assert.equal(normalizeStatus("Submitted"), "applied");
  assert.equal(normalizeStatus("Under Review"), "applied");
  assert.equal(normalizeStatus("In Progress"), "applied");
});

test("normalizeStatus handles punctuation, whitespace and junk", () => {
  assert.equal(normalizeStatus("  ** Not Selected! **  "), "not-selected");
  assert.equal(normalizeStatus("Matched  "), "matched");
  assert.equal(normalizeStatus(""), "unknown");
  assert.equal(normalizeStatus("???"), "unknown");
  assert.equal(normalizeStatus(null), "unknown");
  assert.equal(normalizeStatus(undefined), "unknown");
  assert.equal(normalizeStatus(42), "unknown");
});

test("STATUS_LABEL covers every ApplicationStatus", () => {
  const statuses = [
    "applied", "not-selected", "selected-for-interview", "interview-scheduled",
    "alternate", "offer", "ranked", "matched", "declined", "withdrawn", "unknown"
  ];
  for (const status of statuses) assert.ok(STATUS_LABEL[status], `missing ${status}`);
  assert.equal(STATUS_LABEL["selected-for-interview"], "Interview invite");
  assert.equal(STATUS_LABEL["interview-scheduled"], "Interview booked");
});
