// @ts-check
// checkRunView — the CheckNowButton's view model over the checkRuns key.
import test from "node:test";
import assert from "node:assert/strict";
import {
  checkRunView,
  openTargetFor,
  CHECK_RUN_TIMEOUT_MS,
} from "../../extension/src/panel/model/sources.js";
import { siteUrlFor } from "../../extension/src/core/sites.js";

const NOW = new Date("2026-10-15T18:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const st = (runs, settings) => ({
  checkRuns: runs,
  settings: settings || { sources: {} },
});

test("no run -> idle, empty text", () => {
  const v = checkRunView(st({}), "learn", NOW);
  assert.equal(v.status, "idle");
  assert.equal(v.text, "");
});

test("running entry -> running + Checking…", () => {
  const v = checkRunView(
    st({ learn: { runId: "r", status: "running", startedAt: iso(NOW.getTime() - 5000) } }),
    "learn",
    NOW,
  );
  assert.equal(v.status, "running");
  assert.equal(v.text, "Checking…");
});

test("a run older than 90 s still marked running counts as timeout", () => {
  const v = checkRunView(
    st({
      learn: {
        runId: "r",
        status: "running",
        startedAt: iso(NOW.getTime() - CHECK_RUN_TIMEOUT_MS - 1000),
      },
    }),
    "learn",
    NOW,
  );
  assert.equal(v.status, "failed");
  assert.equal(v.reason, "timeout");
  assert.equal(v.text, "Didn't finish — try again");
});

test("ok run: counts + ago, parts omitted when absent", () => {
  const full = checkRunView(
    st({
      gmail: {
        runId: "r",
        status: "ok",
        checked: 50,
        newItems: 3,
        startedAt: iso(NOW.getTime() - 60000),
        endedAt: iso(NOW.getTime() - 30000),
      },
    }),
    "gmail",
    NOW,
  );
  assert.equal(full.status, "ok");
  assert.equal(full.text, "Checked 50 · 3 new · just now");

  const sparse = checkRunView(
    st({
      learn: {
        runId: "r",
        status: "ok",
        newItems: 0,
        startedAt: iso(NOW.getTime() - 200000),
        endedAt: iso(NOW.getTime() - 120000),
      },
    }),
    "learn",
    NOW,
  );
  assert.equal(sparse.text, "Checked · no new items · 2m ago");
});

test("signed-out -> label + Open url", () => {
  const v = checkRunView(
    st({ outlook: { runId: "r", status: "failed", reason: "signed-out", startedAt: iso(0) } }),
    "outlook",
    NOW,
  );
  assert.equal(v.status, "failed");
  assert.equal(v.reason, "signed-out");
  assert.equal(v.text, "Signed out of Outlook — ");
  assert.equal(v.openUrl, "https://outlook.office.com/mail/inbox");
});

test("not-on-page -> Open <label> to check; discord gets its own text", () => {
  const v = checkRunView(
    st({ portal: { runId: "r", status: "failed", reason: "not-on-page", startedAt: iso(0) } }),
    "portal",
    NOW,
  );
  assert.equal(v.text, "Open Portal to check");
  assert.equal(v.openUrl, "https://portal.uwaterloo.ca/");

  const d = checkRunView(
    st({ discord: { runId: "r", status: "failed", reason: "not-on-page", startedAt: iso(0) } }),
    "discord",
    NOW,
  );
  assert.equal(d.text, "Open a watched Discord channel, then check again");
  assert.equal(d.openUrl, null);
});

test("timeout / error / unsupported / disabled reasons", () => {
  const base = (reason) =>
    st({ learn: { runId: "r", status: "failed", reason, startedAt: iso(0) } });
  assert.equal(checkRunView(base("timeout"), "learn", NOW).text, "Didn't finish — try again");
  assert.equal(checkRunView(base("error"), "learn", NOW).text, "Couldn't check — try again");
  assert.equal(checkRunView(base("unsupported"), "learn", NOW).status, "unsupported");

  const off = checkRunView(
    st({}, { sources: { learn: { enabled: false } } }),
    "learn",
    NOW,
  );
  assert.equal(off.status, "disabled");
  assert.equal(off.text, "Turned off");
});

test("openTargetFor: row url wins, else siteUrlFor", () => {
  assert.equal(
    openTargetFor("portal", { url: "https://portal.uwaterloo.ca/schedule" }),
    "https://portal.uwaterloo.ca/schedule",
  );
  assert.equal(openTargetFor("outlook", null), siteUrlFor("outlook"));
  assert.equal(openTargetFor("outlook", { url: "mailto:x" }), siteUrlFor("outlook"));
});
