// @ts-check
// Email reader probe: page detection, selector counts, ok flags, hints and
// the privacy rule (counts only — never text).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { probe, CHECKLIST } from "../../extension/src/sources/email/probe.js";
import { extractFor } from "../../extension/src/sources/email/dom.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "email");
const html = (name) => fs.readFileSync(path.join(DIR, `${name}.html`), "utf8");
const docOf = (name) => parseHTML(html(name)).document;

const GM = "https://mail.google.com/mail/u/0/";
const OWA = "https://outlook.office.com/mail/";

const FIXTURES = [
  { name: "gmail-list", url: GM + "#inbox", page: "gmail-list" },
  { name: "gmail-message", url: GM + "#inbox/thread-abc123", page: "gmail-message" },
  { name: "gmail-invite-card", url: GM + "#inbox/inv001", page: "gmail-message" },
  { name: "gmail-thread-ask", url: GM + "#inbox/thr-ask", page: "gmail-message" },
  { name: "gmail-thread-reply", url: GM + "#inbox/thr-ask", page: "gmail-message" },
  { name: "outlook-list", url: OWA + "inbox", page: "outlook-list" },
  { name: "outlook-message", url: OWA + "inbox/id/conv-out-1", page: "outlook-message" },
  { name: "outlook-invite-card", url: "https://outlook.cloud.microsoft/mail/inbox/id/conv-inv", page: "outlook-message" },
];

test("probe: page kind and ok on every email fixture", () => {
  for (const f of FIXTURES) {
    const doc = docOf(f.name);
    const r = probe(doc, f.url);
    assert.equal(r.page, f.page, f.name);
    assert.equal(r.ok, true, f.name);
    const ex = extractFor(doc, f.url);
    if (f.page === "gmail-list") {
      assert.equal(r.counts.listRows, ex.messages.length, f.name);
      assert.equal(r.counts.threadIds, ex.messages.length, f.name);
    }
    if (f.page === "outlook-list") {
      assert.equal(r.counts.listRows, ex.messages.length, f.name);
      assert.ok(r.counts.rowsAny >= r.counts.listRows, f.name);
    }
    if (f.page === "gmail-message") {
      assert.equal(r.counts.messages, ex.messages.length, f.name);
      assert.ok(r.counts.messageBody >= 1, f.name);
    }
    if (f.page === "outlook-message") {
      assert.equal(r.counts.messageBody, 1, f.name);
    }
  }
});

test("probe: inviteCard count only on the two card fixtures", () => {
  for (const f of FIXTURES) {
    const r = probe(docOf(f.name), f.url);
    const want = /invite-card/.test(f.name) ? 1 : 0;
    if (f.page.endsWith("-message")) {
      assert.equal(r.counts.inviteCard, want, f.name);
    }
  }
});

test("probe: account detected only where the account button exists", () => {
  for (const f of FIXTURES) {
    const r = probe(docOf(f.name), f.url);
    const want = /thread-(ask|reply)/.test(f.name) ? 1 : 0;
    assert.equal(r.counts.account, want, f.name);
  }
});

test("probe: empty docs and garbage fail soft with hints", () => {
  const { document: empty } = parseHTML("<html><body></body></html>");
  for (const url of [GM + "#inbox", OWA + "inbox", "https://outline.uwaterloo.ca/viewer/view/x"]) {
    const r = probe(empty, url);
    assert.equal(r.ok, false, url);
    assert.ok(r.hints.length > 0, url);
  }
  const r = probe(null, "not a url");
  assert.equal(r.page, "unknown");
  assert.equal(r.ok, false);
  assert.deepEqual(r.counts, {});
});

test("probe: results are counts only — no text, names or addresses", () => {
  const secrets = [
    "jane.student@example.com",
    "jsmith@uwaterloo.ca",
    "@",
    "Robotics design review",
    "Jane Student",
    "Jane Smith",
    "Jane Doe",
    "Lab sections",
    "Team sync",
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
    "gmail-list", "gmail-message", "gmail-other",
    "outlook-list", "outlook-message", "outlook-other", "unknown",
  ]);
  for (const c of CHECKLIST) {
    assert.ok(!ids.has(c.id), c.id);
    ids.add(c.id);
    assert.ok(c.label.length > 0, c.id);
    assert.ok(c.how.length > 0, c.id);
    assert.ok(pages.has(c.page), c.id);
  }
});
