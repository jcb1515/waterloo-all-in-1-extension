// @ts-check
// Portal content-script auto-fetch: the round, the replayed payload shape,
// the token rules and the throttle — all with injected fakes (no chrome, no
// network). Fixtures are synthetic.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import adapter from "../../extension/src/sources/portal/index.js";
import { portalRound, portalFetchUrls } from "../../extension/src/sources/portal/content.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "portal");
const NOW = new Date("2026-09-28T12:00:00.000Z"); // Mon Sep 28 2026, 08:00 EDT
const TOKEN = "header.payload.signature";
const SRC = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "extension", "src", "sources", "portal", "content.js",
);

/** A fake page env: records fetch calls + messages, holds token/stamp. */
const fakeEnv = ({ token = TOKEN, last = 0, status = 200, body = "{}" } = {}) => {
  /** @type {{url: string, init: any}[]} */
  const calls = [];
  /** @type {any[]} */
  const messages = [];
  let stamp = last;
  const env = {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        status,
        headers: { get: (h) => (h === "content-type" ? "application/json" : null) },
        text: async () => body,
      };
    },
    sendMessage: (m) => messages.push(m),
    getToken: () => token,
    getLast: () => stamp,
    setLast: (ms) => {
      stamp = ms;
    },
    now: NOW,
  };
  return { env, calls, messages };
};

test("portal fetch urls: the four endpoints in order, Toronto-dated window", () => {
  const urls = portalFetchUrls(NOW);
  assert.deepEqual(urls, [
    "https://portalapi2.uwaterloo.ca/v2/student/CourseEnrollments/",
    "https://portalapi2.uwaterloo.ca/v2/student/CourseSchedule/",
    "https://portalapi2.uwaterloo.ca/v2/student/ExamSchedule/",
    "https://portalapi2.uwaterloo.ca/v2/Calendar/DailyEventsV2?start=2026-09-21&end=2027-01-26",
  ]);
});

test("a token runs the 4 GETs in order and replays each response", async () => {
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
  // The token never leaves the request headers.
  assert.ok(!JSON.stringify(messages).includes(TOKEN));
  assert.ok(!JSON.stringify(calls.map((c) => c.url)).includes(TOKEN));
});

test("no token, 401 and 403 send nothing and fetch nothing further", async () => {
  let { env, calls, messages } = fakeEnv({ token: null });
  await portalRound(env);
  assert.equal(calls.length, 0);
  assert.equal(messages.length, 0);

  for (const status of [401, 403]) {
    ({ env, calls, messages } = fakeEnv({ status }));
    await portalRound(env);
    assert.equal(calls.length, 1); // stopped after the failed call
    assert.equal(messages.length, 0);
  }
});

test("at most one round per 30 minutes", async () => {
  const { env, calls } = fakeEnv();
  await portalRound(env);
  assert.equal(calls.length, 4);
  const r2 = await portalRound({ ...env, now: new Date(NOW.getTime() + 10 * 60 * 1000) });
  assert.equal(r2.skipped, "throttled");
  assert.equal(calls.length, 4);
  // After the gap the round runs again.
  const r3 = await portalRound({ ...env, now: new Date(NOW.getTime() + 40 * 60 * 1000) });
  assert.equal(r3.sent, 4);
  assert.equal(calls.length, 8);
});

test("a replayed schedule payload parses exactly like a passive capture", async () => {
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
