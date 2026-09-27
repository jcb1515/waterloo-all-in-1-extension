// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { normCourseCode, itemId, SITE_BY_HOST, MSG, PAGE_EVENT } from "../../extension/src/core/contract.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("normCourseCode normalises UW course codes", () => {
  assert.equal(normCourseCode("ece105"), "ECE 105");
  assert.equal(normCourseCode("MATH 117"), "MATH 117");
  assert.equal(normCourseCode("math117"), "MATH 117");
  assert.equal(normCourseCode("CS 136L"), "CS 136L");
});

test("normCourseCode strips instructor suffix", () => {
  assert.equal(normCourseCode("ECE203_pmitran_1269"), "ECE 203");
  // A lowercase tail is not a catalog suffix, so this is not a course code.
  assert.equal(normCourseCode("ECE203pm"), "ECE203pm");
});

test("itemId builds source:key ids", () => {
  assert.equal(itemId("learn", "123:dropbox:42"), "learn:123:dropbox:42");
  assert.equal(itemId("waterlooworks", "offer-9"), "waterlooworks:offer-9");
});

test("SITE_BY_HOST covers every manifest host except outline and the feed worker", () => {
  const manifest = JSON.parse(readFileSync(path.join(REPO, "extension", "manifest.json"), "utf8"));
  const hosts = new Set();
  for (const p of manifest.host_permissions || []) hosts.add(new URL(p).hostname);
  for (const cs of manifest.content_scripts || []) for (const m of cs.matches || []) hosts.add(new URL(m).hostname);
  for (const host of hosts) {
    if (host === "outline.uwaterloo.ca") continue; // public pages, fetched directly
    if (host.endsWith(".workers.dev")) continue; // our own calendar feed server
    assert.ok(SITE_BY_HOST[host], `SITE_BY_HOST is missing ${host}`);
  }
});

test("recorder message names are stable", () => {
  assert.equal(MSG.DISCOVERY, "wa1:discovery");
  assert.equal(MSG.TAB_READY, "wa1:tab-ready");
  assert.equal(PAGE_EVENT, "wa1:page-net");
});
