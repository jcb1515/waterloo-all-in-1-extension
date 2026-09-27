// @ts-check
// Guided mail scan wiring: the UI message constants exist and the adapter's
// start/stop helpers produce the state shape the panel reads.

import test from "node:test";
import assert from "node:assert/strict";
import { UI } from "../../extension/src/core/messages.js";
import { startMailScan, stopMailScan } from "../../extension/src/sources/email/index.js";

test("mail-scan UI messages are defined", () => {
  assert.equal(UI.MAIL_SCAN_START, "wa1:mail-scan-start");
  assert.equal(UI.MAIL_SCAN_STOP, "wa1:mail-scan-stop");
});

test("startMailScan: gmail returns a mail.google.com url; the state shape feeds the panel", () => {
  const r = startMailScan({}, { provider: "gmail", now: new Date("2026-01-19T16:00:00Z"), days: 60 });
  assert.match(r.url, /^https:\/\/mail\.google\.com\//);
  assert.equal(r.state.scan.provider, "gmail");
  assert.equal(r.state.scan.days, 60);
  assert.ok(r.state.scan.query, "query kept for the panel/status");
  assert.deepEqual(r.state.scanQueue, []);
});

test("startMailScan: outlook returns a paste-able query and no url", () => {
  const r = startMailScan({}, { provider: "outlook", now: new Date("2026-01-19T16:00:00Z") });
  assert.ok(!r.url, "Outlook has no search deeplink — the UI shows the query instead");
  assert.ok(r.query.length > 10);
  assert.equal(r.state.scan.provider, "outlook");
});

test("stopMailScan clears scan+queue but keeps scanned memory", () => {
  const started = startMailScan({}, { provider: "gmail" }).state;
  const withProgress = { ...started, scanQueue: [{ key: "k1", subject: "s", url: "u", provider: "gmail" }], scanned: { k0: "x" } };
  const stopped = stopMailScan(withProgress);
  assert.equal(stopped.scan, undefined);
  assert.equal(stopped.scanQueue, undefined);
  assert.deepEqual(stopped.scanned, { k0: "x" });
});
