// @ts-check
// Email adapter: pure Msg -> items rules, adapter observe routing, DOM
// extracts on synthetic fixtures, and the no-network static rules.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import adapter, {
  startMailScan,
  stopMailScan,
} from "../../extension/src/sources/email/index.js";
import { extractFor } from "../../extension/src/sources/email/dom.js";
import { itemsFromMessage } from "../../extension/src/sources/email/extract.js";
import {
  GMAIL_SCAN_QUERY,
  OUTLOOK_SCAN_QUERY,
} from "../../extension/src/sources/email/rules.js";
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

  // Opening a thread in an excluded folder must not wipe its inbox items.
  const archived = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [m], "message", "archive")),
    ctx({}),
  );
  assert.deepEqual(archived.items, []);
  assert.equal(archived.scope, "email:gmail:list");
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

test("gmail invite card: date lives in the card, not the .a3s body", async () => {
  const { document } = parseHTML(html("gmail-invite-card"));
  const out = extractFor(document, "https://mail.google.com/mail/u/0/#inbox/inv001");
  assert.equal(out.view, "message");
  const m = out.messages[0];
  assert.match(m.invite.whenText, /Sep 29/);
  assert.equal(m.invite.title, "Chat about robotics at Example Space");
  assert.equal(m.invite.where, "Microsoft Teams Meeting");
  assert.equal(m.invite.organizer, "Jane Doe");

  const res = await adapter.observe.parse(payload("gmail", out), ctx({}));
  assert.equal(res.items.length, 1); // the conflict line must not become an item
  const i = res.items[0];
  assert.equal(i.type, "meeting");
  assert.equal(i.title, "Chat about robotics at Example Space");
  assert.equal(i.startAt, "2026-09-29T17:00:00.000Z");
  assert.equal(i.endAt, "2026-09-29T17:30:00.000Z");
  assert.equal(i.confidence, "exact");
  assert.equal(i.review, "auto");
  assert.equal(i.location, "https://teams.microsoft.com/l/meetup-join/19%3ameeting_demo");
  const org = (i.meta.facts || []).find((f) => f.label === "Organizer");
  assert.equal(org && org.value, "Jane Doe");
});

test("outlook invite card -> meeting item", async () => {
  const { document } = parseHTML(html("outlook-invite-card"));
  const out = extractFor(document, "https://outlook.cloud.microsoft/mail/inbox/id/conv-inv");
  assert.equal(out.view, "message");
  assert.equal(out.messages[0].key, "conv-inv");
  assert.match(out.messages[0].invite.whenText, /9\/29\/2026/);
  const res = await adapter.observe.parse(payload("outlook", out), ctx({}));
  assert.equal(res.items.length, 1);
  const i = res.items[0];
  assert.equal(i.type, "meeting");
  assert.equal(i.startAt, "2026-09-29T17:00:00.000Z");
  assert.equal(i.endAt, "2026-09-29T17:30:00.000Z");
  assert.equal(i.confidence, "exact");
  assert.equal(i.review, "auto");
});

test("rsvp-by keyword -> pending deadline", () => {
  const [i] = items(
    msg({
      from: "CommuniHacks",
      fromEmail: "hello@communihacks.example.com",
      subject:
        "[ACTION REQUIRED] Congratulations, you're in CommuniHacks (MLH) - RSVP by Sept 30!",
      receivedAt: "2026-09-27T18:01:00.000Z",
    }),
  );
  assert.equal(i.type, "deadline");
  assert.equal(i.dueAt, "2026-10-01T03:59:00.000Z"); // Sept 30 23:59 Toronto
  assert.equal(i.confidence, "tentative");
  assert.equal(i.review, "pending");
});

test("gmail #search hash: query is folder 'search', never the id", () => {
  const { document } = parseHTML(
    `<html><body><h2 class="hP">Result</h2>` +
      `<div class="adn"><span class="gD" email="a@b.example.com" name="A">A</span>` +
      `<span class="g3" title="Fri, Sep 25, 2026, 10:18 AM">t</span>` +
      `<div class="a3s">hi</div></div></body></html>`,
  );
  const view = extractFor(document, "https://mail.google.com/mail/u/0/#search/filename%3Aics/abc123");
  assert.equal(view.folder, "search");
  assert.equal(view.view, "message");
  assert.equal(view.messages[0].key, "abc123");
  const list = extractFor(document, "https://mail.google.com/mail/u/0/#search/filename%3Aics");
  assert.equal(list.view, "list");
  assert.equal(list.folder, "search");
});

test("guided scan: deeplink, queueing, scanned bookkeeping", async () => {
  const started = startMailScan({}, { provider: "gmail", now: NOW });
  assert.equal(
    started.url,
    "https://mail.google.com/mail/u/0/#search/" + encodeURIComponent(GMAIL_SCAN_QUERY(60)),
  );
  assert.equal(started.state.scan.provider, "gmail");

  const rows = [
    msg({ key: "s1", subject: "Invitation: A" }),
    msg({ key: "s2", subject: "Invitation: B" }),
    msg({ key: "s3", subject: "Invitation: C" }),
  ];
  const res1 = await adapter.observe.parse(
    payload("gmail", wrap("gmail", rows, "list", "search"), {
      url: "https://mail.google.com/mail/u/0/#search/q",
    }),
    ctx({}, { state: { ...started.state, scanned: { s3: "t" } } }),
  );
  assert.deepEqual(res1.state.scanQueue.map((q) => q.key), ["s1", "s2"]);
  assert.equal(res1.state.scanQueue[0].url, "https://mail.google.com/mail/u/0/#all/s1");

  // Opening a queued thread under "archive" still yields its invite while a
  // scan is active; the key leaves the queue and is marked scanned.
  const inv = msg({ key: "s1", subject: GCAL, links: ["https://meet.google.com/abc-defg-hij"] });
  const res2 = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [inv], "message", "archive")),
    ctx({}, { state: res1.state }),
  );
  assert.equal(res2.items.length, 1);
  assert.deepEqual(res2.state.scanQueue.map((q) => q.key), ["s2"]);
  assert.ok(res2.state.scanned.s1);

  // No active scan -> archive is filtered, nothing is produced.
  const res3 = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [inv], "message", "archive")),
    ctx({}, { state: {} }),
  );
  assert.equal(res3.items.length, 0);

  const stopped = stopMailScan(res2.state);
  assert.equal(stopped.scan, undefined);
  assert.equal(stopped.scanQueue, undefined);
  assert.ok(stopped.scanned.s1);

  const o = startMailScan({}, { provider: "outlook", now: NOW });
  assert.equal(o.url, null);
  assert.equal(o.query, OUTLOOK_SCAN_QUERY);
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
