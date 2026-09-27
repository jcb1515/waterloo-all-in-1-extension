// @ts-check
// CP1 integration: the real adapters + the real core merge pipeline over the
// redacted fixtures. parseHtml fakes dispatch to the real parser modules
// through linkedom, the same way the offscreen document does.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseHTML } from "linkedom";

import outlineAdapter from "../../extension/src/sources/outline/index.js";
import wwAdapter from "../../extension/src/sources/waterlooworks/index.js";
import { parseOutline } from "../../extension/src/sources/outline/parsers.js";
import * as wwParsers from "../../extension/src/sources/waterlooworks/parsers.js";
import { adapterSettings } from "../../extension/src/core/scheduler.js";
import {
  applyResult,
  recompute,
  mergeUpdates,
  resultUpdates,
} from "../../extension/src/core/merge.js";
import { DEFAULT_SETTINGS } from "../../extension/src/core/store.js";
import { extractDates } from "../../extension/src/lib/textdates/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTLINE_DIR = path.join(ROOT, "fixtures", "outline");
const WW_DIR = path.join(ROOT, "fixtures", "waterlooworks");
const fixture = (dir, name) => readFileSync(path.join(dir, name), "utf8");

const NOW = new Date("2026-09-26T16:00:00.000Z");

// Same order-agnostic (html, parser) | (parser, html) convention as
// capture/parse.js — the offscreen dispatch in miniature.
const PARSER_NAME = /^[a-z0-9_-]+\/[a-z0-9_-]+$/i;
const TABLE = { "outline/parseOutline": parseOutline, "waterlooworks/parseAll": wwParsers.parseAll };
function makeParseHtml(extra = {}) {
  return async (a, b, opts) => {
    const parser = PARSER_NAME.test(String(a)) ? a : b;
    const html = PARSER_NAME.test(String(a)) ? b : a;
    const fn = extra[parser] || TABLE[parser];
    assert.ok(fn, `unknown parser ${parser}`);
    return fn(parseHTML(String(html)).document, opts);
  };
}

/* ------------------- 1. outline adapter over the ECE 150 fixture ------------------- */

test("outline adapter: ECE 150 fixture yields LEC 002 classes only", async () => {
  const settings = adapterSettings("outline", DEFAULT_SETTINGS);
  assert.ok(Array.isArray(settings.urls), "urls normalised to a list");
  const ece150 = fixture(OUTLINE_DIR, "ECE150.html");
  const ctx = {
    now: NOW,
    settings,
    state: {},
    courses: [],
    terms: [],
    log() {},
    textDates: extractDates,
    fetch: async (url) =>
      url === settings.urls[0]
        ? { status: 200, url, contentType: "text/html", text: ece150 }
        : { status: 404, error: "not found" },
    parseHtml: makeParseHtml(),
  };
  const res = await outlineAdapter.sync(/** @type {any} */ (ctx));
  assert.equal(res.complete, true);
  assert.deepEqual(res.readOk, ["ECE 150"]);
  const classes = res.items.filter((i) => i.type === "class" || i.type === "tutorial" || i.type === "lab");
  assert.ok(classes.length > 0, "expected class items");
  assert.ok(
    classes.every((i) => i.section === "LEC 002"),
    `only the enrolled section, got: ${[...new Set(classes.map((i) => i.section))]}`
  );
  assert.ok(res.items.every((i) => i.source === "outline"));
  // seenIn scopes must equal the course codes in readOk, or a failed course
  // would keep stale items and a good one would drop fresh ones.
  assert.ok(
    res.items.every((i) => (i.seenIn || []).every((s) => res.readOk.includes(s.scope))),
    "seenIn scopes align with readOk"
  );
});

/* ------------ 2. WaterlooWorks observe -> applyResult -> recompute ------------ */

const WW_BASE = "https://waterlooworks.uwaterloo.ca/myAccount/co-op/full";

function wwCtx(state) {
  return {
    now: NOW,
    settings: {},
    state,
    courses: [],
    terms: [],
    log() {},
    textDates: extractDates,
    fetch: async () => ({ status: 0, error: "unused" }),
    relay: async () => ({ status: 0, error: "unused" }),
    parseHtml: makeParseHtml(),
  };
}

test("waterlooworks interviews payload becomes interview items", async () => {
  const payload = {
    source: "waterlooworks",
    kind: "net",
    url: `${WW_BASE}/interviews.htm`,
    body: fixture(WW_DIR, "interviews.html"),
    at: NOW.toISOString(),
  };
  const result = await wwAdapter.observe.parse(payload, wwCtx({}));
  assert.equal(result.scope, "waterlooworks");
  assert.ok(Array.isArray(result.items));

  const raw = applyResult(null, result, { mode: "scope", scope: result.scope });
  const { items } = recompute({ raws: { waterlooworks: raw }, now: NOW });
  const interviews = Object.values(items).filter((i) => i.type === "interview");
  assert.ok(interviews.length > 0, "expected interview items in the merged view");
  assert.ok(interviews.every((i) => i.startAt), "interviews carry startAt");
});

/* --------- 3. application diff -> one update; replay adds none --------- */

test("application status change yields exactly one deduplicated update", async () => {
  const url = `${WW_BASE}/applications.htm`;
  const body = fixture(WW_DIR, "applications.html");
  const first = await wwAdapter.observe.parse(
    { source: "waterlooworks", kind: "net", url, body, at: NOW.toISOString() },
    wwCtx({})
  );
  assert.equal(resultUpdates(first).length, 0, "first read is a bulk import — no updates");

  const changedBody = body.replace(">Applied</span>", ">Selected for Interview</span>");
  const second = await wwAdapter.observe.parse(
    { source: "waterlooworks", kind: "net", url, body: changedBody, at: "2026-09-27T12:00:00.000Z" },
    wwCtx(first.state)
  );
  const updates = resultUpdates(second);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].kind, "status");

  // Into the feed once…
  const feed = mergeUpdates([], updates);
  assert.equal(feed.length, 1);
  // …replaying the same SyncResult adds nothing (deterministic ids)…
  const replayedResult = mergeUpdates(feed, resultUpdates(second));
  assert.equal(replayedResult.length, 1);
  // …and replaying the payload against the advanced state produces no updates.
  const replay = await wwAdapter.observe.parse(
    { source: "waterlooworks", kind: "net", url, body: changedBody, at: "2026-09-27T13:00:00.000Z" },
    wwCtx(second.state)
  );
  assert.equal(resultUpdates(replay).length, 0);
});

/* --------------------------- 4. adapterSettings --------------------------- */

test("adapterSettings merges profile and source settings; object urls -> list", () => {
  const outline = adapterSettings("outline", DEFAULT_SETTINGS);
  assert.equal(outline.enabled, true);
  assert.deepEqual(outline.urls, ["https://outline.uwaterloo.ca/viewer/view/npch7t"]);
  assert.equal(outline.sections["ECE 150"][0], "LEC 002");
  assert.equal(outline.groups["ECE 190"], "5");

  // Arrays pass through untouched.
  const arr = adapterSettings("outline", {
    profile: { sections: { "ECE 150": ["LEC 001"] }, groups: {} },
    sources: { outline: { urls: ["https://x/1", "https://x/2"], files: [{ name: "a.html" }] } },
  });
  assert.deepEqual(arr.urls, ["https://x/1", "https://x/2"]);
  assert.deepEqual(arr.sections["ECE 150"], ["LEC 001"]);
  assert.equal(arr.files.length, 1);

  // A source with no block still sees the profile slice.
  const ww = adapterSettings("waterlooworks", DEFAULT_SETTINGS);
  assert.equal(ww.sections["ECE 150"][0], "LEC 002");
});
