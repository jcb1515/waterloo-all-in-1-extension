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
import { extractFor, parseListLabel } from "../../extension/src/sources/email/dom.js";
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
  // Title-slug id: every copy of this invite collapses to one event.
  assert.equal(i.id, "gmail:invite:robotics-design-review:2026-10-06T22:00:00.000Z");
  assert.equal(i.meta.onCalendar, "google"); // Google already added it
});

test("gmailInvitesToFeed: true keeps gmail invites publishable", () => {
  const [i] = items(
    msg({ subject: GCAL, links: ["https://meet.google.com/abc-defg-hij"] }),
    { settings: { gmailInvitesToFeed: true } },
  );
  assert.equal(i.meta.onCalendar, undefined);
});

test("invite updates and cancellations share one item id", () => {
  const a = items(msg({ key: "t1", subject: GCAL, links: [] }))[0];
  const b = items(msg({ key: "t2", subject: GCAL.replace("Invitation:", "Updated invitation:"), links: [] }))[0];
  assert.equal(a.id, b.id);
  const c = items(msg({ key: "t3", subject: GCAL.replace("Invitation:", "Canceled event:"), links: [] }))[0];
  assert.equal(c.id, a.id);
  assert.equal(c.status, "cancelled");
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
  assert.equal(i.meta.employer, "acme"); // links to the WaterlooWorks application
  assert.equal(i.meta.onCalendar, undefined); // gmail-only flag
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
  assert.equal(i.title, "Midterm"); // same title outline/Portal exams use
  assert.equal(i.details, "Email: Midterm room change");
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

  // Observed before the invite's day — anything already over is dropped.
  const res = await adapter.observe.parse(
    payload("gmail", out),
    ctx({}, { now: new Date("2026-09-28T15:00:00.000Z") }),
  );
  assert.equal(res.items.length, 1); // the conflict line must not become an item
  const i = res.items[0];
  assert.equal(i.type, "meeting");
  assert.equal(i.title, "Chat about robotics at Example Space");
  assert.equal(i.startAt, "2026-09-29T17:00:00.000Z");
  assert.equal(i.endAt, "2026-09-29T17:30:00.000Z");
  assert.equal(i.confidence, "exact");
  assert.equal(i.review, "auto");
  assert.equal(i.location, "https://teams.microsoft.com/l/meetup-join/19%3ameeting_demo");
  assert.equal(i.meta.onCalendar, "google");
  const org = (i.meta.facts || []).find((f) => f.label === "Organizer");
  assert.equal(org && org.value, "Jane Doe");
});

test("outlook invite card -> meeting item", async () => {
  const { document } = parseHTML(html("outlook-invite-card"));
  const out = extractFor(document, "https://outlook.cloud.microsoft/mail/inbox/id/conv-inv");
  assert.equal(out.view, "message");
  assert.equal(out.messages[0].key, "conv-inv");
  assert.match(out.messages[0].invite.whenText, /9\/29\/2026/);
  const res = await adapter.observe.parse(
    payload("outlook", out),
    ctx({}, { now: new Date("2026-09-28T15:00:00.000Z") }),
  );
  assert.equal(res.items.length, 1);
  const i = res.items[0];
  assert.equal(i.type, "meeting");
  assert.equal(i.startAt, "2026-09-29T17:00:00.000Z");
  assert.equal(i.endAt, "2026-09-29T17:30:00.000Z");
  assert.equal(i.confidence, "exact");
  assert.equal(i.review, "auto");
});

test("outlook co-op 'select an interview time slot' -> book-call task", async () => {
  const { document } = parseHTML(html("outlook-coop-slot"));
  const out = extractFor(document, "https://outlook.cloud.microsoft/mail/inbox/id/conv-coop-1");
  assert.equal(out.view, "message");
  const m = out.messages[0];
  // The reading-pane header has no span[title*="@"]: name from the "From:"
  // aria-label, address from the "Name<addr>" text inside it.
  assert.equal(m.from, "Co-op Office");
  assert.equal(m.fromEmail, "coop@uwaterloo.ca");
  assert.match(m.body || "", /Select your interview time slot/);

  const res = await adapter.observe.parse(payload("outlook", out), ctx({}));
  const task = res.items.find((i) => i.type === "task");
  assert.ok(task, "expected a book-call task");
  assert.equal(task.category, "book-call");
  assert.equal(task.title, "Select interview time slot — Co-op Office");
  assert.equal(task.status, "open");
});

test("outlook list row preview with slot wording -> book-call task", async () => {
  const { document } = parseHTML(
    `<html><body><div role="listbox" data-folder-name="inbox">` +
      `<div role="option" data-convid="conv-coop-9" data-item-index="0">` +
      `<span title="coop@uwaterloo.ca">Co-op Office</span>` +
      `<div>You have been selected for an interview (Co-op message)</div>` +
      `<div>Fri Sep 25</div>` +
      `<div>Next step: Select your interview time slot in WorkHub.</div>` +
      `</div></div></body></html>`,
  );
  const out = extractFor(document, "https://outlook.cloud.microsoft/mail/inbox");
  assert.equal(out.view, "list");
  const res = await adapter.observe.parse(payload("outlook", out), ctx({}));
  const task = res.items.find((i) => i.type === "task");
  assert.ok(task, "expected a book-call task from the row preview");
  assert.equal(task.category, "book-call");
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
    { now: new Date("2026-09-28T15:00:00.000Z") }, // observed before the deadline
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

  // The signed-in address comes off the folder pane's account root and is
  // used only to flag fromMe — it is blanked, never serialised as a sender.
  const mine = list.messages.find((m) => m.key === "conv-out-3");
  assert.equal(mine.fromMe, true);
  assert.equal(mine.fromEmail, "");
  assert.ok(!JSON.stringify(list).includes("jane.student@example.com"));

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

test("bulk senders produce nothing unless they pass the gate or exception", () => {
  // Newsletter boilerplate marks it bulk — but a dated event-noun sentence
  // is the bulk exception, so the info session does produce an item now.
  const [session] = items(
    msg({
      from: "Club News",
      fromEmail: "news@club.example.org",
      subject: "September newsletter",
      body: "Our info session is on October 9 at 6 PM.\nUnsubscribe from these emails.",
    }),
  );
  assert.equal(session.type, "event");
  assert.equal(session.startAt, "2026-10-09T22:00:00.000Z");

  // A newsletter with no event noun stays suppressed.
  const news = items(
    msg({
      from: "Club News",
      fromEmail: "news@club.example.org",
      subject: "September newsletter",
      body: "Our monthly update is on October 9 at 6 PM.\nUnsubscribe from these emails.",
    }),
  );
  assert.deepEqual(news, []);

  // A no-reply sender is bulk on its local part alone.
  const noreply = items(
    msg({
      from: "Shop",
      fromEmail: "no-reply@shop.example.com",
      subject: "Your receipt",
      body: "Your pickup window is October 9 at 6 PM.",
    }),
  );
  assert.deepEqual(noreply, []);

  // ...but a gated bulk sender (Learn's noreply) still produces items.
  const [learn] = items(
    msg({
      from: "LEARN",
      fromEmail: "noreply@learn.uwaterloo.ca",
      subject: "Quiz reminder",
      body: "Quiz 3 is due October 9 at 11:59 PM.",
    }),
  );
  assert.equal(learn.type, "deadline");
  assert.equal(learn.dueAt, "2026-10-10T03:59:00.000Z");
});

test("a sender matching a WaterlooWorks application is an employer", () => {
  const [i] = items(
    msg({
      from: "Talent Team",
      fromEmail: "talent@acme.com",
      subject: "Next steps",
      body: "Can we set up a call on October 8 at 2:00 PM?",
    }),
    {
      applications: [
        { employer: "Acme Corp", jobTitle: "Firmware Co-op", jobId: "400001", status: "applied" },
      ],
    },
  );
  assert.equal(i.type, "interview");
  assert.equal(i.startAt, "2026-10-08T18:00:00.000Z");
  assert.equal(i.org, "Acme Corp");
  assert.equal(i.meta.employer, "Acme Corp");
  assert.equal(i.meta.jobId, "400001");
});

test("a recruiter at a personal domain is named, not 'gmail'", () => {
  const [i] = items(
    msg({
      from: "Sam Lee",
      fromEmail: "sam.recruits@gmail.com",
      subject: "Following up",
      body: "Hi, I'm a recruiter at Acme. Are you available for a phone screen on Thursday, October 8 at 2:00 PM?",
    }),
  );
  assert.equal(i.type, "interview");
  assert.equal(i.startAt, "2026-10-08T18:00:00.000Z");
  assert.equal(i.review, "pending");
  assert.equal(i.meta.employer, "Sam Lee");
});

test("bare-hour meet-up in casual text -> pending meeting at PM", () => {
  const [i] = items(
    msg({
      from: "Alex Kim",
      fromEmail: "alex@robotics.example.org",
      subject: "Robotics",
      body: "Hey, can we meet Thursday at 2?",
      receivedAt: "2026-09-29T15:00:00.000Z",
    }),
  );
  assert.equal(i.type, "meeting");
  assert.equal(i.startAt, "2026-10-01T18:00:00.000Z");
  assert.equal(i.review, "pending");
});

test("parseListLabel resolves short mail labels against now", () => {
  const now = new Date("2026-09-29T20:00:00.000Z"); // Tuesday, 4 PM EDT
  assert.equal(parseListLabel("3:14 PM", now), "2026-09-29T19:14:00.000Z");
  assert.equal(parseListLabel("Fri 4:34 PM", now), "2026-09-25T20:34:00.000Z");
  assert.equal(parseListLabel("Fri", now), "2026-09-25T04:00:00.000Z");
  assert.equal(parseListLabel("Sep 25", now), "2026-09-25T04:00:00.000Z");
  assert.equal(parseListLabel("Dec 30", now), "2025-12-30T05:00:00.000Z");
  assert.equal(parseListLabel("9/25/26", now), "2026-09-25T04:00:00.000Z");
});

test("a list row's label date anchors relative dates in the preview", () => {
  const [i] = items(
    msg({
      from: "Alex Kim",
      fromEmail: "alex@robotics.example.org",
      subject: "Robotics",
      preview: "can we meet tomorrow at 3pm?",
      receivedAt: "2026-09-25T04:00:00.000Z", // the "Sep 25" label
    }),
    { now: new Date("2026-09-25T20:00:00.000Z") }, // observed Sep 25
  );
  assert.equal(i.type, "meeting");
  assert.equal(i.startAt, "2026-09-26T19:00:00.000Z"); // tomorrow = Sep 26, not now
});

test("reply task: a professor's question becomes one task, done after I answer", async () => {
  const courses = [
    { code: "ECE 105", term: 1269, instructors: [{ name: "Jane Smith", email: "jsmith@uwaterloo.ca" }] },
  ];
  // (a) the ask alone
  const askDoc = parseHTML(html("gmail-thread-ask")).document;
  const ask = extractFor(askDoc, "https://mail.google.com/mail/u/0/#inbox/thr-ask");
  const res1 = await adapter.observe.parse(payload("gmail", ask), ctx({}, { courses }));
  const replies1 = res1.items.filter((i) => i.category === "reply");
  assert.equal(replies1.length, 1);
  assert.equal(res1.items.length, 1);
  const t = replies1[0];
  assert.equal(t.id, "gmail:reply:thr-ask");
  assert.equal(t.type, "task");
  assert.equal(t.title, "Reply to Jane Smith: Lab sections");
  assert.equal(t.dueAt, "2026-10-03T21:00:00.000Z"); // askedAt + 2d @ 17:00 ET
  assert.equal(t.review, "auto");
  assert.equal(t.status, "open");
  assert.equal(t.meta.reply.threadKey, "thr-ask");
  assert.ok(res1.state.replies["thr-ask"]);

  // (b) my reply appears in the thread -> the same id comes back done
  const repDoc = parseHTML(html("gmail-thread-reply")).document;
  const rep = extractFor(repDoc, "https://mail.google.com/mail/u/0/#inbox/thr-ask");
  const res2 = await adapter.observe.parse(
    payload("gmail", rep),
    ctx({}, { courses, state: res1.state }),
  );
  const done = res2.items.find((i) => i.id === "gmail:reply:thr-ask");
  assert.equal(done.status, "done");
  assert.equal(res2.state.replies["thr-ask"].status, "done");

  // ...and a sent-folder list row for the same key closes it too.
  const sent = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [msg({ key: "thr-ask" })], "list", "sent")),
    ctx({}, { courses, state: res1.state }),
  );
  const sentDone = sent.items.find((i) => i.id === "gmail:reply:thr-ask");
  assert.equal(sentDone.status, "done");
  assert.equal(sent.items.filter((i) => i.category !== "reply").length, 0);
});

test("reply task: an explicit 'reply by <date>' sets the due", async () => {
  const m = msg({
    from: "Alex Kim",
    fromEmail: "alex@robotics.example.org",
    subject: "Robotics",
    body: "Quick one — please reply by October 5.",
  });
  const res = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [m], "message", "inbox")),
    ctx({}),
  );
  const t = res.items.find((i) => i.category === "reply");
  assert.equal(t.dueAt, "2026-10-06T03:59:00.000Z"); // Oct 5, 23:59 ET
});

test("book-a-call task: calendly wording, completed by the invite", async () => {
  const m = msg({
    key: "book1",
    from: "Morgan Park",
    fromEmail: "morgan@park.example.com",
    subject: "Intro call",
    body: "Feel free to book a time here: https://calendly.com/example/30min",
    links: ["https://calendly.com/example/30min"],
  });
  const res1 = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [m], "message", "inbox")),
    ctx({}),
  );
  const book = res1.items.find((i) => i.category === "book-call");
  assert.equal(book.id, "gmail:book:book1");
  assert.equal(book.type, "task");
  assert.equal(book.url, "https://calendly.com/example/30min");
  assert.equal(book.review, "pending");
  assert.equal(res1.state.bookings.book1.status, "open");
  // The state carries only a hash of the sender — never the address.
  assert.ok(!JSON.stringify(res1.state).includes("morgan@"));

  // A Google Calendar invite from the same sender on another thread closes it.
  const inv = msg({
    key: "book2",
    from: "Morgan Park",
    fromEmail: "morgan@park.example.com",
    subject: GCAL,
    links: ["https://meet.google.com/abc-defg-hij"],
  });
  const res2 = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [inv], "message", "inbox")),
    ctx({}, { state: res1.state }),
  );
  const doneItem = res2.items.find((i) => i.id === "gmail:book:book1");
  assert.equal(doneItem.status, "done");
  assert.equal(res2.state.bookings.book1.status, "done");
});

test("reply task: a recruiter at a personal domain still asks", async () => {
  const m = msg({
    from: "Sam Lee",
    fromEmail: "sam.recruits@gmail.com",
    subject: "Following up",
    body: "Hi, I'm a recruiter at Acme. Are you available for a phone screen on Thursday, October 8 at 2:00 PM?",
  });
  const res = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [m], "message", "inbox")),
    ctx({}),
  );
  const reply = res.items.find((i) => i.category === "reply");
  assert.equal(reply.id, "gmail:reply:k1");
  assert.equal(reply.review, "pending");
  assert.equal(reply.title, "Reply to Sam Lee: Following up");
});

test("bulk senders make no reply or book tasks", async () => {
  const news = msg({
    key: "nb1",
    from: "Club News",
    fromEmail: "news@club.example.org",
    subject: "September newsletter",
    body: "Can you make our info session on October 9 at 6 PM?\nUnsubscribe from these emails.",
  });
  const r1 = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [news], "message", "inbox")),
    ctx({}),
  );
  // The event item is the bulk exception; no reply task may come of it.
  assert.ok(r1.items.every((i) => i.type !== "task"));

  const nr = msg({
    key: "nb2",
    from: "Shop",
    fromEmail: "no-reply@shop.example.com",
    subject: "Your receipt",
    body: "Can you confirm your pickup on October 9 at 6 PM?",
    links: ["https://calendly.com/example/30min"],
  });
  const r2 = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [nr], "message", "inbox")),
    ctx({}),
  );
  assert.equal(r2.items.length, 0);
});

test("quoted history cannot create a reply task", async () => {
  const m = msg({
    from: "Alex Kim",
    fromEmail: "alex@robotics.example.org",
    subject: "Robotics",
    body:
      "Sounds good.\nOn Tue, Sep 29, 2026 at 2:00 PM Alex Kim wrote:\n> Can you make Thursday at 2?",
  });
  const res = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [m], "message", "inbox")),
    ctx({}),
  );
  assert.equal(res.items.length, 0);
});

test("privacy: my account address never leaves the page", async () => {
  const { document } = parseHTML(html("gmail-thread-reply"));
  const out = extractFor(document, "https://mail.google.com/mail/u/0/#inbox/thr-ask");
  assert.ok(!JSON.stringify(out).includes("jane.student@example.com"));
  const mine = out.messages.find((m) => m.fromMe);
  assert.equal(mine.fromEmail, "");

  const res = await adapter.observe.parse(payload("gmail", out), ctx({}));
  assert.ok(!JSON.stringify(res).includes("jane.student@example.com"));
  assert.ok(!JSON.stringify(res.state).includes("jane.student@example.com"));
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
