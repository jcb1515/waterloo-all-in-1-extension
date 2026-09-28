// @ts-check
// Portal content-script auto-fetch: the round, the replayed payload shape,
// the token rules, visibility resume and the throttle — all with injected
// fakes (no chrome, no network). Fixtures are synthetic.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import adapter from "../../extension/src/sources/portal/index.js";
import {
  portalRound,
  portalFreeze,
  portalFetchUrls,
  __resetPortalRound,
} from "../../extension/src/sources/portal/content.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "portal");
const NOW = new Date("2026-09-28T12:00:00.000Z"); // Mon Sep 28 2026, 08:00 EDT
const TOKEN = "header.payload.signature";
const SRC = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "extension", "src", "sources", "portal", "content.js",
);

const before = (t) => {
  __resetPortalRound();
  t.after(__resetPortalRound);
};

/**
 * A fake page env: records fetch calls + messages, holds token/stamps, the
 * in-progress marker, the last-round summary and a flippable visibility.
 * `statuses` overrides `status` per call index; a value of "hang" returns a
 * promise that never settles (a frozen task queue).
 */
const fakeEnv = ({ token = TOKEN, last = 0, status = 200, statuses, body = "{}", frozen = false, inProgress = 0 } = {}) => {
  /** @type {{url: string, init: any}[]} */
  const calls = [];
  /** @type {any[]} */
  const messages = [];
  let stamp = last;
  let ip = inProgress;
  let summary = null;
  let froz = frozen;
  const env = {
    fetchImpl: async (/** @type {string} */ url, /** @type {any} */ init) => {
      calls.push({ url, init });
      const st = statuses && calls.length - 1 < statuses.length ? statuses[calls.length - 1] : status;
      if (st === "hang") return new Promise(() => {});
      if (typeof st === "function") return st(url, calls.length - 1);
      if (st instanceof Error) throw st;
      return {
        status: st,
        headers: { get: (/** @type {string} */ h) => (h === "content-type" ? "application/json" : null) },
        text: async () => body,
      };
    },
    sendMessage: (/** @type {any} */ m) => messages.push(m),
    getToken: () => token,
    getLast: () => stamp,
    setLast: (/** @type {number} */ ms) => {
      stamp = ms;
    },
    getInProgress: () => ip,
    setInProgress: (/** @type {number} */ ms) => {
      ip = ms;
    },
    getRoundSummary: () => summary,
    setRoundSummary: (/** @type {any} */ s) => {
      summary = s;
    },
    isFrozen: () => froz,
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
    getIp: () => ip,
    getSummary: () => summary,
  };
};

test("portal fetch urls: the four endpoints in order, Toronto-dated window", (t) => {
  before(t);
  const urls = portalFetchUrls(NOW);
  assert.deepEqual(urls, [
    "https://portalapi2.uwaterloo.ca/v2/student/CourseEnrollments/",
    "https://portalapi2.uwaterloo.ca/v2/student/CourseSchedule/",
    "https://portalapi2.uwaterloo.ca/v2/student/ExamSchedule/",
    "https://portalapi2.uwaterloo.ca/v2/Calendar/DailyEventsV2?start=2026-09-21&end=2027-01-26",
  ]);
});

test("a token runs the 4 GETs in order and replays each response", async (t) => {
  before(t);
  const { env, calls, messages } = fakeEnv({
    body: fs.readFileSync(path.join(DIR, "schedule.json"), "utf8"),
  });
  const r = await portalRound(env);
  assert.equal(r.sent, 4);
  assert.equal(calls.length, 4);
  const urls = portalFetchUrls(NOW);
  calls.forEach((c, i) => {
    assert.equal(c.url, urls[i]);
    assert.equal(c.init.method, "GET");
    assert.equal(c.init.headers.Authorization, `Bearer ${TOKEN}`);
  });
  // The replayed payloads are the passive "net" shape, byte for byte.
  assert.equal(messages.length, 4);
  for (const [i, m] of messages.entries()) {
    assert.equal(m.type, "wa1:observed");
    const p = m.payload;
    assert.deepEqual(Object.keys(p).sort(), [
      "at", "body", "contentType", "kind", "method", "source", "status", "url",
    ]);
    assert.equal(p.source, "portal");
    assert.equal(p.kind, "net");
    assert.equal(p.method, "GET");
    assert.equal(p.status, 200);
    assert.equal(p.contentType, "application/json");
    assert.equal(p.url, urls[i]);
    assert.ok(typeof p.body === "string" && p.body.length > 0);
    assert.ok(!Number.isNaN(Date.parse(p.at)));
  }
  // The token never leaves the request headers — not in payloads or urls.
  assert.ok(!JSON.stringify(messages).includes(TOKEN));
  assert.ok(!JSON.stringify(calls.map((c) => c.url)).includes(TOKEN));
});

test("no token: nothing fetched, summary says no-token", async (t) => {
  before(t);
  const { env, calls, messages, getSummary } = fakeEnv({ token: null });
  const r = await portalRound(env);
  assert.equal(r.skipped, "no-token");
  assert.equal(calls.length, 0);
  assert.equal(messages.length, 0);
  assert.equal(getSummary() && getSummary().error, "no-token");
  assert.deepEqual(getSummary() && getSummary().results, []);
});

test("a hidden-but-not-frozen tab still runs its round", async (t) => {
  before(t);
  // Edge only freezes some hidden tabs: visibility alone must not gate.
  const { env, calls } = fakeEnv(); // isFrozen absent-flag = not frozen
  const r = await portalRound(env);
  assert.equal(r.sent, 4);
  assert.equal(calls.length, 4);
});

test("a frozen tab runs nothing and resumes after the freeze", async (t) => {
  before(t);
  const { env, calls, setFrozen } = fakeEnv({ frozen: true });
  const r1 = await portalRound(env);
  assert.equal(r1.skipped, "frozen");
  assert.equal(calls.length, 0);
  setFrozen(false);
  const r2 = await portalRound(env);
  assert.equal(r2.sent, 4);
  assert.equal(calls.length, 4);
});

test("a freeze between endpoints resumes with no repeated endpoints", async (t) => {
  before(t);
  const f = fakeEnv();
  // Freeze fires while no fetch is in flight — after the second response
  // and before the third is issued: the loop's frozen check stops the round.
  let froze = false;
  const isFrozen = f.env.isFrozen;
  f.env.isFrozen = () => {
    const fzn = f.calls.length >= 2;
    if (fzn && !froze) {
      froze = true;
      portalFreeze();
    }
    return froze ? fzn : isFrozen();
  };
  const r1 = await portalRound(f.env);
  assert.equal(r1.paused, true);
  assert.equal(f.calls.length, 2);
  f.env.isFrozen = isFrozen; // thaw
  const r2 = await portalRound(f.env);
  assert.equal(r2.sent, 2);
  const urls = portalFetchUrls(NOW);
  assert.deepEqual(f.calls.map((c) => c.url), urls); // exactly 4, in order, no repeats
  // Round only completed after the resume: lastFetch stamped then.
  assert.ok(f.getStamp() > 0);
});

test("a freeze mid-fetch re-issues exactly that endpoint once on resume", async (t) => {
  before(t);
  const f = fakeEnv({ statuses: [200, "hang", 200, 200, 200] });
  /** @type {Promise<any>} */
  const p = portalRound(f.env); // hangs on the second fetch (frozen queue)
  await new Promise((r) => setTimeout(r, 0)); // let it reach the hung fetch
  portalFreeze(); // the freeze event: the in-flight fetch is now stale
  f.setFrozen(true);
  const mid = await portalRound(f.env);
  assert.equal(mid.skipped, "frozen");
  assert.equal(f.calls.length, 2); // no duplicate fetch while frozen
  f.setFrozen(false);
  const r2 = await portalRound(f.env); // resume: re-issue endpoint 1, then 2,3
  assert.equal(r2.sent, 3);
  const urls = portalFetchUrls(NOW);
  assert.deepEqual(
    f.calls.map((c) => c.url),
    [urls[0], urls[1], urls[1], urls[2], urls[3]],
  );
  assert.equal(f.messages.length, 4); // every endpoint replayed exactly once
  void p; // the hung promise never settles — models the frozen task queue
});

test("a late stale settle is ignored", async (t) => {
  before(t);
  /** @type {(v: any) => void} */
  let settle = () => {};
  const f = fakeEnv({
    statuses: [200, () => new Promise((r) => (settle = r)), 200, 200, 200],
  });
  const p1 = portalRound(f.env); // parks on fetch 2
  await new Promise((r) => setTimeout(r, 0));
  portalFreeze();
  f.setFrozen(true);
  f.setFrozen(false); // thaw before the resume tick
  const r2 = await portalRound(f.env); // re-issues fetch 2 and finishes
  assert.equal(r2.done, true);
  assert.equal(f.messages.length, 4);
  // The frozen promise resolves minutes later: generation mismatch, so its
  // result is dropped — no extra replay, no extra summary row.
  settle({
    status: 200,
    headers: { get: () => "application/json" },
    text: async () => "{}",
  });
  await p1;
  assert.equal(f.messages.length, 4);
  assert.equal(f.getSummary().results.length, 4);
});

test("a concurrent round while not frozen is rejected as in-flight", async (t) => {
  before(t);
  const f = fakeEnv({ statuses: [200, "hang"] });
  /** @type {Promise<any>} */
  const p = portalRound(f.env); // hangs on the second fetch — never resolves
  await new Promise((r) => setTimeout(r, 0)); // let it reach the hung fetch
  const mid = await portalRound(f.env); // same context: the round is running
  assert.equal(mid.skipped, "in-flight");
  assert.equal(f.calls.length, 2); // no duplicate fetch
  void p; // never settles — the fake models a slow network
});

test("the in-progress marker blocks a second load for 2 minutes", async (t) => {
  before(t);
  const fresh = fakeEnv({ inProgress: Date.parse(NOW.toISOString()) });
  const r = await portalRound(fresh.env);
  assert.equal(r.skipped, "in-progress");
  assert.equal(fresh.calls.length, 0);
  // A stale marker no longer blocks.
  const stale = fakeEnv({ inProgress: Date.parse(NOW.toISOString()) - 3 * 60 * 1000 });
  const r2 = await portalRound(stale.env);
  assert.equal(r2.sent, 4);
});

test("first-endpoint 401/403 stops the round after replaying it", async (t) => {
  before(t);
  for (const status of [401, 403]) {
    __resetPortalRound();
    const { env, calls, messages, getSummary } = fakeEnv({ status });
    const r = await portalRound(env);
    assert.equal(calls.length, 1);
    // The 401/403 still replays (the passive path would forward it; the
    // background marks the session signed-out) — then nothing further.
    assert.equal(messages.length, 1);
    assert.equal(messages[0].payload.status, status);
    assert.equal(r.results, 1);
    assert.equal(getSummary().results[0].error, `http-${status}`);
  }
});

test("a later-endpoint 403 skips that endpoint and continues", async (t) => {
  before(t);
  const { env, calls, messages, getSummary } = fakeEnv({ statuses: [200, 200, 403, 200] });
  const r = await portalRound(env);
  assert.equal(r.sent, 4);
  assert.equal(calls.length, 4);
  assert.equal(messages.length, 4);
  assert.equal(messages[2].payload.status, 403);
  const res = getSummary().results;
  assert.equal(res.length, 4);
  assert.equal(res[2].error, "http-403");
  assert.ok(!res[0].error && !res[1].error && !res[3].error);
  assert.ok(!JSON.stringify(getSummary()).includes(TOKEN));
});

test("summary carries path-only rows and a failing round retries in 5 min", async (t) => {
  before(t);
  const { env, calls, getSummary } = fakeEnv({ statuses: [200, 200, new Error("boom"), 200] });
  const r = await portalRound(env);
  assert.equal(r.sent, 3);
  const s = getSummary();
  assert.equal(s.results.length, 4);
  assert.equal(s.results[2].error, "network");
  for (const row of s.results) {
    assert.ok(row.path.startsWith("/v2/"));
    assert.ok(!row.path.includes("?") && !row.path.includes("start="));
    assert.ok(typeof row.ms === "number");
  }
  // 10 min later a clean round would still be throttled, but a failed round
  // retries after 5.
  const again = await portalRound({ ...env, now: new Date(NOW.getTime() + 6 * 60 * 1000) });
  assert.equal(again.sent, 4);
  assert.equal(calls.length, 8);
});

test("a clean round waits the full 30-minute gap", async (t) => {
  before(t);
  const { env, calls } = fakeEnv();
  await portalRound(env);
  assert.equal(calls.length, 4);
  const r2 = await portalRound({ ...env, now: new Date(NOW.getTime() + 10 * 60 * 1000) });
  assert.equal(r2.skipped, "throttled");
  assert.equal(calls.length, 4);
  const r3 = await portalRound({ ...env, now: new Date(NOW.getTime() + 40 * 60 * 1000) });
  assert.equal(r3.sent, 4);
  assert.equal(calls.length, 8);
});

test("a replayed schedule payload parses exactly like a passive capture", async (t) => {
  before(t);
  const { env, messages } = fakeEnv({
    body: fs.readFileSync(path.join(DIR, "schedule.json"), "utf8"),
  });
  await portalRound(env);
  const sched = messages[1].payload;
  const res = await adapter.observe.parse(sched, {
    now: NOW,
    settings: {},
    state: {},
    courses: [],
    log: () => {},
    textDates: () => [],
    fetch: async () => ({ status: 0 }),
    relay: async () => ({ status: 0 }),
    parseHtml: async () => null,
  });
  assert.equal(res.scope, "portal:schedule");
  assert.equal(res.complete, true);
  assert.ok(res.items.length > 0);
});

test("content.js never calls Account/Refresh or chrome.storage", () => {
  const src = fs.readFileSync(SRC, "utf8");
  assert.ok(!src.includes("Account/Refresh"));
  assert.ok(!src.includes("chrome.storage"));
});
