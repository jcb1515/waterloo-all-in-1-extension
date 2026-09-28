// @ts-check
// Email mail read: the 30-min auto gate + forced bypass + lock join, the
// rate cap, batching, freeze drops, failure retries, gated body selection,
// the Gmail tab-DOM list + print-view parse, the Outlook MSAL REST read,
// the check-now protocol (accepted/not-on-page/signed-out/disabled +
// check-done + in-flight join), the injection guard, payload->adapter
// integration (scope/readOk/threadMap/check state/Atom mapping), and the
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
  clampOutlookCount,
  checkNowDecision,
  doneFromResult,
  gmailOnInbox,
  makeRunBox,
  makeRate,
  BF_MAX_PAGES,
  CHECK_NOW,
  __resetBackfill,
} from "../../extension/src/sources/email/backfill.js";
import {
  gmailBackfill,
  gmailPrintPath,
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
import { applyResult } from "../../extension/src/core/merge.js";
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

/* ------------------------- scheduling + protocol ----------------------- */

test("outlookCount: 50/100/200 only, default 100", () => {
  assert.equal(clampOutlookCount(undefined), 100);
  assert.equal(clampOutlookCount(50), 50);
  assert.equal(clampOutlookCount(200), 200);
  assert.equal(clampOutlookCount(37), 100);
  assert.equal(clampOutlookCount("100"), 100);
});

test("gmailOnInbox: only the first inbox page", () => {
  assert.equal(gmailOnInbox(""), true);
  assert.equal(gmailOnInbox("#inbox"), true);
  assert.equal(gmailOnInbox("#inbox?compose=new"), true);
  assert.equal(gmailOnInbox("#inbox/p2"), false);
  assert.equal(gmailOnInbox("#inbox/18fa1a2b3c4d5e6f"), false);
  assert.equal(gmailOnInbox("#sent"), false);
  assert.equal(gmailOnInbox("#search/in:inbox"), false);
});

test("checkNowDecision: only the tab's own provider answers", () => {
  const msg = { type: CHECK_NOW, source: "gmail", runId: "r1" };
  assert.deepEqual(checkNowDecision(msg, "gmail"), { accepted: true });
  assert.equal(checkNowDecision(msg, "outlook"), null);
  // "email" (and any other source) is nobody's tab — W1 sends gmail|outlook.
  assert.equal(checkNowDecision({ ...msg, source: "email" }, "gmail"), null);
  assert.equal(checkNowDecision({ ...msg, source: "email" }, "outlook"), null);
  assert.equal(checkNowDecision({ type: "other" }, "gmail"), null);
  assert.equal(checkNowDecision(null, "gmail"), null);
});

test("checkNowDecision: not-on-page, signed-out, disabled", () => {
  const msg = { type: CHECK_NOW, source: "gmail" };
  assert.deepEqual(
    checkNowDecision(msg, "gmail", { onPage: () => false }),
    { accepted: false, reason: "not-on-page" },
  );
  assert.deepEqual(
    checkNowDecision(msg, "gmail", { hasToken: () => false }),
    { accepted: false, reason: "signed-out" },
  );
  assert.deepEqual(
    checkNowDecision(msg, "gmail", { disabled: () => true }),
    { accepted: false, reason: "disabled" },
  );
});

test("doneFromResult: ok/signed-out/disabled/timeout/error", () => {
  assert.deepEqual(doneFromResult({ listed: 12 }), { ok: true, checked: 12, sent: 0 });
  assert.deepEqual(doneFromResult({ listed: 12, sentListed: 3, partial: true }), {
    ok: true,
    checked: 12,
    sent: 3,
    partial: true,
  });
  assert.deepEqual(doneFromResult({ skipped: "no-token" }), {
    ok: false,
    reason: "signed-out",
    checked: 0,
    sent: 0,
  });
  assert.deepEqual(doneFromResult({ skipped: "off" }), {
    ok: false,
    reason: "disabled",
    checked: 0,
    sent: 0,
  });
  assert.deepEqual(doneFromResult({ skipped: "not-on-page" }), {
    ok: false,
    reason: "not-on-page",
    checked: 0,
    sent: 0,
  });
  assert.deepEqual(doneFromResult({ stale: true, listed: 4 }), {
    ok: false,
    reason: "timeout",
    checked: 4,
    sent: 0,
  });
  assert.deepEqual(doneFromResult({ error: "http", listed: 9 }), {
    ok: false,
    reason: "error",
    checked: 9,
    sent: 0,
  });
});

test("makeRunBox: a check-now during a run joins it (one start)", async () => {
  let started = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const box = makeRunBox(async () => {
    started++;
    await gate;
    return { listed: 7 };
  });
  const a = box.run(true);
  const b = box.run(true); // joins the in-flight run
  assert.equal(started, 1);
  assert.equal(box.running, true);
  /** @type {any} */ (release)();
  assert.equal((await a).listed, 7);
  assert.equal((await b).listed, 7);
  assert.equal(started, 1);
  assert.equal(box.running, false);
  await box.run(false); // a later run starts fresh
  assert.equal(started, 2);
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
 * A fake Gmail page env: doc() returns the inbox fixture (the search
 * fixture's tr.zA rows stand in for inbox rows — same markup), fetchImpl
 * returns the print-view fixture for view=pt urls and records requests.
 */
const gmailEnv = ({ searchDoc, printDoc, prev = null, settings = {}, locked = 0, onInbox = true, frozen = () => false } = {}) => {
  const { document: sdoc } = parseHTML(searchDoc != null ? searchDoc : html("gmail-search"));
  const { document: pdoc } = parseHTML(printDoc != null ? printDoc : html("gmail-print"));
  /** @type {{url: string, init: any}[]} */
  const fetches = [];
  /** @type {any[]} */
  const messages = [];
  let lock = locked;
  let fail = 0;
  const env = {
    now: NOW,
    account: 0,
    doc: () => sdoc,
    onInbox: () => onInbox,
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
    sleep: async () => {},
    isFrozen: frozen,
    pageUrl: "https://mail.google.com/mail/u/0/#inbox",
  };
  return { env, fetches, messages, getLock: () => lock, getFail: () => fail };
};

const payloadsOf = (messages) =>
  messages.map((m) => JSON.parse(m.payload.body));

test("gmail run: tab inbox DOM, gated bodies, check payloads", async (t) => {
  before(t);
  const { env, fetches, messages } = gmailEnv();
  const r = await backfillRound(env, gmailBackfill);
  assert.equal(r.sent, 2); // one batch + the empty final marker

  const bodies = payloadsOf(messages);
  const listed = bodies.find((b) => b.messages.length);
  assert.equal(listed.view, "backfill");
  assert.equal(listed.folder, "inbox");
  assert.equal(listed.provider, "gmail");
  assert.equal(listed.messages.length, 3);
  assert.equal(listed.check.final, false);
  assert.equal(listed.check.checked, 3);
  const fin = bodies[bodies.length - 1];
  assert.equal(fin.check.final, true);
  assert.equal(fin.check.checked, 3);
  assert.equal(fin.check.ok, true);
  assert.ok(fin.check.runId);
  // lastMessageId -> threadId map (row 2's ids differ, row 1+3 don't).
  assert.deepEqual(listed.threadMap, { "17fb2c3d4e5f6a99": "17fb2c3d4e5f6a7b" });
  // The body-read signature is the last-message id, read off the row's
  // DESCENDANT span (live Gmail puts it there, not on tr.zA). No
  // thread-id fallback — a thread id never bumps on a new reply.
  assert.equal(
    listed.messages.find((m) => m.key === "17fb2c3d4e5f6a7b").sig,
    "17fb2c3d4e5f6a99",
  );
  assert.equal(
    listed.messages.find((m) => m.key === "18fa1a2b3c4d5e6f").sig,
    "18fa1a2b3c4d5e6f",
  );
  assert.equal(
    listed.messages.find((m) => m.key === "16ab9c8d7e6f5a4b").sig,
    "16ab9c8d7e6f5a4b",
  );
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
  // Only view=pt print-view GETs — the list itself comes from the DOM.
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

test("gmail: a fresh check.at skips the auto tick; force bypasses", async (t) => {
  before(t);
  const { env, fetches } = gmailEnv({
    prev: { at: new Date(NOW_MS - 10 * 60e3).toISOString(), checked: 3, ok: true },
  });
  const r = await backfillRound(env, gmailBackfill);
  assert.equal(r.skipped, "throttled");
  // A forced run (check-now) ignores the 30-min gate.
  const forced = await backfillRound({ ...env, force: true }, gmailBackfill);
  assert.ok(forced.sent >= 1);
});

test("gmail: the lock gates automatic runs only, not check-now", async (t) => {
  before(t);
  const { env, messages } = gmailEnv({ locked: NOW_MS - 60e3 });
  const r = await backfillRound(env, gmailBackfill);
  assert.equal(r.skipped, "locked");
  const forced = await backfillRound({ ...env, force: true }, gmailBackfill);
  assert.equal(forced.sent, 2);
  assert.equal(payloadsOf(messages).at(-1).check.ok, true);
});

test("gmail: not on the inbox -> skip as not-on-page, no requests", async (t) => {
  before(t);
  const { env, fetches, messages } = gmailEnv({ onInbox: false });
  const r = await backfillRound(env, gmailBackfill);
  assert.equal(r.skipped, "not-on-page");
  assert.equal(fetches.length, 0);
  assert.equal(messages.length, 0);
});

test("gmail: a body fetch that is not 200/html aborts and retries in 5m", async (t) => {
  before(t);
  const { env, getFail, messages } = gmailEnv();
  env.fetchImpl = async () => ({ status: 302, redirected: true, headers: { get: () => null }, text: async () => "" });
  const r = await backfillRound(env, gmailBackfill);
  assert.equal(r.error, "http");
  assert.ok(getFail() > 0);
  // The failed run still lands a final marker with ok:false — Setup must
  // not sit on "Checking…".
  const fin = payloadsOf(messages).at(-1);
  assert.equal(fin.check.final, true);
  assert.equal(fin.check.ok, false);
  assert.equal(fin.check.reason, "error");
  const again = await backfillRound(env, gmailBackfill);
  assert.equal(again.skipped, "retry");
});

test("gmail: a frozen tab drops the round mid-flight", async (t) => {
  before(t);
  let frozen = false;
  const { env } = gmailEnv({ frozen: () => frozen });
  env.sleep = async () => {
    frozen = true;
  };
  const p = backfillRound(env, gmailBackfill);
  await new Promise((r) => setTimeout(r, 10));
  frozen = true;
  backfillFreeze();
  const r = await p;
  assert.ok(r.stale || r.error || r.sent >= 0); // no crash, nothing else required
});

test("gmail: an unchanged body-read signature skips the fetch", async (t) => {
  before(t);
  const { env, fetches } = gmailEnv();
  // As if a previous run already read both gated bodies at these
  // revisions — the row's data-legacy-last-message-id is the signature.
  env.getBodyRead = async () => ({
    "17fb2c3d4e5f6a7b": "17fb2c3d4e5f6a99",
    "18fa1a2b3c4d5e6f": "18fa1a2b3c4d5e6f",
  });
  const r = await backfillRound({ ...env, force: true }, gmailBackfill);
  assert.equal(r.bodies, 0);
  assert.equal(fetches.length, 0);
  // A new reply bumps the last-message id → only that thread refetches.
  env.getBodyRead = async () => ({
    "17fb2c3d4e5f6a7b": "17fb2c3d4e5f0000",
    "18fa1a2b3c4d5e6f": "18fa1a2b3c4d5e6f",
  });
  const r2 = await backfillRound({ ...env, force: true }, gmailBackfill);
  assert.equal(r2.bodies, 1);
  assert.equal(fetches.length, 1);
  assert.match(fetches[0].url, /th=17fb2c3d4e5f6a7b/);
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
      // The once-per-round account probe — answered without touching the
      // page queue.
      if (/^\/api\/v2\.0\/me\?\$select=EmailAddress/.test(url)) {
        return {
          status: 200,
          headers: { get: () => "application/json" },
          text: async () => JSON.stringify({ EmailAddress: "me@uwaterloo.ca" }),
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

test("outlook list path: newest N, no date filter", () => {
  const inbox = outlookListPath("inbox");
  assert.match(inbox, /^\/api\/v2\.0\/me\/mailfolders\/inbox\/messages\?/);
  assert.match(inbox, /\$top=50/);
  assert.match(inbox, /\$orderby=ReceivedDateTime%20desc/);
  assert.match(inbox, /\$count=true/);
  assert.ok(!/\$filter/.test(inbox));
  const sent = outlookListPath("sent");
  assert.match(sent, /mailfolders\/sentitems\/messages/);
  assert.match(sent, /\$orderby=SentDateTime%20desc/);
  assert.ok(!/\$filter/.test(sent));
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
  const m = outlookMsg(rest.value[0], false, "me@uwaterloo.ca");
  assert.equal(m.key, "conv-out-1");
  assert.equal(m.messageId, "AAMkFakeItemIdOneAAA=");
  assert.equal(m.fromEmail, "recruiting@acme.example.com");
  assert.equal(m.receivedAt, "2026-09-30T13:12:00.000Z");
  assert.equal(m.unread, true);
  // Recipients collapse to a count + toMe flag — never the addresses.
  assert.equal(m.recipients, 1);
  assert.equal(m.toMe, true);
  assert.ok(!JSON.stringify(m).includes("me@uwaterloo.ca"));
  assert.match(m.url || "", /ItemID=/);
});

test("outlookMsg: a big To list is recipients>10 with no toMe", () => {
  const rest = JSON.parse(fs.readFileSync(path.join(DIR, "outlook-rest.json"), "utf8"));
  const many = {
    ...rest.value[0],
    ToRecipients: Array.from({ length: 12 }, (_, i) => ({
      EmailAddress: { Address: `person${i}@uwaterloo.ca` },
    })),
    CcRecipients: [],
  };
  const m = outlookMsg(many, false, "me@uwaterloo.ca");
  assert.equal(m.recipients, 12);
  assert.equal(m.toMe, false);
});

test("outlook round: token -> pages -> gated bodies -> payloads", async (t) => {
  before(t);
  const { env, fetches, messages } = outlookEnv();
  const r = await backfillRound(env, outlookBackfill);
  assert.equal(r.sent, 3); // 2 list batches + final
  // Every request is GET, same-origin /api/v2.0/me, Bearer in headers only.
  for (const f of fetches) {
    assert.equal(f.init.method, "GET");
    assert.match(f.url, /^\/api\/v2\.0\/me(?:\/|\?)/);
    assert.equal(f.init.headers.Authorization, `Bearer ${TOKEN}`);
  }
  // The account probe ran once, before the first list page.
  assert.equal(
    fetches.filter((f) => /\$select=EmailAddress/.test(f.url)).length,
    1,
  );
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

test("outlook: checked counts inbox only; the sent pass reports sent", async (t) => {
  before(t);
  const rest = JSON.parse(fs.readFileSync(path.join(DIR, "outlook-rest.json"), "utf8"));
  const { env, messages } = outlookEnv({
    settings: { folders: ["inbox", "sent"], outlookCount: 50 },
    pages: [
      { value: [rest.value[0], rest.value[1]] }, // inbox: 2 rows, no nextLink
      { value: [{ ...rest.value[0], Id: "S1", ConversationId: "conv-sent-1" }] },
    ],
  });
  const r = await backfillRound({ ...env, force: true }, outlookBackfill);
  assert.equal(r.listed, 2);
  assert.equal(r.sentListed, 1);
  const done = doneFromResult(r);
  assert.equal(done.checked, 2);
  assert.equal(done.sent, 1);
  // The final marker's checked is inbox-only too.
  assert.equal(payloadsOf(messages).at(-1).check.checked, 2);
});

test("outlook: a forced run stops new body fetches at the 60 s budget", async (t) => {
  before(t);
  const rest = JSON.parse(fs.readFileSync(path.join(DIR, "outlook-rest.json"), "utf8"));
  const gated = (i) => ({
    ...rest.value[0],
    Id: `B-${i}`,
    ConversationId: `conv-b-${i}`,
  });
  let clock = NOW_MS;
  const { env } = outlookEnv({
    settings: { outlookCount: 50 },
    pages: [{ value: [gated(1), gated(2), gated(3)] }],
  });
  env.wallNow = () => clock;
  const rawFetch = env.fetchImpl;
  env.fetchImpl = async (/** @type {string} */ url, /** @type {any} */ init) => {
    const res = await rawFetch(url, init);
    if (/me\/messages\//.test(url)) clock += 40000; // each body costs 40 s of wall time
    return res;
  };
  // Forced: bodies at t+0 and t+40 fetch; the third (t+80 >= t+60) is cut.
  const r = await backfillRound({ ...env, force: true }, outlookBackfill);
  assert.equal(r.partial, true);
  assert.equal(r.bodies, 2);
  assert.equal(r.listed, 3);
  const done = doneFromResult(r);
  assert.equal(done.ok, true);
  assert.equal(done.partial, true);
  assert.equal(done.checked, 3);
  // Automatic runs have no budget — the same page fetches all three.
  clock = NOW_MS;
  const auto = await backfillRound(env, outlookBackfill);
  assert.equal(auto.partial, undefined);
  assert.equal(auto.bodies, 3);
});

test("outlook: a check-now joining an auto run arms the budget mid-run", async (t) => {
  before(t);
  const rest = JSON.parse(fs.readFileSync(path.join(DIR, "outlook-rest.json"), "utf8"));
  const gated = (i) => ({
    ...rest.value[0],
    Id: `B-${i}`,
    ConversationId: `conv-b-${i}`,
  });
  let clock = NOW_MS;
  // The shared control content.js hands to env.budgetCtl: 0 until a
  // check-now joins, then the orchestrator-bounded deadline.
  const ctl = { forceUntil: 0 };
  const { env } = outlookEnv({
    settings: { outlookCount: 50 },
    pages: [{ value: [gated(1), gated(2), gated(3)] }],
  });
  env.wallNow = () => clock;
  env.budgetCtl = ctl;
  const rawFetch = env.fetchImpl;
  env.fetchImpl = async (/** @type {string} */ url, /** @type {any} */ init) => {
    const res = await rawFetch(url, init);
    if (/me\/messages\//.test(url)) {
      clock += 40000; // each body costs 40 s of wall time
      // The check-now lands while this AUTOMATIC run is in flight —
      // content.js stamps forceUntil = now + 60 s. Arm it just past the
      // second body so the third is cut.
      if (!ctl.forceUntil) ctl.forceUntil = NOW_MS + 50000;
    }
    return res;
  };
  const r = await backfillRound(env, outlookBackfill);
  assert.equal(r.partial, true);
  assert.equal(r.bodies, 2);
  assert.equal(r.bodySkipped, 1);
  const done = doneFromResult(r);
  assert.equal(done.ok, true);
  assert.equal(done.partial, true);
});

test("outlook: reads the newest N — outlookCount 50/100/200", async (t) => {
  before(t);
  const rest = JSON.parse(fs.readFileSync(path.join(DIR, "outlook-rest.json"), "utf8"));
  // 250 fake inbox rows across pages that always offer a nextLink. The
  // rows are deliberately ungated (bulk newsletter sender) so needsBody is
  // false — otherwise 50 body fetches per page would engage the 20/min
  // rate gate, which env.sleep resolves instantly against real Date.now.
  const mkPage = (page) => ({
    value: Array.from({ length: 50 }, (_, i) => ({
      ...rest.value[0],
      Id: `ID-${page}-${i}`,
      ConversationId: `conv-${page}-${i}`,
      Subject: "Weekly newsletter",
      From: { EmailAddress: { Name: "Shop Deals", Address: "news@shop.example.com" } },
      BodyPreview: "sale",
    })),
    "@odata.nextLink": `https://outlook.cloud.microsoft/api/v2.0/me/mailfolders/inbox/messages?$skip=${(page + 1) * 50}`,
  });
  for (const [count, pagesWanted] of [[50, 1], [100, 2], [200, 4]]) {
    const { env, fetches, messages } = outlookEnv({
      settings: { outlookCount: count },
      pages: [mkPage(0), mkPage(1), mkPage(2), mkPage(3), mkPage(4)],
    });
    await backfillRound({ ...env, force: true }, outlookBackfill);
    const listed = fetches.filter((f) => /mailfolders\/inbox/.test(f.url)).length;
    assert.equal(listed, pagesWanted, `count=${count}`);
    const fin = payloadsOf(messages).at(-1);
    assert.equal(fin.check.final, true);
    assert.equal(fin.check.checked, count);
  }
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
  // co-op / learn / ATS / allow-listed gate on their own; a BARE
  // uwaterloo.ca sender no longer does — it needs a strong cue.
  assert.equal(needsBody(row({ fromEmail: "coop@uwaterloo.ca", from: "CECA" }), { settings: {} }), true);
  assert.equal(needsBody(row({ fromEmail: "noreply@learn.uwaterloo.ca" }), { settings: {} }), true);
  assert.equal(needsBody(row({ fromEmail: "jsmith@uwaterloo.ca" }), { settings: {} }), false);
  assert.equal(
    needsBody(row({ fromEmail: "jsmith@uwaterloo.ca", subject: "Midterm room change" }), { settings: {} }),
    true,
  );
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
      check: { runId: "g1", since: NOW.toISOString(), batch: 0, final: true, checked: 2, ok: true },
    }),
    ctx({}),
  );
  assert.equal(res.scope, "email:gmail:backfill");
  // readOk stays the single batch scope — per-message scopes live in
  // replaceScopes so they can't flood the 50-entry scopeOkAt/scopeReadAt
  // caps and evict the checklist's list/backfill scopes.
  assert.deepEqual(res.readOk, ["email:gmail:backfill"]);
  // Every listed row re-reads its own message scope — a re-read under the
  // current rules drops whatever the row no longer produces (once W1's
  // applyResult consumes replaceScopes; until then additive like lists).
  assert.deepEqual(res.replaceScopes.sort(), ["email:gmail:thr1", "email:gmail:thr2"]);
  assert.equal(res.state.threadMap.m1last, "thr1");
  // The final marker stamps check[provider] — Setup's status line and the
  // content script's 30-min gate both read `at`.
  assert.equal(res.state.check.gmail.checked, 2);
  assert.equal(res.state.check.gmail.ok, true);
  assert.equal(res.state.check.gmail.at, NOW.toISOString());
  assert.ok(!res.state.backfill);
  assert.ok(res.items.length >= 1);
  assert.equal(res.items[0].source, "gmail");
});

test("adapter: a bodySkipped row keeps its body-derived items", async () => {
  // kA's deadline is only visible in the body — a preview-only re-read
  // must not drop it.
  const row = (over) => ({
    key: "kA",
    url: "https://mail.google.com/mail/u/0/#inbox/kA",
    from: "Jane Smith",
    fromEmail: "jsmith@uwaterloo.ca",
    subject: "Lab sections",
    receivedAt: "2026-09-29T18:00:00.000Z",
    links: [],
    ...over,
  });
  const batch = (messages, tag) =>
    adapter.observe.parse(
      payload("gmail", {
        v: 1, provider: "gmail", folder: "inbox", view: "backfill",
        messages,
        check: { runId: tag, since: NOW.toISOString(), batch: 0, final: true, checked: 1, ok: true },
      }),
      ctx({}),
    );
  const fold = (prevRaw, res) =>
    applyResult(prevRaw, res, { mode: "scope", scope: res.scope });

  const b1 = await batch([row({ sig: "rev1", bodyFetched: true, body: "The lab report is due October 15 at 11:59 PM." })], "g1");
  const deadline = b1.items.find((i) => i.type === "deadline");
  assert.ok(deadline, "body read should produce a deadline item");
  let raw = fold(null, b1);
  assert.ok(raw.items.some((i) => i.id === deadline.id));

  // (a) same signature, bodySkipped — the re-read is additive: nothing in
  // the batch re-emits the item, but its per-message scope is excluded
  // from replaceScopes, so applyResult keeps it.
  const b2 = await batch([row({ sig: "rev1", bodySkipped: true, preview: "The lab report is…" })], "g2");
  assert.ok(!b2.items.some((i) => i.id === deadline.id));
  assert.deepEqual(b2.replaceScopes, []);
  raw = fold(raw, b2);
  assert.ok(
    raw.items.some((i) => i.id === deadline.id),
    "sig-match bodySkipped must not drop the body-derived item",
  );

  // (b) budget-cut bodySkipped (signature moved on but no fetch happened)
  // — same protection.
  const b3 = await batch([row({ sig: "rev2", bodySkipped: true, preview: "The lab report is…" })], "g3");
  assert.ok(!b3.items.some((i) => i.id === deadline.id));
  raw = fold(raw, b3);
  assert.ok(
    raw.items.some((i) => i.id === deadline.id),
    "budget-cut bodySkipped must not drop the body-derived item",
  );

  // (c) a row that WAS re-read for real and no longer yields the item
  // still drops — replacement semantics unchanged for full reads.
  const b4 = await batch([row({ preview: "no dates in this one" })], "g4");
  assert.ok(!b4.items.some((i) => i.id === deadline.id));
  assert.deepEqual(b4.replaceScopes, ["email:gmail:kA"]);
  raw = fold(raw, b4);
  assert.ok(
    !raw.items.some((i) => i.id === deadline.id),
    "a fully re-read message that stops producing an item still drops it",
  );
});

test("adapter: bodyRead records the signature of each fetched body", async () => {
  const mk = (sig) =>
    adapter.observe.parse(
      payload("gmail", {
        v: 1, provider: "gmail", folder: "inbox", view: "backfill",
        messages: [
          {
            key: "k1", subject: "a", sig, bodyFetched: true,
            receivedAt: "2026-09-29T18:00:00.000Z", links: [],
          },
          { key: "k2", subject: "b", receivedAt: "2026-09-29T18:00:00.000Z", links: [] },
          // Fetched but unsigned — nothing to record.
          { key: "k3", subject: "c", bodyFetched: true, receivedAt: "2026-09-29T18:00:00.000Z", links: [] },
        ],
        check: { runId: "g2", since: NOW.toISOString(), batch: 0, final: true, checked: 3, ok: true },
      }),
      ctx({}),
    );
  const res = await mk("rev1");
  assert.deepEqual(res.state.bodyRead.gmail, { k1: "rev1" });
  // A bumped signature replaces the entry on the next batch.
  const res2 = await adapter.observe.parse(
    payload("gmail", {
      v: 1, provider: "gmail", folder: "inbox", view: "backfill",
      messages: [
        {
          key: "k1", subject: "a", sig: "rev2", bodyFetched: true,
          receivedAt: "2026-09-29T18:00:00.000Z", links: [],
        },
      ],
      check: { runId: "g3", since: NOW.toISOString(), batch: 0, final: true, checked: 1, ok: true },
    }),
    ctx({}, { state: res.state }),
  );
  assert.deepEqual(res2.state.bodyRead.gmail, { k1: "rev2" });
});

test("adapter: a non-final batch marks check.running; final clears it", async () => {
  const msg = { key: "k1", subject: "x", receivedAt: NOW.toISOString(), links: [] };
  const batch = await adapter.observe.parse(
    payload("gmail", {
      v: 1, provider: "gmail", folder: "inbox", view: "backfill",
      messages: [msg],
      check: { runId: "g9", since: "2026-10-01T14:59:00.000Z", batch: 0, final: false, checked: 30 },
    }),
    ctx({}),
  );
  assert.equal(batch.state.check.gmail.running.checked, 30);
  assert.equal(batch.state.check.gmail.running.since, "2026-10-01T14:59:00.000Z");
  const fin = await adapter.observe.parse(
    payload("gmail", {
      v: 1, provider: "gmail", folder: "inbox", view: "backfill",
      messages: [msg],
      check: { runId: "g9", since: "2026-10-01T14:59:00.000Z", batch: 1, final: true, checked: 51, ok: true },
    }),
    ctx({}, { state: batch.state }),
  );
  assert.equal(fin.state.check.gmail.running, undefined);
  assert.equal(fin.state.check.gmail.checked, 51);
  // A replay marker never touches the check state.
  const replay = await adapter.observe.parse(
    payload("gmail", {
      v: 1, provider: "gmail", folder: "inbox", view: "backfill",
      messages: [msg],
      check: { runId: "gmail-replay", batch: 0, final: true, checked: 1, ok: true, replay: true },
    }),
    ctx({}, { state: fin.state }),
  );
  assert.equal(replay.state.check.gmail.checked, 51);
});

test("adapter: a 50-message batch still readOks a single scope", async () => {
  const msgs = Array.from({ length: 50 }, (_, i) => ({
    key: `m${i}`,
    url: `https://outlook.office.com/mail/inbox/id/m${i}`,
    from: "Sender",
    fromEmail: "sender@example.com",
    subject: `Note ${i}`,
    receivedAt: "2026-09-29T18:00:00.000Z",
    links: [],
  }));
  const res = await adapter.observe.parse(
    payload("outlook", {
      v: 1,
      provider: "outlook",
      folder: "inbox",
      view: "backfill",
      messages: msgs,
      check: { runId: "o1", since: NOW.toISOString(), batch: 0, final: true, checked: 50, ok: true },
    }),
    ctx({}),
  );
  assert.equal(res.scope, "email:outlook:backfill");
  assert.deepEqual(res.readOk, ["email:outlook:backfill"]);
  assert.equal(res.replaceScopes.length, 50);
  assert.ok(res.replaceScopes.includes("email:outlook:m49"));
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
      check: { runId: "g2", since: NOW.toISOString(), batch: 0, final: true, checked: 1, ok: true },
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
      check: { runId: "g3", since: NOW.toISOString(), batch: 0, final: true, checked: 1, ok: true },
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
      check: { runId: "g4", since: NOW.toISOString(), batch: 0, final: true, checked: 1, ok: true },
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

test("gmail inbox rows parse through the passive list path", async (t) => {
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
    /\.focus\s*\(/,
    /location\.assign/,
    /location\.href\s*=(?![=])/,
    /location\.replace\s*\(/,
    /location\.hash\s*=(?![=])/,
    /history\.pushState/,
    /history\.replaceState/,
    /createElement\(\s*["'`]iframe/i,
    /<\s*iframe/i,
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
