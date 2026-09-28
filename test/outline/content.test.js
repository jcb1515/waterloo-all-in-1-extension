// @ts-check
// Outline in-tab fetch round: URL collection from both storage sources,
// host filtering, dedupe, sign-in stop, throttle, in-progress TTL and
// freeze/resume — plus the static "viewer/view only" network rules.

import test from "node:test";
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectOutlineUrls,
  outlineRound,
  outlineFreeze,
  __resetOutlineRound,
} from "../../extension/src/sources/outline/content.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)));
const NOW = new Date("2026-10-01T15:00:00.000Z");
const V = "https://outline.uwaterloo.ca/viewer/view/";

beforeEach(() => __resetOutlineRound());

const fakeEnv = ({ bag = {}, last = null, frozen = false, inProgress = 0, pages = {} } = {}) => {
  /** @type {{url: string, init: any}[]} */
  const calls = [];
  /** @type {any[]} */
  const messages = [];
  let stamp = last;
  let ip = inProgress;
  let froz = frozen;
  const env = {
    fetchImpl: async (/** @type {string} */ url, /** @type {any} */ init) => {
      calls.push({ url, init });
      const p = /** @type {any} */ (pages)[url] || { status: 200, body: "<html><body>outline</body></html>" };
      if (p.hang) return new Promise(() => {});
      return {
        status: p.status ?? 200,
        url: p.finalUrl || url,
        redirected: !!p.redirected,
        headers: { get: () => "text/html" },
        text: async () => p.body || "",
      };
    },
    sendMessage: (/** @type {any} */ m) => messages.push(m),
    getUrls: async () => bag,
    getLast: () => stamp,
    setLast: (/** @type {any} */ s) => {
      stamp = s;
    },
    getInProgress: () => ip,
    setInProgress: (/** @type {number} */ ms) => {
      ip = ms;
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
  };
};

const BAG = {
  courses: [
    { code: "MATH 115", outlineUrl: `${V}math115` },
    { code: "ECE 150", outlineUrl: `${V}ece150` },
    { code: "CS 136", outlineUrl: "https://web.archive.org/viewer/view/notoutline" },
    { code: "PD 20" }, // no outlineUrl
  ],
  wa1Settings: {
    sources: { outline: { urls: [`${V}math117`, `${V}math115#top`, "https://outline.uwaterloo.ca/browse"] } },
  },
};

test("collectOutlineUrls unions both sources, filters and dedupes", () => {
  const urls = collectOutlineUrls(BAG.courses, BAG.wa1Settings);
  assert.deepEqual(urls, [`${V}math115`, `${V}ece150`, `${V}math117`]);
  // A code-keyed courses map works the same.
  const map = { "MATH 115": BAG.courses[0], "ECE 150": BAG.courses[1] };
  assert.deepEqual(collectOutlineUrls(map, {}), [`${V}math115`, `${V}ece150`]);
  assert.deepEqual(collectOutlineUrls([], {}), []);
});

test("a round fetches each url sequentially and replays every page", async () => {
  const { env, calls, messages, getStamp, getIp } = fakeEnv({ bag: BAG });
  const r = await env.getUrls().then((bag) => collectOutlineUrls(bag.courses, bag.wa1Settings));
  const res = await outlineRound(env);
  assert.equal(res.done, true);
  assert.equal(res.sent, 3);
  assert.deepEqual(calls.map((c) => c.url), r); // in order, no repeats
  assert.equal(calls[0].init.credentials, "include");
  assert.equal(calls[0].init.method, "GET");
  for (const [i, m] of messages.entries()) {
    assert.equal(m.type, "wa1:observed");
    assert.equal(m.payload.source, "outline");
    assert.equal(m.payload.kind, "dom");
    assert.equal(m.payload.url, r[i].split("#")[0]);
    assert.ok(m.payload.body.includes("outline"));
  }
  assert.deepEqual(getStamp(), { at: NOW.getTime(), ok: true });
  assert.equal(getIp(), 0); // in-progress released
});

test("throttle: 6 h after a clean round, 5 min after a failure", async () => {
  const { env, calls } = fakeEnv({ bag: BAG });
  await outlineRound(env);
  assert.equal((await outlineRound(env)).skipped, "throttled");
  assert.equal(calls.length, 3);

  const f = fakeEnv({ bag: BAG, last: { at: NOW.getTime() - 4 * 60 * 1000, ok: false } });
  assert.equal((await outlineRound(f.env)).skipped, "throttled");
  const g = fakeEnv({ bag: BAG, last: { at: NOW.getTime() - 6 * 60 * 1000, ok: false } });
  assert.equal((await outlineRound(g.env)).done, true);
});

test("the in-progress marker blocks a second load for 2 minutes", async () => {
  const { env, calls } = fakeEnv({
    bag: BAG,
    inProgress: NOW.getTime() - 60 * 1000,
  });
  assert.equal((await outlineRound(env)).skipped, "in-progress");
  assert.equal(calls.length, 0);
  const f2 = fakeEnv({ bag: BAG, inProgress: NOW.getTime() - 3 * 60 * 1000 });
  assert.equal((await outlineRound(f2.env)).done, true);
});

test("a sign-in page stops the round and marks it failed", async () => {
  const { env, calls, messages, getStamp } = fakeEnv({
    bag: BAG,
    pages: {
      [`${V}ece150`]: { status: 200, body: "<html><body>UW Sign In — Duo</body></html>" },
    },
  });
  const r = await outlineRound(env);
  assert.equal(r.done, true); // the round completes — failed, not paused
  assert.equal(r.sent, 1); // math115 went out, ece150 stopped it, math117 never ran
  assert.equal(calls.length, 2);
  assert.equal(messages.length, 1);
  assert.equal(getStamp().ok, false);
});

test("a redirect off outline.uwaterloo.ca is a sign-in too", async () => {
  const { env, messages } = fakeEnv({
    bag: { courses: [{ outlineUrl: `${V}math115` }] },
    pages: {
      [`${V}math115`]: {
        status: 200,
        redirected: true,
        finalUrl: "https://idp.uwaterloo.ca/idp/profile/SAML2/SSO",
        body: "<html></html>",
      },
    },
  });
  const r = await outlineRound(env);
  assert.equal(r.sent, 0);
  assert.equal(messages.length, 0);
});

test("a non-2xx mid-round skips that url but the round still finishes", async () => {
  const { env, calls, messages, getStamp } = fakeEnv({
    bag: BAG,
    pages: { [`${V}ece150`]: { status: 500, body: "err" } },
  });
  const r = await outlineRound(env);
  assert.equal(r.done, true);
  assert.equal(r.sent, 2);
  assert.equal(calls.length, 3);
  assert.equal(messages.length, 2);
  assert.equal(getStamp().ok, false);
});

test("a frozen tab runs nothing and resumes after the freeze", async () => {
  const { env, calls, setFrozen } = fakeEnv({ bag: BAG, frozen: true });
  assert.equal((await outlineRound(env)).skipped, "frozen");
  assert.equal(calls.length, 0);
  setFrozen(false);
  assert.equal((await outlineRound(env)).sent, 3);
});

test("a freeze mid-fetch re-issues exactly that url once on resume", async () => {
  /** @type {(v: any) => void} */
  let settle = () => {};
  const f = fakeEnv({ bag: BAG });
  f.env.fetchImpl = async (url, init) => {
    f.calls.push({ url, init });
    if (f.calls.length === 2) return new Promise((r) => (settle = r));
    return { status: 200, url, headers: { get: () => "text/html" }, text: async () => "<html>o</html>" };
  };
  const p1 = outlineRound(f.env); // parks on fetch 2
  await new Promise((r) => setTimeout(r, 0));
  outlineFreeze();
  f.setFrozen(true);
  assert.equal((await outlineRound(f.env)).skipped, "frozen");
  assert.equal(f.calls.length, 2);
  f.setFrozen(false);
  const p2 = outlineRound(f.env); // resume: re-issue url 2, then url 3
  await new Promise((r) => setTimeout(r, 0));
  // Resolve p1's stale fetch late — its result must be dropped.
  settle({ status: 200, url: "", headers: { get: () => "text/html" }, text: async () => "<html>o</html>" });
  const r2 = await p2;
  assert.equal(r2.sent, 2); // ece150 + math117 in the resumed run
  const r1 = await p1;
  assert.equal(r1.stale, true);
  assert.equal(f.messages.length, 3); // each page replayed exactly once
  assert.deepEqual(
    f.calls.map((c) => c.url),
    [`${V}math115`, `${V}ece150`, `${V}ece150`, `${V}math117`],
  );
});

test("outline sources: only viewer/view GETs, no chrome.storage writes", () => {
  const SRC = path.resolve(DIR, "..", "..", "extension", "src", "sources", "outline");
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith(".js"));
  for (const file of files) {
    const src = fs.readFileSync(path.join(SRC, file), "utf8");
    // Bare `fetch(` only — `ctx.fetch(` is the adapter's sanctioned sync
    // tier, not a content-script request.
    const fetches = src.match(/(?<![.\w])fetch\s*\(/g) || [];
    if (file === "content.js") {
      assert.equal(fetches.length, 1, "content.js binds fetch once for the round");
    } else {
      assert.equal(fetches.length, 0, `${file} must not fetch`);
    }
    // chrome.storage is read-only from content scripts.
    assert.ok(!/chrome\.storage\.[a-z]+\.(set|remove|clear)/.test(src), `${file} writes chrome.storage`);
  }
  const content = fs.readFileSync(path.join(SRC, "content.js"), "utf8");
  // Every URL the round fetches comes through collectOutlineUrls, which
  // requires the viewer/view prefix — assert the guard is the filter.
  assert.ok(content.includes('`${ORIGIN}/viewer/view/`'), "content.js keeps the viewer/view prefix");
  assert.ok(!/https:\/\/(?!outline\.uwaterloo\.ca)/.test(content), "no off-origin urls in content.js");
});
