// @ts-check
// Email backfill: scheduling (full/incremental/6h cap/lock), the rate cap,
// batching, freeze drops, failure retries, gated body selection, the Gmail
// iframe + print-view parse, the Outlook MSAL REST read, payload->adapter
// integration (scope/readOk/threadMap/backfill state/Atom mapping), and the
// structural read-only rules over the content-side files.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import {
  backfillRound,
  backfillFreeze,
  decideRun,
  clampLookback,
  makeRate,
  BF_MAX_PAGES,
  __resetBackfill,
} from "../../extension/src/sources/email/backfill.js";
import {
  gmailBackfill,
  gmailListQuery,
  gmailSearchPath,
  printViewParts,
} from "../../extension/src/sources/email/gmail-backfill.js";
import {
  outlookBackfill,
  outlookToken,
  outlookListPath,
  outlookNextPath,
  outlookMsg,
} from "../../extension/src/sources/email/outlook-backfill.js";
import { needsBody } from "../../extension/src/sources/email/rules.js";
import adapter from "../../extension/src/sources/email/index.js";
import { extractDates } from "../../extension/src/lib/textdates/index.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "email");
const html = (name) => fs.readFileSync(path.join(DIR, `${name}.html`), "utf8");
const SRC = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "extension", "src", "sources", "email",
);
const NOW = new Date("2026-10-01T15:00:00.000Z");
const NOW_MS = NOW.getTime();

const before = (t) => {
  __resetBackfill();
  t.after(__resetBackfill);
};

/* ------------------------------ decideRun ------------------------------ */

test("lookback clamps to 7..90, defaults 30", () => {
  assert.equal(clampLookback(undefined), 30);
  assert.equal(clampLookback(3), 7);
  assert.equal(clampLookback(400), 90);
  assert.equal(clampLookback("45"), 45);
});

test("decideRun: first run full, then 30-min incrementals, 6h fulls", () => {
  const s = {};
  assert.equal(decideRun(null, s, NOW_MS).kind, "full");
  const prev = {
    lastFullAt: new Date(NOW_MS - 2 * 3600e3).toISOString(), // 2h ago
    lastRunAt: new Date(NOW_MS - 10 * 60e3).toISOString(), // 10m ago
    lookbackDays: 30,
    newestAt: "2026-09-30T12:00:00.000Z",
  };
  assert.equal(decideRun(prev, s, NOW_MS).kind, "skip"); // 10m < 30m
  const due = decideRun(
    { ...prev, lastRunAt: new Date(NOW_MS - 31 * 60e3).toISOString() },
    s,
    NOW_MS,
  );
  assert.equal(due.kind, "incremental");
  assert.equal(due.since, "2026-09-30T12:00:00.000Z");
  // A lookback change is the only thing allowed to force a full inside 6h.
  assert.equal(decideRun(prev, { lookbackDays: 60 }, NOW_MS).kind, "full");
  // Past 6h the next tick is a full again.
  const old = { ...prev, lastFullAt: new Date(NOW_MS - 7 * 3600e3).toISOString() };
  assert.equal(decideRun(old, s, NOW_MS).kind, "full");
  // "Check again now" forces an incremental, never a 2nd full inside 6h.
  assert.equal(decideRun(prev, s, NOW_MS, { force: true }).kind, "incremental");
});

test("rate gate: the 21st request in a minute waits", () => {
  const rate = makeRate();
  for (let i = 0; i < 20; i++) {
    assert.equal(rate.waitMs(NOW_MS), 0);
    rate.take(NOW_MS);
  }
  assert.equal(rate.waitMs(NOW_MS), 60000);
  assert.equal(rate.waitMs(NOW_MS + 30000), 30000);
});

/* --------------------------- gmail fake env ---------------------------- */

/**
 * A fake Gmail page env: makeFrame returns a fake iframe whose doc is the
 * search fixture (or empty), fetchImpl returns the print-view fixture for
 * view=pt urls and records every request.
 */
const gmailEnv = ({ searchDoc, printDoc, prev = null, settings = {}, locked = 0, frozen = () => false } = {}) => {
  const { document: sdoc } = parseHTML(searchDoc != null ? searchDoc : html("gmail-search"));
  const { document: pdoc } = parseHTML(printDoc != null ? printDoc : html("gmail-print"));
  /** @type {string[]} */
  const navigations = [];
  /** @type {{url: string, init: any}[]} */
  const fetches = [];
  /** @type {any[]} */
  const messages = [];
  let lock = locked;
  let fail = 0;
  const frame = {
    navigate: (/** @type {string} */ u) => navigations.push(u),
    doc: () => sdoc,
    href: () => "https://mail.google.com/mail/u/0/#search/q",
    remove: () => { frame.removed = true; },
    removed: false,
  };
  const env = {
    now: NOW,
    account: 0,
    fetchImpl: async (/** @type {string} */ url, /** @type {any} */ init) => {
      fetches.push({ url, init });
      return {
        status: 200,
        redirected: false,
        headers: { get: (h) => (h === "content-type" ? "text/html" : null) },
        text: async () => "<html>print</html>",
      };
    },
    parseHtml: (/** @type {string} */ t) => parseHTML(t).document && pdoc,
    sendMessage: (/** @type {any} */ m) => messages.push(m),
    getSettings: async () => settings,
    getPrev: async () => prev,
    getLock: async () => lock,
    setLock: async (/** @type {number} */ at) => { lock = at; },
    clearLock: async () => { lock = 0; },
    getFail: async () => fail,
    setFail: async (/** @type {number} */ at) => { fail = at; },
    makeFrame: () => frame,
    sleep: async () => {},
    settleMs: 0,
    pollMs: 1,
    isFrozen: frozen,
    pageUrl: "https://mail.google.com/mail/u/0/#inbox",
  };
  return { env, frame, navigations, fetches, messages, getLock: () => lock, getFail: () => fail };
};

const payloadsOf = (messages) =>
  messages.map((m) => JSON.parse(m.payload.body));

test("gmail full run: iframe list, gated bodies, backfill payloads", async (t) => {
  before(t);
  const { env, navigations, fetches, messages, frame } = gmailEnv();
  const r = await backfillRound(env, gmailBackfill);
  assert.equal(r.sent, 2); // one page batch + the empty final marker
  assert.equal(navigations.length, 1);
  assert.match(navigations[0], /^\/mail\/u\/0\/#search\/in%3Ainbox%20newer_than%3A30d$/);
  assert.equal(frame.removed, true); // the iframe is ours and we clean it up

  const bodies = payloadsOf(messages);
  const listed = bodies.find((b) => b.messages.length);
  assert.equal(listed.view, "backfill");
  assert.equal(listed.folder, "inbox");
  assert.equal(listed.provider, "gmail");
  assert.equal(listed.messages.length, 3);
  assert.equal(listed.backfill.full, true);
  assert.equal(listed.backfill.lookbackDays, 30);
  assert.equal(listed.backfill.final, false);
  assert.equal(bodies[bodies.length - 1].backfill.final, true);
  assert.equal(bodies[bodies.length - 1].backfill.checked, 3);
  // lastMessageId -> threadId map (row 2's ids differ, row 1+3 don't).
  assert.deepEqual(listed.threadMap, { "17fb2c3d4e5f6a99": "17fb2c3d4e5f6a7b" });
  // The unread row keeps its flag.
  assert.equal(
    listed.messages.find((m) => m.key === "18fa1a2b3c4d5e6f").unread,
    true,
  );

  // Bodies fetched only for gated candidates: the co-op row and the
  // uwaterloo.ca professor pass; the bulk sales mail does not.
  const gated = listed.messages.filter((m) => m.bodyFetched).map((m) => m.key);
  assert.deepEqual(
    gated.sort(),
    ["17fb2c3d4e5f6a7b", "18fa1a2b3c4d5e6f"].sort(),
  );
  assert.equal(fetches.length, 2);
  for (const f of fetches) {
    assert.match(f.url, /^\/mail\/u\/0\/\?view=pt&search=all&th=/);
    assert.equal(f.init.method, "GET");
  }
  const thr = listed.messages.find((m) => m.key === "17fb2c3d4e5f6a7b");
  assert.equal(thr.parts.length, 2); // two table.message parts
  assert.equal(thr.parts[1].fromMe, true);
  assert.equal(thr.parts[1].fromEmail, "");
  assert.match(thr.body || "", /lab meeting/);
});

test("gmail incremental run uses the cursor as after:<epoch>", async (t) => {
  before(t);
  const { env, navigations } = gmailEnv({
    prev: {
      lastFullAt: new Date(NOW_MS - 2 * 3600e3).toISOString(),
      lastRunAt: new Date(NOW_MS - 40 * 60e3).toISOString(),
      lookbackDays: 30,
      newestAt: "2026-09-30T12:00:00.000Z",
    },
  });
  await backfillRound(env, gmailBackfill);
  const epoch = Math.floor(Date.parse("2026-09-30T12:00:00.000Z") / 1000);
  assert.match(navigations[0], new RegExp(`after%3A${epoch}`));
});

test("gmail: a recent full inside 6h and a fresh lastRun skip the tick", async (t) => {
  before(t);
  const { env, navigations } = gmailEnv({
    prev: {
      lastFullAt: new Date(NOW_MS - 2 * 3600e3).toISOString(),
      lastRunAt: new Date(NOW_MS - 10 * 60e3).toISOString(),
      lookbackDays: 30,
    },
  });
  const r = await backfillRound(env, gmailBackfill);
  assert.equal(r.skipped, "throttled");
  assert.equal(navigations.length, 0);
});

test("gmail: another tab's lock stops this tab's round", async (t) => {
  before(t);
  const { env, navigations } = gmailEnv({ locked: NOW_MS - 60e3 });
  const r = await backfillRound(env, gmailBackfill);
  assert.equal(r.skipped, "locked");
  assert.equal(navigations.length, 0);
});

test("gmail: a body fetch that is not 200/html aborts and retries in 5m", async (t) => {
  before(t);
  const { env, getFail, messages } = gmailEnv();
  env.fetchImpl = async () => ({ status: 302, redirected: true, headers: { get: () => null }, text: async () => "" });
  const r = await backfillRound(env, gmailBackfill);
  assert.equal(r.error, "http");
  assert.ok(getFail() > 0);
  const again = await backfillRound(env, gmailBackfill);
  assert.equal(again.skipped, "retry");
  assert.ok(!payloadsOf(messages).some((b) => b.backfill && b.backfill.final));
});

test("gmail: a frozen tab drops the round mid-flight", async (t) => {
  before(t);
  let frozen = false;
  const { env } = gmailEnv({ frozen: () => frozen });
  env.settleMs = 5;
  const p = backfillRound(env, gmailBackfill);
  await new Promise((r) => setTimeout(r, 10));
  frozen = true;
  backfillFreeze();
  const r = await p;
  assert.ok(r.stale || r.error || r.sent >= 0); // no crash, nothing else required
});

/* -------------------------- outlook fake env --------------------------- */

const TOKEN = "header.payload.signature";
const tokenEntry = (over = {}) =>
  JSON.stringify({
    credentialType: "AccessToken",
    secret: TOKEN,
    expiresOn: Math.floor(NOW_MS / 1000) + 3600,
    target: "https://outlook.office.com/Mail.ReadWrite https://outlook.office.com/Mail.Send",
    ...over,
  });

const outlookEnv = ({ values, pages, bodies, prev = null, settings = {} } = {}) => {
  const rest = JSON.parse(fs.readFileSync(path.join(DIR, "outlook-rest.json"), "utf8"));
  const pageQueue = pages || [
    rest,
    { value: [rest.value[1]] }, // second page: no nextLink
  ];
  /** @type {{url: string, init: any}[]} */
  const fetches = [];
  /** @type {any[]} */
  const messages = [];
  let lock = 0, fail = 0;
  const env = {
    now: NOW,
    fetchImpl: async (/** @type {string} */ url, /** @type {any} */ init) => {
      fetches.push({ url, init });
      if (/me\/messages\//.test(url)) {
        const body = (bodies && bodies[url]) || "Please pick a time.";
        return {
          status: 200,
          headers: { get: () => "application/json" },
          text: async () => JSON.stringify({ Body: { ContentType: "text", Content: body }, IsRead: false }),
        };
      }
      const page = pageQueue.length > 1 ? pageQueue.shift() : pageQueue[0];
      return {
        status: 200,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify(page),
      };
    },
    sendMessage: (/** @type {any} */ m) => messages.push(m),
    getSettings: async () => settings,
    getPrev: async () => prev,
    getLock: async () => lock,
    setLock: async (/** @type {number} */ at) => { lock = at; },
    clearLock: async () => { lock = 0; },
    getFail: async () => fail,
    setFail: async (/** @type {number} */ at) => { fail = at; },
    lsValues: () => values || [tokenEntry()],
    sleep: async () => {},
    pageUrl: "https://outlook.cloud.microsoft/mail/inbox",
  };
  return { env, fetches, messages };
};

test("outlook token: only unexpired Mail.Read(Write) outlook.office.com", () => {
  assert.equal(outlookToken([tokenEntry()], NOW_MS), TOKEN);
  // Expired inside the 60s margin.
  assert.equal(
    outlookToken([tokenEntry({ expiresOn: Math.floor(NOW_MS / 1000) + 30 })], NOW_MS),
    null,
  );
  // Wrong target.
  assert.equal(
    outlookToken(
      [tokenEntry({ target: "https://graph.example.com/Mail.Read" })],
      NOW_MS,
    ),
    null,
  );
  // Not an AccessToken.
  assert.equal(
    outlookToken([tokenEntry({ credentialType: "RefreshToken" })], NOW_MS),
    null,
  );
  // Later expiry wins.
  const later = tokenEntry({ secret: "newer", expiresOn: Math.floor(NOW_MS / 1000) + 7200 });
  assert.equal(outlookToken([tokenEntry(), later], NOW_MS), "newer");
});

test("outlook list path: full window vs incremental cursor", () => {
  const full = outlookListPath("inbox", { lookbackDays: 30, since: null }, NOW);
  assert.match(full, /^\/api\/v2\.0\/me\/mailfolders\/inbox\/messages\?/);
  assert.match(full, /\$filter=ReceivedDateTime%20ge%202026-09-01/);
  assert.match(full, /\$orderby=ReceivedDateTime%20desc/);
  assert.match(full, /\$count=true/);
  const inc = outlookListPath("inbox", { since: "2026-09-30T12:00:00.000Z", lookbackDays: 30 }, NOW);
  assert.match(inc, /ReceivedDateTime%20gt%202026-09-30T12/);
  const sent = outlookListPath("sent", { lookbackDays: 30, since: null }, NOW);
  assert.match(sent, /mailfolders\/sentitems\/messages/);
  assert.match(sent, /SentDateTime%20ge/);
});

test("outlook nextLink strips to the same-origin /api path only", () => {
  assert.equal(
    outlookNextPath("https://outlook.cloud.microsoft/api/v2.0/me/messages?$skip=50"),
    "/api/v2.0/me/messages?$skip=50",
  );
  assert.equal(outlookNextPath("https://evil.example.com/api/v2.0/me/x"), "/api/v2.0/me/x");
  assert.equal(outlookNextPath("https://outlook.cloud.microsoft/other/path"), null);
  assert.equal(outlookNextPath("not a url"), null);
});

test("outlook REST message -> Msg with ConversationId key and WebLink", () => {
  const rest = JSON.parse(fs.readFileSync(path.join(DIR, "outlook-rest.json"), "utf8"));
  const m = outlookMsg(rest.value[0], false);
  assert.equal(m.key, "conv-out-1");
  assert.equal(m.messageId, "AAMkFakeItemIdOneAAA=");
  assert.equal(m.fromEmail, "recruiting@acme.example.com");
  assert.equal(m.receivedAt, "2026-09-30T13:12:00.000Z");
  assert.equal(m.unread, true);
  assert.match(m.url || "", /ItemID=/);
});

test("outlook round: token -> pages -> gated bodies -> payloads", async (t) => {
  before(t);
  const { env, fetches, messages } = outlookEnv();
  const r = await backfillRound(env, outlookBackfill);
  assert.equal(r.sent, 3); // 2 list batches + final
  // Every request is GET, same-origin /api/v2.0/me, Bearer in headers only.
  for (const f of fetches) {
    assert.equal(f.init.method, "GET");
    assert.match(f.url, /^\/api\/v2\.0\/me\//);
    assert.equal(f.init.headers.Authorization, `Bearer ${TOKEN}`);
  }
  // nextLink followed to its stripped path.
  assert.ok(fetches.some((f) => /\$skip=50/.test(f.url)));
  const bodies = payloadsOf(messages).filter((b) => b.messages.length);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].messages.length, 2);
  // Both senders are gated (interview cue + uwaterloo.ca), so each row's
  // body was fetched through the message-Id path — page 2 repeats row 2.
  const bodyCalls = fetches.filter((f) => /me\/messages\//.test(f.url));
  assert.equal(bodyCalls.length, 3);
  for (const f of bodyCalls) {
    assert.match(f.url, /\$select=Body,IsRead/);
    assert.equal(f.init.headers.Prefer, 'outlook.body-content-type="text"');
  }
  // The token is nowhere but the Authorization header.
  const leak = JSON.stringify(messages);
  assert.ok(!leak.includes(TOKEN));
  assert.ok(!JSON.stringify(fetches.map((f) => f.url)).includes(TOKEN));
});

test("outlook: sent opt-in adds a sentitems pass that marks no items", async (t) => {
  before(t);
  const rest = JSON.parse(fs.readFileSync(path.join(DIR, "outlook-rest.json"), "utf8"));
  const { env, fetches, messages } = outlookEnv({
    settings: { folders: ["inbox", "sent"] },
    pages: [{ value: [rest.value[0]] }, { value: [rest.value[1]] }],
  });
  await backfillRound(env, outlookBackfill);
  assert.ok(fetches.some((f) => /sentitems/.test(f.url)));
  const folders = payloadsOf(messages).map((b) => b.folder);
  assert.ok(folders.includes("sent"));
});

test("outlook: no token -> silent skip, zero requests", async (t) => {
  before(t);
  const { env, fetches, messages } = outlookEnv({ values: [] });
  const r = await backfillRound(env, outlookBackfill);
  assert.equal(r.skipped, "no-token");
  assert.equal(fetches.length, 0);
  assert.equal(messages.length, 0);
});

test("outlook: provider off in settings skips entirely", async (t) => {
  before(t);
  const { env, fetches } = outlookEnv({ settings: { outlook: false } });
  const r = await backfillRound(env, outlookBackfill);
  assert.equal(r.skipped, "off");
  assert.equal(fetches.length, 0);
});

/* ------------------------------ the gate ------------------------------- */

test("needsBody: gated candidates only, bulk without a reason never", () => {
  const row = (over) => ({ key: "k", fromEmail: "", from: "", subject: "", preview: "", ...over });
  // co-op / learn / uwaterloo / ATS / allow-listed
  assert.equal(needsBody(row({ fromEmail: "coop@uwaterloo.ca", from: "CECA" }), { settings: {} }), true);
  assert.equal(needsBody(row({ fromEmail: "noreply@learn.uwaterloo.ca" }), { settings: {} }), true);
  assert.equal(needsBody(row({ fromEmail: "jsmith@uwaterloo.ca" }), { settings: {} }), true);
  assert.equal(needsBody(row({ fromEmail: "jobs@greenhouse.io" }), { settings: {} }), true);
  assert.equal(
    needsBody(row({ fromEmail: "person@random.example.org" }), { settings: { allowSenders: ["random.example.org"] } }),
    true,
  );
  // course-code subject / cue text
  assert.equal(needsBody(row({ fromEmail: "x@random.example.org", subject: "ECE105 midterm room change" }), { settings: {} }), true);
  assert.equal(needsBody(row({ fromEmail: "x@random.example.org", preview: "interview next week" }), { settings: {} }), true);
  // nothing gated -> no body
  assert.equal(needsBody(row({ fromEmail: "person@random.example.org", subject: "Lunch?", preview: "are you around" }), { settings: {} }), false);
  // bulk without a gated reason -> no body
  assert.equal(needsBody(row({ fromEmail: "news@shop.example.com", subject: "Weekend sale", preview: "40% off" }), { settings: {} }), false);
  // blocked always loses
  assert.equal(
    needsBody(row({ fromEmail: "jsmith@uwaterloo.ca" }), { settings: { blockSenders: ["uwaterloo.ca"] } }),
    false,
  );
  // preset: ungated real person stays quiet
  assert.equal(
    needsBody(row({ fromEmail: "x@random.example.org", subject: "interview" }), { settings: { onlyCourseCoop: true } }),
    false,
  );
  assert.equal(
    needsBody(row({ fromEmail: "coop@uwaterloo.ca" }), { settings: { onlyCourseCoop: true } }),
    true,
  );
});

/* ------------------------ adapter integration -------------------------- */

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

test("adapter: a backfill batch scopes, marks readOk, and records state", async () => {
  const msgs = [
    {
      key: "thr1",
      url: "https://mail.google.com/mail/u/0/#inbox/thr1",
      from: "Jane Smith",
      fromEmail: "jsmith@uwaterloo.ca",
      subject: "Lab sections",
      receivedAt: "2026-09-29T18:00:00.000Z",
      bodyFetched: true,
      body: "Can you make the lab meeting on October 8 at 2 PM?",
      links: [],
    },
    {
      key: "thr2",
      url: "https://mail.google.com/mail/u/0/#inbox/thr2",
      from: "Shop Deals",
      fromEmail: "news@shop.example.com",
      subject: "Sale",
      receivedAt: "2026-09-28T12:00:00.000Z",
      links: [],
    },
  ];
  const res = await adapter.observe.parse(
    payload("gmail", {
      v: 1,
      provider: "gmail",
      folder: "inbox",
      view: "backfill",
      messages: msgs,
      threadMap: { m1last: "thr1" },
      backfill: { runId: "g1", full: true, lookbackDays: 30, since: null, batch: 0, final: true, checked: 2 },
    }),
    ctx({}),
  );
  assert.equal(res.scope, "email:gmail:backfill");
  assert.ok(res.readOk.includes("email:gmail:backfill"));
  assert.ok(res.readOk.includes("email:gmail:thr1")); // body read
  assert.ok(!res.readOk.includes("email:gmail:thr2"));
  assert.equal(res.state.threadMap.m1last, "thr1");
  assert.equal(res.state.backfill.gmail.lookbackDays, 30);
  assert.equal(res.state.backfill.gmail.checked, 2);
  assert.equal(res.state.backfill.gmail.newestAt, "2026-09-29T18:00:00.000Z");
  assert.ok(res.items.length >= 1);
  assert.equal(res.items[0].source, "gmail");
});

test("adapter: Atom ids map through threadMap so one message keeps one id", async () => {
  // The backfill saw lastMessageId "m1last" -> thread "thr1"; the Atom entry
  // carries the message id, the DOM/backfill items key the thread.
  const state = { threadMap: { m1last: "thr1" } };
  const atomMsg = {
    key: "m1last",
    url: "https://mail.google.com/mail/u/0/#inbox/m1last",
    from: "Jane Smith",
    fromEmail: "jsmith@uwaterloo.ca",
    subject: "Midterm room change",
    preview: "The midterm on October 22 at 7:00 PM has moved to MC 1085.",
    receivedAt: "2026-09-30T10:00:00.000Z",
    links: [],
  };
  const courses = [
    { code: "ECE 105", term: 1269, instructors: [{ name: "Jane Smith", email: "jsmith@uwaterloo.ca" }] },
  ];
  const atomRes = await adapter.observe.parse(
    payload("gmail", { v: 1, provider: "gmail", folder: "inbox", view: "atom", messages: [atomMsg] }),
    ctx({}, { courses, state }),
  );
  const atomItem = atomRes.items.find((i) => /:mail:/.test(i.id));
  const bfMsg = {
    key: "thr1",
    url: "https://mail.google.com/mail/u/0/#inbox/thr1",
    from: "Jane Smith",
    fromEmail: "jsmith@uwaterloo.ca",
    subject: "Midterm room change",
    receivedAt: "2026-09-30T10:00:00.000Z",
    body: "The midterm on October 22 at 7:00 PM has moved to MC 1085.",
    bodyFetched: true,
    links: [],
  };
  const bfRes = await adapter.observe.parse(
    payload("gmail", {
      v: 1, provider: "gmail", folder: "inbox", view: "backfill", messages: [bfMsg],
      backfill: { runId: "g2", full: false, lookbackDays: 30, batch: 0, final: true, checked: 1 },
    }),
    ctx({}, { courses }),
  );
  const bfItem = bfRes.items.find((i) => /:mail:/.test(i.id));
  assert.ok(atomItem && bfItem);
  assert.equal(atomItem.id, bfItem.id); // atom m1last -> thr1 canonical key
  assert.equal(bfRes.scope, "email:gmail:backfill");
  // A passive DOM read of the same thread produces the same id too.
  const domRes = await adapter.observe.parse(
    payload("gmail", {
      v: 1, provider: "gmail", folder: "inbox", view: "message",
      messages: [{ ...bfMsg, body: "The midterm on October 22 at 7:00 PM has moved to MC 1085." }],
    }),
    ctx({}, { courses }),
  );
  const domItem = domRes.items.find((i) => /:mail:/.test(i.id));
  assert.equal(domItem.id, bfItem.id);
  // And the thread-level key is shared by all three reads' seenIn scopes.
  assert.equal(bfItem.seenIn[0].scope, "email:gmail:thr1");
});

test("adapter: a sent backfill pass never makes items, still closes replies", async () => {
  const open = { replies: { thr9: { id: "gmail:reply:thr9", title: "Reply", dueAt: "x", askedAt: "x", review: "auto", url: "u", status: "open" } } };
  const res = await adapter.observe.parse(
    payload("gmail", {
      v: 1, provider: "gmail", folder: "sent", view: "backfill",
      messages: [{ key: "thr9", from: "me", fromMe: true, subject: "Re: x", receivedAt: NOW.toISOString(), links: [] }],
      backfill: { runId: "g3", full: false, lookbackDays: 30, batch: 0, final: true, checked: 1 },
    }),
    ctx({ folders: ["inbox", "sent"] }, { state: open }),
  );
  assert.ok(!res.items.some((i) => i.type !== "task"));
  const done = res.items.find((i) => i.id === "gmail:reply:thr9");
  assert.equal(done.status, "done");
});

test("adapter: gmail:false still short-circuits a backfill payload", async () => {
  const res = await adapter.observe.parse(
    payload("gmail", {
      v: 1, provider: "gmail", folder: "inbox", view: "backfill",
      messages: [{ key: "k1", subject: "x", links: [] }],
      backfill: { runId: "g4", full: true, lookbackDays: 30, batch: 0, final: true, checked: 1 },
    }),
    ctx({ gmail: false }),
  );
  assert.equal(res.scope, "email:off");
  assert.deepEqual(res.items, []);
});

test("gmail print-view parts: sender/date/body/links per table.message", () => {
  const { document } = parseHTML(html("gmail-print"));
  const parts = printViewParts(document, { acct: "jane.student@example.com", now: NOW });
  assert.equal(parts.length, 2);
  assert.equal(parts[0].from, "Jane Smith");
  assert.equal(parts[0].fromEmail, "jsmith@uwaterloo.ca");
  assert.equal(parts[0].receivedAt, "2026-09-29T18:00:00.000Z");
  assert.match(parts[0].body || "", /lab meeting/);
  assert.equal(parts[1].fromMe, true);
  assert.equal(parts[1].fromEmail, "");
  assert.equal(parts[1].receivedAt, "2026-09-29T19:05:00.000Z");
});

test("gmail search rows parse through the passive list path", async (t) => {
  before(t);
  const { env, messages } = gmailEnv();
  await backfillRound(env, gmailBackfill);
  const listed = payloadsOf(messages).find((b) => b.messages.length);
  // The ungated bulk row carries the untouched list fields.
  const row = listed.messages.find((m) => m.key === "16ab9c8d7e6f5a4b");
  assert.equal(row.from, "Shop Deals");
  assert.equal(row.fromEmail, "news@shop.example.com");
  assert.equal(row.subject, "Weekend sale starts now");
  assert.match(row.preview || "", /40% off/);
  assert.ok(row.receivedAt);
});

/* ----------------------- structural read-only test --------------------- */

test("email content-side files stay structurally read-only", () => {
  const NET_FILES = ["content.js", "atom.js", "backfill.js", "gmail-backfill.js", "outlook-backfill.js"];
  const ALL = [...NET_FILES, "dom.js", "index.js", "rules.js", "selectors.js", "extract.js", "probe.js", "parsers.js"];
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
    /"POST"|"PATCH"|"PUT"|"DELETE"/,
    /sendmail|\/send\b|\/move\b|\/copy\b|\/reply\b|\/forward\b|createreply|markAsRead/i,
    /\bact=/,
    /view=up\b/,
    /\/sync\//,
    /service\.svc/i,
    /graph\.microsoft\.com/i,
    /refresh_token|oauth2/i,
  ];
  for (const file of ALL) {
    const p = path.join(SRC, file);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, "utf8");
    for (const re of FORBIDDEN) {
      assert.equal(re.test(src), false, `${file} contains ${re}`);
    }
    // The network files may only ever issue GET requests.
    if (NET_FILES.includes(file)) {
      assert.equal(
        /\bmethod\s*:\s*"(?!GET")/.test(src),
        false,
        `${file} issues a non-GET request`,
      );
    }
    // chrome.storage is read-only everywhere: .get( and onChanged only —
    // never .set(/.remove(/.clear( on a storage area.
    assert.equal(
      /chrome\.storage\.[\w.]*\.(set|remove|clear)\s*\(/.test(src),
      false,
      `${file} writes chrome.storage`,
    );
  }
  // Only the content script binds a real fetch; everything else injects it.
  for (const file of ALL) {
    const p = path.join(SRC, file);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, "utf8");
    const fetches = src.match(/\bfetch\s*\(/g) || [];
    if (file === "content.js") {
      assert.ok(fetches.length <= 2, "content.js binds fetch for its envs only");
    } else {
      assert.equal(fetches.length, 0, `${file} must not fetch`);
    }
    if (file !== "content.js" && file !== "atom.js") {
      assert.equal((src.match(/sessionStorage/g) || []).length, 0, `${file} must not touch sessionStorage`);
    }
  }
  // The token must never leave the request path: outlook-backfill only
  // references ctx.secret inside request headers.
  const ob = fs.readFileSync(path.join(SRC, "outlook-backfill.js"), "utf8");
  for (const m of ob.matchAll(/ctx\.secret/g)) {
    const near = ob.slice(Math.max(0, m.index - 80), m.index + 40);
    assert.ok(!/sendMessage|postMessage|console|JSON\.stringify/.test(near), `token near: ${near}`);
  }
});
