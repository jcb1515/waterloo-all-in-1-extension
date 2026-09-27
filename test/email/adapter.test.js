// @ts-check
// Email adapter: pure Msg -> items rules, adapter observe routing, DOM
// extracts on synthetic fixtures, and the no-network static rules.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import adapter from "../../extension/src/sources/email/index.js";
import { extractFor } from "../../extension/src/sources/email/dom.js";
import { itemsFromMessage } from "../../extension/src/sources/email/extract.js";
import { extractDates } from "../../extension/src/lib/textdates/index.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "email");
const html = (name) => fs.readFileSync(path.join(DIR, `${name}.html`), "utf8");
const NOW = new Date("2026-10-01T15:00:00.000Z");
const RECV = "2026-10-01T15:00:00.000Z";

const msg = (over) => ({
  key: "k1",
  url: "https://mail.google.com/mail/u/0/#inbox/k1",
  from: "",
  fromEmail: "",
  subject: "",
  links: [],
  receivedAt: RECV,
  ...over,
});

const items = (m, over = {}) =>
  itemsFromMessage(m, {
    provider: m.provider || "gmail",
    now: NOW,
    termCode: 1269,
    textDates: extractDates,
    courses: [],
    settings: {},
    at: NOW.toISOString(),
    ...over,
  });

const ctx = (settings = {}, extra = {}) => ({
  now: NOW,
  settings,
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

const payload = (source, data, extra = {}) => ({
  source,
  kind: /** @type {const} */ ("dom"),
  url: `https://${source === "gmail" ? "mail.google.com" : "outlook.office.com"}/mail`,
  body: JSON.stringify(data),
  at: NOW.toISOString(),
  ...extra,
});

const wrap = (provider, messages, view = "message", folder = "inbox") => ({
  v: 1,
  provider,
  folder,
  view,
  messages,
});

const GCAL = "Invitation: Robotics design review @ Tue Oct 6, 2026 6pm - 7pm (EDT) (jane.student@example.com)";

test("gmail invite -> exact meeting item", () => {
  const [i] = items(
    msg({
      from: "Google Calendar",
      fromEmail: "calendar-notification@google.example.com",
      subject: GCAL,
      links: ["https://meet.google.com/abc-defg-hij"],
    }),
  );
  assert.equal(i.type, "meeting");
  assert.equal(i.title, "Robotics design review");
  assert.equal(i.startAt, "2026-10-06T22:00:00.000Z");
  assert.equal(i.endAt, "2026-10-06T23:00:00.000Z");
  assert.equal(i.confidence, "exact");
  assert.equal(i.review, "auto");
  assert.equal(i.location, "https://meet.google.com/abc-defg-hij");
  assert.equal(i.source, "gmail");
  assert.equal(i.id, "gmail:invite:k1:2026-10-06T22:00:00.000Z");
});

test("a non-Eastern invite zone is tentative/pending with meta.tz", () => {
  const [i] = items(
    msg({
      subject: GCAL.replace("(EDT)", "(PDT)"),
      links: ["https://meet.google.com/abc-defg-hij"],
    }),
  );
  assert.equal(i.confidence, "tentative");
  assert.equal(i.review, "pending");
  assert.equal(i.meta.tz, "PDT");
  assert.equal(i.startAt, "2026-10-06T22:00:00.000Z"); // still parsed as Toronto
});

test("a cancelled invite keeps the cancelled status", () => {
  const [i] = items(
    msg({ subject: GCAL.replace("Invitation:", "Canceled event:"), links: [] }),
  );
  assert.equal(i.status, "cancelled");
});

test("outlook When:/Where:/Join: invite -> interview item", () => {
  const [i] = items(
    msg({
      provider: "outlook",
      url: "https://outlook.office.com/mail/inbox/id/conv1",
      from: "Talent Team",
      fromEmail: "recruiting@acme.example.com",
      subject: "Interview: Firmware Co-op",
      body:
        "Hello,\nWhen: Thursday, October 15, 2026 2:00 PM-2:30 PM\n" +
        "Where: Microsoft Teams Meeting\nJoin: https://teams.microsoft.com/l/meetup-join/19%3ameeting_x",
      links: ["https://teams.microsoft.com/l/meetup-join/19%3ameeting_x"],
    }),
  );
  assert.equal(i.type, "interview");
  assert.equal(i.title, "Interview: Firmware Co-op");
  assert.equal(i.startAt, "2026-10-15T18:00:00.000Z");
  assert.equal(i.endAt, "2026-10-15T18:30:00.000Z");
  assert.equal(i.location, "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x");
  assert.equal(i.source, "outlook");
});

test("instructor mail: midterm room change -> one tentative exam item, no leaks", async () => {
  const courses = [
    {
      code: "ECE 105",
      term: 1269,
      instructors: [{ name: "Jane Smith", email: "jsmith@uwaterloo.ca" }],
    },
  ];
  const m = msg({
    from: "Jane Smith",
    fromEmail: "jsmith@uwaterloo.ca",
    subject: "Midterm room change",
    body: "Hi all,\nThe midterm on October 22 at 7:00 PM has moved to MC 1085. Bring your WatCard.",
  });
  const res = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [m])),
    ctx({}, { courses }),
  );
  assert.equal(res.items.length, 1);
  const i = res.items[0];
  assert.equal(i.type, "exam");
  assert.equal(i.startAt, "2026-10-22T23:00:00.000Z");
  assert.equal(i.org, "ECE 105");
  assert.equal(i.confidence, "tentative");
  assert.equal(i.review, "pending");
  assert.equal(
    i.evidence.snippet,
    "The midterm on October 22 at 7:00 PM has moved to MC 1085.",
  );
  const blob = JSON.stringify(res);
  assert.ok(!blob.includes("Bring your WatCard"));
  assert.ok(!blob.includes("jsmith@"));
});

test("a newsletter with neither gate nor keyword yields nothing", () => {
  const out = items(
    msg({
      from: "Shop Deals",
      fromEmail: "deals@shop.example.com",
      subject: "Weekend sale",
      body: "Sale ends October 12. Don't miss the deadline!",
    }),
  );
  assert.deepEqual(out, []);
});

test("keyword subject from an unknown sender -> pending meeting", () => {
  const [i] = items(
    msg({
      from: "Robotics Lead",
      fromEmail: "lead@robotics.example.org",
      subject: "Design review moved",
      body: "The design review is now on October 9 at 5 PM in E5 3101.",
    }),
  );
  assert.equal(i.type, "meeting");
  assert.equal(i.startAt, "2026-10-09T21:00:00.000Z");
  assert.equal(i.confidence, "tentative");
  assert.equal(i.review, "pending");
});

test("a date that ended before yesterday is dropped", () => {
  const out = items(
    msg({
      from: "Robotics Lead",
      fromEmail: "lead@robotics.example.org",
      subject: "Design review moved",
      body: "The design review was on September 1.",
    }),
  );
  assert.deepEqual(out, []);
});

test("observe: provider off and folder filters", async () => {
  const m = msg({ subject: GCAL, links: ["https://meet.google.com/abc-defg-hij"] });
  const off = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [m])),
    ctx({ gmail: false }),
  );
  assert.equal(off.complete, false);
  assert.equal(off.scope, "email:off");
  assert.deepEqual(off.items, []);

  const sent = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [m], "list", "sent")),
    ctx({}),
  );
  assert.deepEqual(sent.items, []);
});

test("observe: message scope keys items; list scope matches none", async () => {
  const m = msg({ subject: GCAL, links: ["https://meet.google.com/abc-defg-hij"] });
  const listRes = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [m], "list", "inbox")),
    ctx({}),
  );
  assert.equal(listRes.scope, "email:gmail:list");
  const msgRes = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [m], "message", "inbox")),
    ctx({}),
  );
  assert.equal(msgRes.scope, "email:gmail:k1");
  // The same message in a list produces the same seenIn scope.
  assert.equal(listRes.items[0].seenIn[0].scope, "email:gmail:k1");
  assert.equal(msgRes.items[0].seenIn[0].scope, "email:gmail:k1");
  assert.equal(msgRes.session, "signed-in");
});

test("observe: junk body is an incomplete no-scope result", async () => {
  const res = await adapter.observe.parse(
    { source: "gmail", kind: "dom", url: "u", body: "<html>", at: NOW.toISOString() },
    ctx({}),
  );
  assert.equal(res.complete, false);
  assert.equal(res.scope, "email:none");
});

test("DOM: gmail list rows extract key/from/subject/preview", () => {
  const { document } = parseHTML(html("gmail-list"));
  const out = extractFor(document, "https://mail.google.com/mail/u/0/#inbox");
  assert.equal(out.provider, "gmail");
  assert.equal(out.folder, "inbox");
  assert.equal(out.view, "list");
  assert.ok(out.messages.length >= 2);
  const inv = out.messages.find((m) => m.key === "thread-abc123");
  assert.equal(inv.from, "Jane Student");
  assert.equal(inv.fromEmail, "jane.student@example.com");
  assert.match(inv.subject, /Robotics design review/);
  assert.match(inv.preview || "", /invited to the following/);
  assert.ok(inv.receivedAt);
});

test("DOM: gmail message view extracts body, links, receivedAt", () => {
  const { document } = parseHTML(html("gmail-message"));
  const out = extractFor(document, "https://mail.google.com/mail/u/0/#inbox/thread-abc123");
  assert.equal(out.view, "message");
  const m = out.messages[0];
  assert.equal(m.key, "thread-abc123");
  assert.match(m.body || "", /When: Tue Oct 6, 2026 6pm - 7pm/);
  assert.deepEqual(m.links, ["https://meet.google.com/abc-defg-hij"]); // unwrapped
  assert.ok(m.receivedAt);
  assert.equal(m.fromEmail, "calendar-notification@google.example.com");
});

test("DOM: outlook list and message views", () => {
  const list = extractFor(
    parseHTML(html("outlook-list")).document,
    "https://outlook.office.com/mail/inbox",
  );
  assert.equal(list.provider, "outlook");
  assert.equal(list.folder, "inbox");
  assert.ok(list.messages.length >= 2);
  const row = list.messages.find((m) => m.key === "conv-out-1");
  assert.equal(row.from, "Talent Team");
  assert.equal(row.fromEmail, "recruiting@acme.example.com");
  assert.equal(row.subject, "Interview: Firmware Co-op");

  const view = extractFor(
    parseHTML(html("outlook-message")).document,
    "https://outlook.office.com/mail/inbox/id/conv-out-1",
  );
  assert.equal(view.view, "message");
  const m = view.messages[0];
  assert.equal(m.key, "conv-out-1"); // from the aria-selected row
  assert.match(m.body || "", /When: Thursday, October 15, 2026/);
  assert.deepEqual(m.links, ["https://teams.microsoft.com/l/meetup-join/19%3ameeting_x"]);
  assert.ok(m.receivedAt);
});

test("email sources contain no forbidden APIs", () => {
  const SRC = path.resolve(DIR, "..", "..", "..", "extension", "src", "sources", "email");
  const FORBIDDEN = [
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /\bWebSocket\b/,
    /localStorage/,
    /sessionStorage/,
    /document\.cookie/,
    /webpackChunk/,
    /\.click\s*\(/,
    /location\.assign/,
    /location\.href\s*=(?![=])/,
    /location\.replace\s*\(/,
    /history\.pushState/,
  ];
  for (const file of ["content.js", "dom.js", "index.js", "rules.js", "selectors.js", "extract.js"]) {
    const src = fs.readFileSync(path.join(SRC, file), "utf8");
    for (const re of FORBIDDEN) {
      assert.equal(re.test(src), false, `${file} contains ${re}`);
    }
  }
});
