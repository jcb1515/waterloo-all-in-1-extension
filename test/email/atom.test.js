// @ts-check
// Gmail Atom fetch: feed parsing, throttle/freeze semantics, failure
// modes, privacy (the feed header names the account — never read it) and
// the additive guarantee. The feed XML here is invented; it only mirrors
// the real entry shape.

import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { parseHTML } from "linkedom";
import adapter from "../../extension/src/sources/email/index.js";
import { applyResult } from "../../extension/src/core/merge.js";
import { extractDates } from "../../extension/src/lib/textdates/index.js";
import {
  atomRound,
  atomFreeze,
  atomMessages,
  atomPath,
  gmailAccountIndex,
  ATOM_KEY,
  __resetAtom,
} from "../../extension/src/sources/email/atom.js";

const NOW = new Date("2026-10-01T15:00:00.000Z");
const ACCOUNT = "tester@example.invalid"; // feed header only — must never leak

const entry = ({ id, msgId, title, summary, issued, name, email }) => `
  <entry>
    <title>${title}</title>
    <summary>${summary}</summary>
    <link rel="alternate" href="https://mail.google.com/mail/u/0?account_id=x&message_id=${msgId}&view=conv&extsrc=atom"/>
    <modified>${issued}</modified>
    <issued>${issued}</issued>
    <id>tag:mail.google.com,2004:${id}</id>
    <author><name>${name}</name><email>${email}</email></author>
  </entry>`;

const feed = (entries) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://purl.org/atom/ns#">
  <title>Gmail - Inbox for ${ACCOUNT}</title>
  <tagline>New messages in your Gmail Inbox (${ACCOUNT})</tagline>
  <link rel="alternate" href="https://mail.google.com/mail/u/0" type="text/html"/>
${entries.join("\n")}
</feed>`;

const ENTRIES = [
  entry({
    id: "17a0001",
    msgId: "19c4aa01",
    title: "Project sync moved to October 8 at 2pm",
    summary: "Hi all — moving our project sync to October 8 at 2pm in MC 4045.",
    issued: "2026-10-01T13:10:00Z",
    name: "Ada Lovelace",
    email: "ada@example.invalid",
  }),
  entry({
    id: "17a0002",
    msgId: "19c4aa02",
    title: "Hack night on October 14 at 6pm",
    summary: "Reminder: hack night is October 14 at 6pm in E7. Snacks provided.",
    issued: "2026-10-01T12:00:00Z",
    name: "Club Events",
    email: "events@clubs.example.invalid",
  }),
  entry({
    id: "17a0003",
    msgId: "19c4aa03",
    title: "Weekly bulletin",
    summary: "This week in the newsletter: campus news, deals and jobs.",
    issued: "2026-10-01T09:00:00Z",
    name: "Bulletin",
    email: "newsletter@bulletin.example.invalid",
  }),
  entry({
    id: "17a0004",
    msgId: "19c4aa04",
    title: "Info session September 20",
    summary: "Thanks for coming to the info session last week.",
    issued: "2026-09-18T20:00:00Z",
    name: "Info Desk",
    email: "info@example.invalid",
  }),
];
const FEED = feed(ENTRIES);

const xmlDoc = (t) => parseHTML(t).document;

const fakeEnv = ({ status = 200, type = "text/xml; charset=UTF-8", body = FEED, last = null, frozen = false, redirected = false } = {}) => {
  /** @type {{url: string, init: any}[]} */
  const calls = [];
  /** @type {any[]} */
  const messages = [];
  let stamp = last;
  let froz = frozen;
  const env = {
    fetchImpl: async (/** @type {string} */ url, /** @type {any} */ init) => {
      calls.push({ url, init });
      return {
        status,
        redirected,
        headers: { get: (/** @type {string} */ h) => (h === "content-type" ? type : null) },
        text: async () => body,
      };
    },
    sendMessage: (/** @type {any} */ m) => messages.push(m),
    parseXml: xmlDoc,
    getLast: () => stamp,
    setLast: (/** @type {any} */ s) => {
      stamp = s;
    },
    isFrozen: () => froz,
    account: 0,
    pageUrl: "https://mail.google.com/mail/u/0/#inbox",
    now: NOW,
  };
  return {
    env,
    calls,
    messages,
    setFrozen: (/** @type {boolean} */ v) => {
      froz = v;
    },
    getStamp: () => stamp,
  };
};

beforeEach(() => __resetAtom());

const ctx = (state = {}) => ({
  now: NOW,
  settings: {},
  state,
  courses: [],
  terms: [],
  log: () => {},
  textDates: extractDates,
  fetch: async () => ({ status: 0 }),
  relay: async () => ({ status: 0 }),
  parseHtml: async () => null,
});

test("atom path and account index", () => {
  assert.equal(atomPath(0), "/mail/u/0/feed/atom");
  assert.equal(atomPath(3), "/mail/u/3/feed/atom");
  assert.equal(gmailAccountIndex("/mail/u/2/"), 2);
  assert.equal(gmailAccountIndex("/mail/u/0/#inbox"), 0);
  assert.equal(gmailAccountIndex(""), 0);
  assert.equal(ATOM_KEY, "wa1:gmail:atomAt");
});

test("atomMessages: entries -> list-row messages, feed header never read", () => {
  const msgs = atomMessages(xmlDoc(FEED));
  assert.equal(msgs.length, 4);
  const first = msgs[0];
  assert.equal(first.key, "19c4aa01"); // message_id from the link href
  assert.equal(first.subject, "Project sync moved to October 8 at 2pm");
  assert.equal(first.from, "Ada Lovelace");
  assert.equal(first.fromEmail, "ada@example.invalid");
  assert.equal(first.receivedAt, "2026-10-01T13:10:00.000Z");
  assert.equal(first.url, "https://mail.google.com/mail/u/0/#inbox/19c4aa01");
  // The account address lives in <title>/<tagline> only — never forwarded.
  assert.ok(!JSON.stringify(msgs).includes(ACCOUNT));
});

test("atomMessages: <id> tail is the key when no link href", () => {
  const e = entry({
    id: "88f0",
    msgId: "",
    title: "Welcome",
    summary: "hi",
    issued: "2026-10-01T10:00:00Z",
    name: "A",
    email: "a@b.invalid",
  }).replace(/message_id=&/, "x=1&");
  const msgs = atomMessages(xmlDoc(feed([e])));
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].key, "88f0");
});

test("a feed fetch sends one observed gmail dom payload and stamps ok", async () => {
  const { env, calls, messages, getStamp } = fakeEnv();
  const r = await atomRound(env);
  assert.equal(r.sent, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/mail/u/0/feed/atom");
  assert.equal(calls[0].init.credentials, "same-origin");

  const msg = messages[0];
  assert.equal(msg.payload.source, "gmail");
  assert.equal(msg.payload.kind, "dom");
  const body = JSON.parse(msg.payload.body);
  assert.equal(body.provider, "gmail");
  assert.equal(body.view, "atom");
  assert.equal(body.folder, "inbox");
  assert.equal(body.messages.length, 4);
  assert.ok(!JSON.stringify(msg).includes(ACCOUNT)); // header never leaks
  assert.deepEqual(getStamp(), { at: NOW.getTime(), ok: true });
});

test("throttle: 30 min after a success, 5 min after a failure", async () => {
  const { env, calls } = fakeEnv();
  await atomRound(env);
  const r = await atomRound(env);
  assert.equal(r.skipped, "throttled");
  assert.equal(calls.length, 1);

  const f2 = fakeEnv({ status: 503 });
  await atomRound(f2.env);
  assert.equal(f2.getStamp().ok, false);
  // 4 min later: still blocked. 6 min later: retries.
  const f3 = fakeEnv({ last: f2.getStamp() });
  f3.env.now = new Date(NOW.getTime() + 4 * 60 * 1000);
  assert.equal((await atomRound(f3.env)).skipped, "throttled");
  f3.env.now = new Date(NOW.getTime() + 6 * 60 * 1000);
  const r3 = await atomRound(f3.env);
  assert.equal(r3.sent, 1);
});

test("a frozen tab runs nothing", async () => {
  const { env, calls } = fakeEnv({ frozen: true });
  const r = await atomRound(env);
  assert.equal(r.skipped, "frozen");
  assert.equal(calls.length, 0);
});

test("a frozen in-flight fetch settles stale and the resume refetches once", async () => {
  let settle = /** @type {(v: any) => void} */ (() => {});
  const f = fakeEnv();
  f.env.fetchImpl = async (url, init) => {
    f.calls.push({ url, init });
    return new Promise((r) => (settle = r));
  };
  const p1 = atomRound(f.env);
  await new Promise((r) => setTimeout(r, 0));
  atomFreeze(); // the page froze with the fetch in flight
  settle({
    status: 200,
    headers: { get: () => "text/xml" },
    text: async () => FEED,
  });
  const r1 = await p1;
  assert.equal(r1.stale, true);
  assert.equal(f.messages.length, 0);
  assert.equal(f.getStamp(), null); // never stamped — the resume may retry

  const p2 = atomRound(f.env); // thawed: runs and parks on the fetch
  await new Promise((r) => setTimeout(r, 0));
  settle({
    status: 200,
    headers: { get: () => "text/xml" },
    text: async () => FEED,
  });
  const r2 = await p2;
  assert.equal(r2.sent, 1);
  assert.equal(f.messages.length, 1);
  assert.equal(f.calls.length, 2); // exactly one refetch
});

test("non-200, redirect and html all send nothing and retry in 5 min", async () => {
  for (const over of [
    { status: 401 },
    { redirected: true },
    { type: "text/html; charset=UTF-8" },
  ]) {
    const f = fakeEnv(over);
    const r = await atomRound(f.env);
    assert.equal(r.sent, 0, JSON.stringify(over));
    assert.equal(f.messages.length, 0);
    assert.equal(f.getStamp().ok, false);
    assert.ok(String(r.error).startsWith("http-"));
  }
});

test("adapter: the atom payload parses with its own non-authoritative scope", async () => {
  const body = {
    v: 1,
    provider: "gmail",
    folder: "inbox",
    view: "atom",
    messages: atomMessages(xmlDoc(FEED)),
  };
  const res = await adapter.observe.parse(
    {
      source: "gmail",
      kind: "dom",
      url: "https://mail.google.com/mail/u/0/#inbox",
      body: JSON.stringify(body),
      at: NOW.toISOString(),
    },
    ctx(),
  );
  assert.equal(res.scope, "email:gmail:atom");
  assert.deepEqual(res.readOk, ["email:gmail:atom"]);
  assert.equal(res.complete, true);
  assert.ok(res.items.length >= 2, `items: ${res.items.length}`);
  // Newsletter stays suppressed; the September 20 mail is already past.
  assert.ok(!res.items.some((i) => /bulletin|newsletter/i.test(i.title)));
  assert.ok(!res.items.some((i) => /info session/i.test(i.title)));
  assert.ok(!JSON.stringify(res).includes(ACCOUNT));
});

test("atom items keep the same ids as the list-row path", async () => {
  const msgs = atomMessages(xmlDoc(FEED));
  const mk = (view) =>
    adapter.observe.parse(
      {
        source: "gmail",
        kind: "dom",
        url: "https://mail.google.com/mail/u/0/#inbox",
        body: JSON.stringify({ v: 1, provider: "gmail", folder: "inbox", view, messages: msgs }),
        at: NOW.toISOString(),
      },
      ctx(),
    );
  const atom = await mk("atom");
  const list = await mk("list");
  const ids = (r) => r.items.map((i) => i.id).sort();
  assert.deepEqual(ids(atom), ids(list));
});

test("an entry leaving the unread feed never deletes its item", async () => {
  const msgs = atomMessages(xmlDoc(FEED));
  const wrap = (ms) => ({
    source: "gmail",
    kind: "dom",
    url: "https://mail.google.com/mail/u/0/#inbox",
    body: JSON.stringify({ v: 1, provider: "gmail", folder: "inbox", view: "atom", messages: ms }),
    at: NOW.toISOString(),
  });
  const r1 = await adapter.observe.parse(wrap(msgs), ctx());
  const raw1 = applyResult(null, r1, { mode: "scope", scope: r1.scope });
  assert.ok(raw1.items.length >= 2);

  // Second read: the user read two threads — the feed drops them.
  const r2 = await adapter.observe.parse(wrap(msgs.slice(2)), ctx(r1.state));
  const raw2 = applyResult(raw1, r2, { mode: "scope", scope: r2.scope });
  assert.equal(raw2.items.length, raw1.items.length, "entries must be additive");
});
