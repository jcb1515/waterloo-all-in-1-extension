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
  // No session on success — the scheduler's observe branch stamps
  // lastOkAt/itemCount only when `session` is absent.
  assert.ok(!("session" in msgRes));
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

  // ...but a gated bulk sender (WaterlooWorks' noreply) still produces
  // items through the bulk exception.
  const [ww] = items(
    msg({
      from: "WorkHub",
      fromEmail: "no-reply@waterlooworks.uwaterloo.ca",
      subject: "Interview schedule posted",
      body: "Your interview is on October 9 at 6 PM in the main hall.",
    }),
  );
  assert.equal(ww.type, "interview");

  // Learn/D2L notification mail produces nothing — the Learn source is
  // authoritative for it.
  const learn = items(
    msg({
      from: "LEARN",
      fromEmail: "noreply@learn.uwaterloo.ca",
      subject: "Quiz reminder",
      body: "Quiz 3 is due October 9 at 11:59 PM.",
    }),
  );
  assert.deepEqual(learn, []);
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
  // A matched application employer gates the sender — but without an
  // interview word in the sentence the dated call is a meeting.
  assert.equal(i.type, "meeting");
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

test("blockSenders silence a sender's items and tasks", async () => {
  const m = msg({
    from: "Co-op Office",
    fromEmail: "coop@uwaterloo.ca",
    subject: "Interview: Firmware Co-op",
    body: "Please reply to book your interview on Thursday, October 8 at 2:00 PM.",
  });
  // Ungated on its own: an interview item and a reply task.
  const open = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [m], "message", "inbox")),
    ctx({}),
  );
  assert.ok(open.items.length > 0);

  const blocked = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [m], "message", "inbox")),
    ctx({ blockSenders: ["uwaterloo.ca"] }),
  );
  assert.equal(blocked.items.length, 0);
  // itemsFromMessage short-circuits too — even an invite dies at the gate.
  const inv = items(
    msg({ fromEmail: "calendar-notification@google.example.com", subject: GCAL, links: [] }),
    { settings: { blockSenders: ["google.example.com"] } },
  );
  assert.equal(inv.length, 0);
  // And a block entry still passes parse without errors from another sender.
  const ok = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [m], "message", "inbox")),
    ctx({ blockSenders: ["somebody-else.example.com"] }),
  );
  assert.ok(ok.items.length > 0);
});

test("allowSenders gates a bulk or personal-domain sender", async () => {
  const news = msg({
    key: "al1",
    from: "Club News",
    fromEmail: "no-reply@club.example.org",
    subject: "September social",
    body: "RSVP for our info session on October 9 at 6 PM.\nUnsubscribe.",
  });
  // Allow-listing rescues the gate: the bulk exception's dated event noun
  // produces an item — but a no-reply bulk sender never gets a reply task.
  const gated = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [news], "message", "inbox")),
    ctx({ allowSenders: ["club.example.org"] }),
  );
  assert.ok(gated.items.some((i) => i.type !== "task"));
  assert.ok(
    gated.items.every((i) => i.type !== "task"),
    "bulk no-reply sender never gets a reply task",
  );

  const same = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [news], "message", "inbox")),
    ctx({}),
  );
  assert.ok(same.items.every((i) => i.type !== "task"));

  // An allow-listed personal-domain person does get a reply task.
  const person = msg({
    key: "al3",
    from: "Sam Lee",
    fromEmail: "sam.lee@freemail.example.org",
    subject: "Catching up",
    body: "Could you confirm you're still coming on October 9?",
  });
  const sub = await adapter.observe.parse(
    payload(
      "gmail",
      wrap(
        "gmail",
        [{ ...news, key: "al2", fromEmail: "no-reply@lists.club.example.org" }, person],
        "message",
        "inbox",
      ),
    ),
    ctx({ allowSenders: ["club.example.org", "freemail.example.org"] }),
  );
  const reply = sub.items.find((i) => i.category === "reply");
  assert.ok(reply, "allow-listed personal sender gets a reply task");
  assert.equal(reply.review, "auto");

  // Block still wins over allow.
  const veto = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [news], "message", "inbox")),
    ctx({
      allowSenders: ["club.example.org"],
      blockSenders: ["no-reply@club.example.org"],
    }),
  );
  assert.equal(veto.items.length, 0);
});

test("onlyCourseCoop silences senders outside the gate", async () => {
  const friend = msg({
    key: "p1",
    from: "Pat",
    fromEmail: "pat@example.org",
    subject: "This week",
    body: "Please reply — can you make the study group on October 9 at 2 PM?",
  });
  const preset = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [friend], "message", "inbox")),
    ctx({ onlyCourseCoop: true }),
  );
  assert.equal(preset.items.length, 0);

  const normal = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [friend], "message", "inbox")),
    ctx({}),
  );
  assert.ok(normal.items.some((i) => i.category === "reply"));

  // A co-op sender still produces under the preset.
  const coop = msg({
    key: "p2",
    from: "Co-op Office",
    fromEmail: "coop@uwaterloo.ca",
    subject: "Interview: Firmware Co-op",
    body: "Please reply to book your interview on Thursday, October 8 at 2:00 PM.",
  });
  const kept = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [coop], "message", "inbox")),
    ctx({ onlyCourseCoop: true }),
  );
  assert.ok(kept.items.length > 0);
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

test("to-do seam: reply and book tasks carry meta.action", async () => {
  const m1 = msg({
    from: "Alex Kim",
    fromEmail: "alex@robotics.example.org",
    subject: "Robotics",
    body: "Quick one — please reply when you can.",
  });
  const r1 = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [m1], "message", "inbox")),
    ctx({}),
  );
  const reply = r1.items.find((i) => i.category === "reply");
  assert.equal(reply.meta.action, "reply");
  assert.equal(reply.type, "task");
  assert.equal(reply.meta.undated, true); // no stated due -> taskDue fallback

  const m2 = msg({ ...m1, key: "r2", body: "Quick one — please reply by October 5." });
  const r2 = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [m2], "message", "inbox")),
    ctx({}),
  );
  const dated = r2.items.find((i) => i.category === "reply");
  assert.equal(dated.type, "task"); // reply tasks always stay to-dos
  assert.equal(dated.dueAt, "2026-10-06T03:59:00.000Z"); // the stated due
  assert.equal(dated.meta.undated, undefined);

  // A booking link without interview context -> "other".
  const m3 = msg({
    key: "b1",
    from: "Morgan Park",
    fromEmail: "morgan@park.example.com",
    subject: "Intro call",
    body: "Feel free to book a time here: https://calendly.com/x/30min",
    links: ["https://calendly.com/x/30min"],
  });
  const r3 = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [m3], "message", "inbox")),
    ctx({}),
  );
  const book = r3.items.find((i) => i.category === "book-call");
  assert.equal(book.meta.action, "other");

  // CECA/WaterlooWorks slot wording -> "book-interview" with the employer.
  const m4 = msg({
    key: "b2",
    from: "CECA",
    fromEmail: "no-reply@waterlooworks.uwaterloo.ca",
    subject: "Interview scheduling",
    body: "Please select an interview time slot by October 6.",
  });
  const r4 = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [m4], "message", "inbox")),
    ctx({}),
  );
  const slot = r4.items.find((i) => i.category === "book-call");
  assert.equal(slot.meta.action, "book-interview");
  assert.equal(slot.meta.employer, "CECA");
  assert.equal(slot.type, "task"); // booking tasks stay to-dos
  assert.equal(slot.dueAt, "2026-10-07T03:59:00.000Z"); // Oct 6 23:59 ET
  assert.equal(slot.title, "Select interview time slot — CECA");
});

test("respond-offer: an employer's offer becomes a deadline task", async () => {
  const m = msg({
    key: "o1",
    from: "Acme Corp",
    fromEmail: "jobs@acme.example.com",
    subject: "Offer of employment — Firmware Co-op",
    body: "We are pleased to offer you the Firmware Co-op position. Please accept the offer by October 10.",
  });
  const res = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [m], "message", "inbox")),
    ctx({}, { applications: [{ employer: "Acme Corp" }] }),
  );
  const t = res.items.find((i) => i.meta && i.meta.action === "respond-offer");
  assert.ok(t);
  assert.equal(t.id, "gmail:task:respond-offer:o1");
  assert.equal(t.title, "Respond to offer — Acme Corp");
  assert.equal(t.type, "deadline");
  assert.equal(t.dueAt, "2026-10-11T03:59:00.000Z"); // Oct 10 23:59 ET
  assert.equal(t.meta.employer, "Acme Corp");
  assert.equal(t.review, "auto"); // co-op gate
});

test("submit-form and rsvp: a form link plus an ask", async () => {
  const courses = [
    { code: "ECE 105", term: 1269, instructors: [{ name: "Jane Smith", email: "jsmith@uwaterloo.ca" }] },
  ];
  const m = msg({
    key: "f1",
    from: "Jane Smith",
    fromEmail: "jsmith@uwaterloo.ca",
    subject: "Course survey",
    body: "Please fill out this survey by October 8.",
    links: ["https://docs.google.com/forms/d/e/abc/viewform"],
  });
  const res = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [m], "message", "inbox")),
    ctx({}, { courses }),
  );
  const t = res.items.find((i) => i.meta && i.meta.action === "submit-form");
  assert.ok(t);
  assert.equal(t.title, "Submit form: Course survey");
  assert.equal(t.type, "deadline");
  assert.equal(t.dueAt, "2026-10-09T03:59:00.000Z");
  assert.equal(t.org, "ECE 105"); // course task carries the course code
  assert.equal(t.review, "auto");

  const rv = msg({
    key: "f2",
    from: "Jane Smith",
    fromEmail: "jsmith@uwaterloo.ca",
    subject: "Lab tour",
    body: "RSVP for the lab tour using this form.",
    links: ["https://forms.gle/abc123"],
  });
  const res2 = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [rv], "message", "inbox")),
    ctx({}, { courses }),
  );
  const t2 = res2.items.find((i) => i.meta && i.meta.action === "rsvp");
  assert.ok(t2);
  assert.equal(t2.title, "RSVP: Lab tour");
  assert.equal(t2.type, "task");
  assert.equal(t2.meta.undated, true);
  assert.equal(t2.meta.calendar, false); // synthetic due -> never an event
});

test("submit-document: a document ask without a form link", async () => {
  const m = msg({
    key: "d1",
    from: "Co-op Office",
    fromEmail: "coop@uwaterloo.ca",
    subject: "Work term paperwork",
    body: "Please submit the signed contract by October 9.",
  });
  const res = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [m], "message", "inbox")),
    ctx({}),
  );
  const t = res.items.find((i) => i.meta && i.meta.action === "submit-document");
  assert.ok(t);
  assert.equal(t.title, "Submit document: Work term paperwork");
  assert.equal(t.type, "deadline");
  assert.equal(t.dueAt, "2026-10-10T03:59:00.000Z");
  assert.equal(t.review, "auto");
});

test("pay: a Waterloo fee notice, deadlines and receipts", async () => {
  const m = msg({
    key: "p1",
    from: "Student Fees",
    fromEmail: "fees@uwaterloo.ca",
    subject: "Tuition statement",
    body: "Your tuition fees for fall are now posted. Please pay your balance by October 15.",
  });
  const res = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [m], "message", "inbox")),
    ctx({}),
  );
  const t = res.items.find((i) => i.meta && i.meta.action === "pay");
  assert.ok(t);
  assert.equal(t.title, "Pay: Tuition statement");
  assert.equal(t.type, "deadline");
  assert.equal(t.dueAt, "2026-10-16T03:59:00.000Z");
  assert.equal(t.review, "auto");

  // A receipt never becomes a to-do.
  const rc = msg({
    key: "p2",
    from: "Student Fees",
    fromEmail: "fees@uwaterloo.ca",
    subject: "Payment received",
    body: "Your payment was received — thank you. Your balance is now $0.",
  });
  const res2 = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [rc], "message", "inbox")),
    ctx({}),
  );
  assert.ok(res2.items.every((i) => !i.meta || i.meta.action !== "pay"));
});

test("submit-rankings and apply: WaterlooWorks owns them — email stays silent", async () => {
  const m = msg({
    key: "rk1",
    from: "CECA",
    fromEmail: "no-reply@waterlooworks.uwaterloo.ca",
    subject: "Ranking opens",
    body: "Rank your matches in WaterlooWorks by October 12.",
  });
  const res = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [m], "message", "inbox")),
    ctx({}),
  );
  assert.ok(
    res.items.every(
      (i) => !i.meta || !["submit-rankings", "apply"].includes(i.meta.action),
    ),
    "a rankings ask produces no email to-do",
  );

  const ap = msg({
    key: "a1",
    from: "Acme Corp",
    fromEmail: "jobs@acme.example.com",
    subject: "Firmware Co-op posting",
    body: "Submit your application for the Firmware Co-op role by October 20.",
  });
  const res2 = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [ap], "message", "inbox")),
    ctx({}, { applications: [{ employer: "Acme Corp" }] }),
  );
  assert.ok(
    res2.items.every(
      (i) => !i.meta || !["submit-rankings", "apply"].includes(i.meta.action),
    ),
    "an apply ask produces no email to-do",
  );
});

test("to-do cap: at most two tasks per message", async () => {
  // reply ask + booking wording + offer = 3 candidates, capped at 2.
  const m = msg({
    key: "cap1",
    from: "Acme Corp",
    fromEmail: "jobs@acme.example.com",
    subject: "Offer and interview",
    body:
      "We are pleased to offer you the Firmware Co-op position. " +
      "Please reply to confirm. Please select an interview time slot.",
  });
  const res = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [m], "message", "inbox")),
    ctx({}, { applications: [{ employer: "Acme Corp" }] }),
  );
  const tasks = res.items.filter((i) => i.type === "task" || i.type === "deadline");
  assert.equal(tasks.length, 2);
  // The reply and the interview booking win; the offer is the third.
  assert.ok(tasks.some((i) => i.meta.action === "reply"));
  assert.ok(tasks.some((i) => i.meta.action === "book-interview"));
});

test("to-do negatives stay silent", async () => {
  const cases = [
    // "Book now" — no booking link, no book-a-time wording.
    msg({
      key: "n1",
      from: "Airline",
      fromEmail: "deals@air.example.com",
      subject: "Fly away",
      body: "Book now — fares this low won't last.",
    }),
    // "Reply STOP to unsubscribe".
    msg({
      key: "n2",
      from: "Promo",
      fromEmail: "promo@shop.example.com",
      subject: "Sale",
      body: "Reply STOP to unsubscribe.",
    }),
    // Marketing "RSVP today!" from an ungated bulk sender, no link.
    msg({
      key: "n3",
      from: "Fest",
      fromEmail: "no-reply@fest.example.com",
      subject: "Festival",
      body: "RSVP today! Tickets are going fast.\nUnsubscribe.",
    }),
    // A newsletter carrying a Google Form link, ungated.
    msg({
      key: "n4",
      from: "Weekly Digest",
      fromEmail: "digest@club.example.org",
      subject: "This week",
      body: "Fill out our reader survey.\nUnsubscribe.",
      links: ["https://docs.google.com/forms/d/e/abc/viewform"],
    }),
    // A shipping/"payment received" receipt from Waterloo itself.
    msg({
      key: "n5",
      from: "W Store",
      fromEmail: "wstore@uwaterloo.ca",
      subject: "Order receipt",
      body: "Your payment was received and your package has shipped.",
    }),
    // A fee notice from a non-Waterloo domain.
    msg({
      key: "n6",
      from: "Bank",
      fromEmail: "alerts@bank.example.com",
      subject: "Payment due",
      body: "Your payment of $100 is due. Please pay your balance by October 15.",
    }),
  ];
  // A rhetorical newsletter question is not an ask (broadcast, list mail).
  cases.push(
    msg({
      key: "n7",
      from: "Wellness",
      fromEmail: "wellness@uwaterloo.ca",
      subject: "Thrive this term",
      body: "Are you struggling to keep on top of your deadlines? We can help.",
      toMe: false,
      recipients: 2400,
    }),
    // List-boilerplate interrogative — bulk footer marks it regardless.
    msg({
      key: "n8",
      from: "Newsroom",
      fromEmail: "news@campus.example.org",
      subject: "Weekly update",
      body: "Want to change how you receive these emails?",
      toMe: false,
      recipients: 12,
    }),
    // A [Tag] subject is list mail on its own.
    msg({
      key: "n9",
      from: "Dept Minutes",
      fromEmail: "minutes@dept.example.org",
      subject: "[CS-DSA] Minutes updated daily",
      body: "Please reply with corrections to the minutes.",
    }),
    // "book a meeting through your dashboard" in a broadcast advisor note.
    msg({
      key: "n10",
      from: "Advisor",
      fromEmail: "advisor@uwaterloo.ca",
      subject: "Advising hours",
      body: "You can book a meeting through your portal dashboard.",
      toMe: false,
      recipients: 800,
    }),
    // Money the other way — credits and refunds are never a pay to-do.
    msg({
      key: "n11",
      from: "Student Fees",
      fromEmail: "fees@uwaterloo.ca",
      subject: "Award applied",
      body: "A bursary was applied to your student account balance.",
    }),
    msg({
      key: "n12",
      from: "Student Fees",
      fromEmail: "fees@uwaterloo.ca",
      subject: "Tuition refund",
      body: "You will receive a 100% tuition refund for the dropped course.",
    }),
    // A course announcement's polite closer is not a reply ask — and the
    // message is broadcast to the class anyway.
    msg({
      key: "n13",
      from: "Prof",
      fromEmail: "prof@uwaterloo.ca",
      subject: "MATH135 week 4",
      body: "Assignment 2 is posted. Let me know if you have any questions.",
      toMe: false,
      recipients: 300,
    }),
    // A three-week-old ask is stale.
    msg({
      key: "n14",
      from: "Sam Lee",
      fromEmail: "sam.lee@freemail.example.org",
      subject: "Catching up",
      body: "Could you confirm you're still interested?",
      receivedAt: "2026-09-08T15:00:00.000Z",
    }),
    // A stated due in the past is not a to-do.
    msg({
      key: "n15",
      from: "Sam Lee",
      fromEmail: "sam.lee@freemail.example.org",
      subject: "Quick check",
      body: "Please reply by September 28.",
    }),
    // A confirmation/autoresponder never owes a reply, even when its
    // boilerplate says "please reply".
    msg({
      key: "n16",
      from: "Survey Tool",
      fromEmail: "responses@forms.example.com",
      subject: "Thanks for filling out this form: Lab survey",
      body: "Your response was recorded. Please reply to this email if you need to make changes.",
    }),
  );
  for (const m of cases) {
    const res = await adapter.observe.parse(
      payload("gmail", wrap("gmail", [m], "message", "inbox")),
      ctx({}),
    );
    assert.ok(
      res.items.every((i) => i.type !== "task" && !(i.type === "deadline" && i.meta && i.meta.action)),
      `${m.key}: expected no derived to-dos, got ${JSON.stringify(res.items.map((i) => [i.type, i.meta && i.meta.action]))}`,
    );
  }
});

test("to-do positives: person, broadcast co-op, finance, instructor, offer", async () => {
  // A person writing TO me with an explicit ask — no gate needed.
  const person = msg({
    key: "pp1",
    from: "Sam Lee",
    fromEmail: "sam.lee@freemail.example.org",
    subject: "Catching up",
    body: "Could you confirm by Friday that you can still make it?",
    toMe: true,
    recipients: 2,
  });
  const res = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [person], "message", "inbox")),
    ctx({}),
  );
  const reply = res.items.find((i) => i.meta && i.meta.action === "reply");
  assert.ok(reply, "toMe + explicit ask -> reply task");
  assert.equal(reply.review, "pending");

  // CECA list mail IS broadcast — the co-op exception still mints it.
  const coop = msg({
    key: "pp2",
    from: "Co-op Office",
    fromEmail: "coop@uwaterloo.ca",
    subject: "Interview — Firmware Co-op (Co-op message)",
    body: "Next step: Select your interview time slot in WorkHub.",
    toMe: false,
    recipients: 40,
  });
  const res2 = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [coop], "message", "inbox")),
    ctx({}),
  );
  const slot = res2.items.find((i) => i.meta && i.meta.action === "book-interview");
  assert.ok(slot, "broadcast co-op slot wording -> book-interview");
  assert.equal(slot.review, "auto");

  // Waterloo finance list mail is legitimately broadcast — pay still mints.
  const fee = msg({
    key: "pp3",
    from: "Student Fees",
    fromEmail: "fees@uwaterloo.ca",
    subject: "Fall fee statement",
    body: "Your tuition is due by October 30.",
    toMe: false,
    recipients: 40000,
  });
  const res3 = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [fee], "message", "inbox")),
    ctx({}),
  );
  const pay = res3.items.find((i) => i.meta && i.meta.action === "pay");
  assert.ok(pay, "broadcast Waterloo fee notice -> pay");
  assert.equal(pay.dueAt, "2026-10-31T03:59:00.000Z");

  // An instructor's document ask, addressed to me.
  const prof = msg({
    key: "pp4",
    from: "Prof",
    fromEmail: "prof@uwaterloo.ca",
    subject: "MATH135 lab waiver",
    body: "Please submit the signed waiver by October 5.",
    toMe: true,
    recipients: 1,
  });
  const res4 = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [prof], "message", "inbox")),
    ctx({}, { courses: [{ code: "MATH135", instructors: [{ email: "prof@uwaterloo.ca" }] }] }),
  );
  const doc = res4.items.find((i) => i.meta && i.meta.action === "submit-document");
  assert.ok(doc, "instructor document ask -> submit-document");
  assert.equal(doc.type, "deadline");
  assert.equal(doc.review, "auto");

  // An employer offer with an accept-by date (existing test covers the
  // details) — here just confirming it still lands under the new gates.
  const offer = msg({
    key: "pp5",
    from: "Acme Corp",
    fromEmail: "jobs@acme.example.com",
    subject: "Offer of employment",
    body: "We are pleased to offer you the Firmware Co-op role. Accept the offer by October 9.",
    toMe: true,
    recipients: 1,
  });
  const res5 = await adapter.observe.parse(
    payload("gmail", wrap("gmail", [offer], "message", "inbox")),
    ctx({}, { applications: [{ employer: "Acme Corp" }] }),
  );
  assert.ok(
    res5.items.some((i) => i.meta && i.meta.action === "respond-offer"),
    "employer offer -> respond-offer",
  );
});

test("email sources contain no forbidden APIs", () => {
  const SRC = path.resolve(DIR, "..", "..", "..", "extension", "src", "sources", "email");
  const FILES = [
    "content.js", "atom.js", "dom.js", "index.js", "rules.js", "selectors.js",
    "extract.js", "backfill.js", "gmail-backfill.js", "outlook-backfill.js",
  ];
  const FORBIDDEN = [
    /XMLHttpRequest/,
    /\bWebSocket\b/,
    /document\.cookie/,
    /webpackChunk/,
    /\.click\s*\(/,
    /location\.assign/,
    /location\.href\s*=(?![=])/,
    /location\.replace\s*\(/,
    /history\.pushState/,
  ];
  for (const file of FILES) {
    const src = fs.readFileSync(path.join(SRC, file), "utf8");
    for (const re of FORBIDDEN) {
      assert.equal(re.test(src), false, `${file} contains ${re}`);
    }
  }

  // Network allowlist: every request is a same-origin GET issued through an
  // injected fetchImpl — the Atom feed, Gmail ?view=pt print views and
  // Outlook /api/v2.0/me/ paths (the iframe list reads are navigations of
  // our own hidden iframe). Only content.js binds window.fetch (once for
  // the atom env, once for the backfill env); nothing else may fetch. The
  // sessionStorage throttle stamps stay in content.js + atom.js.
  for (const file of FILES) {
    const src = fs.readFileSync(path.join(SRC, file), "utf8");
    const fetches = src.match(/\bfetch\s*\(/g) || [];
    if (file === "content.js") {
      assert.ok(fetches.length <= 2, "content.js binds fetch for its envs only");
    } else {
      assert.equal(fetches.length, 0, `${file} must not fetch`);
    }
    const sessions = src.match(/sessionStorage/g) || [];
    if (file !== "content.js" && file !== "atom.js") {
      assert.equal(sessions.length, 0, `${file} must not touch sessionStorage`);
    }
    // Request urls built outside the fetch-binding file must be one of the
    // known shapes; /mail/u/…#… urls are Gmail page links for items.
    for (const m of src.matchAll(/\/mail\/u\/[^'"`\s]+/g)) {
      assert.ok(
        m[0].includes("#") || m[0].endsWith("/feed/atom") || m[0].includes("view=pt"),
        `${file} builds an unexpected mail url: ${m[0]}`,
      );
    }
  }
  const atom = fs.readFileSync(path.join(SRC, "atom.js"), "utf8");
  assert.ok(atom.includes("/feed/atom"), "atom.js carries the feed path");
  // Absolute urls it builds are Gmail thread links for items — never a
  // request target off mail.google.com.
  for (const m of atom.matchAll(/https?:\/\/[^'"`\s]+/g)) {
    assert.ok(m[0].startsWith("https://mail.google.com/mail/u/"), m[0]);
  }
});
