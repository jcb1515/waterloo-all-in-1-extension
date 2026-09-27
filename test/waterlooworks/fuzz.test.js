// @ts-check
// Robustness + growth: ~300 deterministic malformed ObservedPayloads must
// never throw and must always return {items: Array, scope}; sync() survives
// garbage ctx.state. Then 1000 realistic reads prove state stays bounded —
// every accumulator must hold its documented cap.
import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { extractDates } from "../../extension/src/lib/textdates/index.js";
import * as parsers from "../../extension/src/sources/waterlooworks/parsers.js";
import adapter from "../../extension/src/sources/waterlooworks/index.js";

const NOW = new Date("2026-09-20T12:00:00.000Z");
const AT = NOW.toISOString();

/** Deterministic PRNG so failures reproduce. */
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rnd, list) => list[Math.floor(rnd() * list.length)];

function randText(rnd, len) {
  const pool =
    "abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<>&\"'{}[]()/=?#$|é中🎉\n\r\t";
  let s = "";
  for (let i = 0; i < len; i++) s += pool[Math.floor(rnd() * pool.length)];
  return s;
}

/** A random JSON-ish garbage value. */
function garbage(rnd, depth = 0) {
  const kinds = [
    () => rnd() * 1000 - 500,
    () => Math.floor(rnd() * 1e18).toString(),
    () => randText(rnd, Math.floor(rnd() * 40)),
    () => rnd() < 0.5,
    () => null,
    () => undefined,
    () =>
      depth < 2
        ? Array.from({ length: Math.floor(rnd() * 4) }, () => garbage(rnd, depth + 1))
        : [],
    () =>
      depth < 2
        ? Object.fromEntries(
            Array.from({ length: Math.floor(rnd() * 4) }, () => [
              randText(rnd, 6),
              garbage(rnd, depth + 1),
            ])
          )
        : {},
  ];
  return pick(rnd, kinds)();
}

function randBody(rnd) {
  return pick(rnd, [
    () => randText(rnd, Math.floor(rnd() * 400)), // noise
    () => '{"rows":[' + randText(rnd, 50), // truncated JSON
    () => "[{" + randText(rnd, 30),
    () => `<table><tr><td>${randText(rnd, 40)}</td></tr></table>`, // odd HTML
    () => `<html><body>${randText(rnd, 200)}`, // truncated HTML
    () => "",
    () => "   ",
    () => JSON.stringify(garbage(rnd)),
    () => "x".repeat(1024 * 1024), // 1 MB string (rare path)
  ])();
}

function makeCtx(state = {}, extras = {}) {
  return {
    state,
    now: NOW,
    settings: {},
    async parseHtml(html, name, opts) {
      const exportName = String(name).split("/")[1];
      const fn = parsers[exportName];
      if (typeof fn !== "function") return {};
      return fn(parseHTML(String(html)).document, opts);
    },
    textDates: extractDates,
    log() {},
    ...extras,
  };
}

test("fuzz: 300 malformed payloads never throw and return {items, scope}", async () => {
  const rnd = mulberry32(20260927);
  const kinds = ["dom", "net", "snapshot", 5, null, undefined, {}];
  const urls = [
    "https://waterlooworks.uwaterloo.ca/myAccount/co-op/full/applications.htm",
    "https://waterlooworks.uwaterloo.ca/myAccount/co-op/full/interviews.htm",
    "not a url",
    "",
    "https://waterlooworks.uwaterloo.ca/",
  ];
  for (let i = 0; i < 300; i++) {
    const payload = {
      source: "waterlooworks",
      kind: pick(rnd, kinds),
      url: rnd() < 0.85 ? pick(rnd, urls) : garbage(rnd),
      method: pick(rnd, ["GET", "POST", 5, null, {}]),
      status: pick(rnd, [200, 404, "200", {}, null, -1]),
      body: randBody(rnd),
      at: pick(rnd, [AT, "garbage", 12345, null, {}]),
    };
    // Every fifth case feeds a garbage prior state too.
    const state = i % 5 === 0 ? garbage(rnd) : {};
    const result = await adapter.observe.parse(payload, makeCtx(state));
    assert.ok(result && typeof result === "object", `case ${i}: result`);
    assert.ok(Array.isArray(result.items), `case ${i}: items array`);
    assert.equal(result.scope, "waterlooworks", `case ${i}: scope`);
    assert.ok(result.state && typeof result.state === "object", `case ${i}: state`);
  }
});

test("fuzz: sync() survives garbage ctx.state", async () => {
  const rnd = mulberry32(777);
  for (let i = 0; i < 100; i++) {
    const result = await adapter.sync(makeCtx(garbage(rnd)));
    assert.ok(result && typeof result === "object", `case ${i}: result`);
    assert.ok(Array.isArray(result.items), `case ${i}: items array`);
    assert.ok(Array.isArray(result.applications), `case ${i}: applications array`);
  }
});

/**
 * 1000 realistic reads through a fake parseHtml that returns synthetic
 * parsed sections (identical to what the DOM parsers produce), each with
 * unique jobs/messages — proves every accumulator is capped.
 */
test("growth: 1000 unique reads keep state under 1.5 MB and hold all caps", async () => {
  const sections = [];
  for (let i = 0; i < 1000; i++) {
    const mod = i % 4;
    if (mod === 0) {
      sections.push({
        url: "https://waterlooworks.uwaterloo.ca/myAccount/co-op/interviewDetail.htm",
        parsed: {
          page: "interview-detail",
          "interview-detail": {
            jobId: `job-${i}`,
            employer: `Employer ${i}`,
            jobTitle: `Job Title ${i}`,
            when: "Mon Oct 5, 2026 2:30 PM",
            where: "Tatham Centre 2218",
            method: "In-Person",
            type: "Individual",
          },
        },
      });
    } else if (mod === 1) {
      sections.push({
        url: "https://waterlooworks.uwaterloo.ca/myAccount/co-op/jobPosting.htm",
        parsed: {
          page: "posting",
          posting: {
            jobId: `job-${i}`,
            jobTitle: `Posting ${i}`,
            employer: `Employer ${i}`,
            deadline: "Oct 10, 2026",
            workTerm: "Winter 2027",
            level: "Junior",
          },
        },
      });
    } else if (mod === 2) {
      sections.push({
        url: "https://waterlooworks.uwaterloo.ca/myAccount/messages/messageDetail.htm",
        parsed: {
          page: "message-detail",
          "message-detail": {
            subject: `Message ${i} — interview scheduled Oct 20`,
            category: "Interview",
            createdAt: "2026-09-19",
            bodyText: `Body ${i}: your interview is on October 20 2026 at 2pm.`,
            linkedJobId: `job-${i}`,
          },
        },
      });
    } else {
      sections.push({
        url: "https://waterlooworks.uwaterloo.ca/myAccount/co-op/applications.htm",
        parsed: {
          page: "applications",
          applications: {
            rows: [
              {
                jobId: `job-${i}`,
                jobTitle: `Applied ${i}`,
                employer: `Employer ${i}`,
                status: "Applied",
                applicationDeadline: "Oct 1, 2026",
              },
            ],
          },
        },
      });
    }
  }

  let state = {};
  let cursor = 0;
  const ctx = makeCtx(state, {
    async parseHtml() {
      return sections[cursor].parsed;
    },
  });
  for (const s of sections) {
    const result = await adapter.observe.parse(
      {
        source: "waterlooworks",
        kind: "net",
        url: s.url,
        method: "GET",
        status: 200,
        body: "<html></html>",
        at: AT,
      },
      ctx
    );
    state = result.state;
    ctx.state = state;
    cursor++;
  }

  const bytes = JSON.stringify(state).length;
  assert.ok(bytes < 1_500_000, `state ${bytes} bytes`);
  assert.ok((state.messages || []).length <= 50);
  assert.ok((state.messageDetails || []).length <= 50);
  assert.ok((state.applications || []).length <= 500);
  assert.ok((state.lastGood["interview-detail"]?.items || []).length <= 200);
  assert.ok((state.lastGood.posting?.items || []).length <= 200);
  assert.ok((state.lastGood["message-dates"]?.items || []).length <= 300);
});
