// @ts-check
// CP3 integration: the email adapter through the real observe path, email ->
// WaterlooWorks application linking, course-instructor merging, and the
// split optional-permission groups.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseHTML } from "linkedom";

import emailAdapter from "../../extension/src/sources/email/index.js";
import { extractFor } from "../../extension/src/sources/email/dom.js";
import { linkEmailItems, mergeCourses } from "../../extension/src/core/merge.js";
import {
  OPTIONAL_PERMISSION_GROUPS,
  scriptsForGrants,
} from "../../extension/src/core/permissions.js";
import { extractDates } from "../../extension/src/lib/textdates/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EMAIL_DIR = path.join(ROOT, "fixtures", "email");
const html = (name) => readFileSync(path.join(EMAIL_DIR, `${name}.html`), "utf8");

const NOW = new Date("2026-10-01T15:00:00.000Z");

const ctx = (extra = {}) => ({
  now: NOW,
  settings: {},
  state: {},
  courses: [],
  terms: [],
  log: () => {},
  textDates: extractDates,
  fetch: async () => ({ status: 0 }),
  relay: async () => ({ status: 0 }),
  parseHtml: async () => null,
  ...extra,
});

const payload = (source, data) => ({
  source,
  kind: /** @type {const} */ ("dom"),
  url: `https://${source === "gmail" ? "mail.google.com" : "outlook.office.com"}/mail`,
  body: JSON.stringify(data),
  at: NOW.toISOString(),
});

/* --------- 1. invite fixture -> exact meeting item --------- */

test("gmail message fixture -> exact meeting item through observe.parse", async () => {
  const doc = parseHTML(html("gmail-message")).document;
  const extract = extractFor(doc, "https://mail.google.com/mail/u/0/#inbox/thread-abc123");
  assert.equal(extract.provider, "gmail");
  assert.equal(extract.view, "message");

  const res = await emailAdapter.observe.parse(payload("gmail", extract), ctx());
  assert.equal(res.items.length, 1);
  const i = res.items[0];
  assert.equal(i.type, "meeting");
  assert.equal(i.title, "Robotics design review");
  assert.equal(i.confidence, "exact");
  assert.equal(i.review, "auto");
  assert.equal(i.startAt, "2026-10-06T22:00:00.000Z");
  assert.equal(i.location, "https://meet.google.com/abc-defg-hij");
});

/* --------- 2. important mail -> pending item with a snippet only --------- */

const mailMsg = (over = {}) => ({
  key: "k9",
  url: "https://outlook.office.com/mail/inbox/id/k9",
  from: "Talent Team",
  fromEmail: "recruiting@acme.example.com",
  subject: "Firmware Co-op interview",
  body: "Hello,\nYour interview is on October 20 at 2:00 PM. Bring your WatCard.",
  links: [],
  receivedAt: NOW.toISOString(),
  ...over,
});

const wrap = (provider, messages, view = "message", folder = "inbox") => ({
  v: 1,
  provider,
  folder,
  view,
  messages,
});

test("important mail -> pending interview item, snippet only (no body/email leak)", async () => {
  const res = await emailAdapter.observe.parse(
    payload("outlook", wrap("outlook", [mailMsg()])),
    ctx(),
  );
  assert.equal(res.items.length, 1);
  const i = res.items[0];
  assert.equal(i.type, "interview");
  assert.equal(i.review, "pending");
  assert.equal(i.confidence, "tentative");
  assert.equal(i.meta.employer, "acme");
  assert.match(i.evidence.snippet || "", /interview is on October 20/);
  const blob = JSON.stringify(res);
  assert.ok(!blob.includes("recruiting@acme"), "sender email must not leak");
  assert.ok(!blob.includes("Bring your WatCard"), "body beyond the sentence must not leak");
});

/* --------- 3. email interview -> WaterlooWorks application link --------- */

const app = (jobId, employer, jobTitle) => ({
  id: `waterlooworks:${jobId}`,
  jobId,
  employer,
  jobTitle,
  status: "applied",
  history: [],
  itemIds: [],
});

test("linkEmailItems: an email interview links to the matching application", async () => {
  const res = await emailAdapter.observe.parse(
    payload("outlook", wrap("outlook", [mailMsg()])),
    ctx(),
  );
  const item = res.items[0];
  const apps = { "waterlooworks:111": app("111", "Acme", "Firmware Co-op") };
  const out = linkEmailItems({ [item.id]: item }, apps);
  assert.equal(out.items[item.id].meta.applicationId, "waterlooworks:111");
  assert.deepEqual(out.applications["waterlooworks:111"].itemIds, [item.id]);
});

test("linkEmailItems: no employer match -> no link", () => {
  const item = {
    id: "outlook:mail:k9:x",
    source: "outlook",
    type: "interview",
    title: "Firmware Co-op interview",
    meta: { employer: "acme" },
  };
  const apps = { "waterlooworks:1": app("1", "Globex", "Firmware Co-op") };
  const out = linkEmailItems({ [item.id]: item }, apps);
  assert.equal(out.items[item.id].meta.applicationId, undefined);
  assert.deepEqual(out.applications["waterlooworks:1"].itemIds, []);
});

test("linkEmailItems: two same-employer apps and no title tokens -> ambiguous, no link", () => {
  const item = {
    id: "outlook:mail:k9:y",
    source: "outlook",
    type: "interview",
    title: "Your interview",
    meta: { employer: "acme" },
  };
  const apps = {
    "waterlooworks:1": app("1", "Acme", "Firmware Co-op"),
    "waterlooworks:2": app("2", "Acme", "Electrical Co-op"),
  };
  const out = linkEmailItems({ [item.id]: item }, apps);
  assert.equal(out.items[item.id].meta.applicationId, undefined);
  assert.deepEqual(out.applications["waterlooworks:1"].itemIds, []);
  assert.deepEqual(out.applications["waterlooworks:2"].itemIds, []);
});

test("linkEmailItems: non-email sources and non-coop types are ignored", () => {
  const item = {
    id: "waterlooworks:x",
    source: "waterlooworks",
    type: "interview",
    title: "Firmware Co-op interview",
    meta: { employer: "acme" },
  };
  const apps = { "waterlooworks:1": app("1", "Acme", "Firmware Co-op") };
  const out = linkEmailItems({ [item.id]: item }, apps);
  assert.equal(out.items[item.id], item); // untouched
});

/* --------- 4. course instructors merge --------- */

test("mergeCourses unions instructors by name+section", () => {
  const courses = mergeCourses({
    portal: {
      courses: [
        {
          code: "ECE 105",
          term: 1269,
          instructors: [
            { name: "Jane Smith", email: "jsmith@uwaterloo.ca", section: "LEC 001" },
          ],
        },
      ],
    },
    learn: {
      courses: [
        {
          code: "ECE 105",
          term: 1269,
          instructors: [
            { name: "JANE SMITH", section: "LEC 001" }, // same person, no email
            { name: "Bob Jones", section: "LAB 203" },
            { name: "Jane Smith", section: "LEC 002" }, // distinct section stays
          ],
        },
      ],
    },
  });
  const ece = courses["ECE 105"];
  assert.ok(ece);
  assert.equal(ece.instructors.length, 3);
  const lec1 = ece.instructors.find((i) => i.section === "LEC 001");
  assert.equal(lec1.name, "Jane Smith");
  assert.equal(lec1.email, "jsmith@uwaterloo.ca"); // kept from the first record
  assert.ok(ece.instructors.some((i) => i.name === "Bob Jones" && i.section === "LAB 203"));
  assert.ok(ece.instructors.some((i) => i.name === "Jane Smith" && i.section === "LEC 002"));
});

/* --------- 5. split permission groups --------- */

test("scriptsForGrants: outlook-only, gmail-only and both", () => {
  const outlookOnly = scriptsForGrants(OPTIONAL_PERMISSION_GROUPS.outlook);
  assert.equal(outlookOnly.length, 2);
  assert.ok(outlookOnly.every((s) => s.id.endsWith(":outlook")));
  assert.ok(outlookOnly.every((s) => s.matches.every((m) => m.includes("outlook"))));

  const gmailOnly = scriptsForGrants(OPTIONAL_PERMISSION_GROUPS.gmail);
  assert.equal(gmailOnly.length, 2);
  assert.ok(gmailOnly.every((s) => s.id.endsWith(":gmail")));
  assert.ok(gmailOnly.every((s) => s.matches.every((m) => m.includes("mail.google.com"))));

  const both = scriptsForGrants([
    ...OPTIONAL_PERMISSION_GROUPS.outlook,
    ...OPTIONAL_PERMISSION_GROUPS.gmail,
  ]);
  assert.equal(both.length, 4);
  assert.ok(both.every((s) => s.js.includes("src/sources/email/content.js") || s.js.includes("src/capture/observer.main.js")));
});
