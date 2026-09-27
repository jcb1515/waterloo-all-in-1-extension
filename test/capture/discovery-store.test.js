// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { mergeEntries } from "../../extension/src/capture/discovery-store.js";

const T0 = "2026-09-26T00:00:00.000Z";
const T1 = "2026-09-26T01:00:00.000Z";
const T2 = "2026-09-26T02:00:00.000Z";

const fresh = () => ({ site: "portal", startedAt: T0, net: {}, pages: {} });
/** @param {string} endpoint @param {any} shape @param {object} [extra] */
const net = (endpoint, shape, extra = {}) => ({
  kind: "net",
  method: "GET",
  endpoint,
  status: 200,
  contentType: "application/json",
  size: 10,
  shape,
  ...extra,
});
/** @param {string} path @param {any} outline */
const page = (path, outline, title = "Page") => ({ kind: "page", path, title, outline });

test("mergeEntries groups same endpoint+status into one record with variants", () => {
  const d = fresh();
  mergeEntries(
    d,
    [
      net("/api/jobs", { a: "<number>" }),
      net("/api/jobs", { b: "<string 3>" }),
      net("/api/jobs", { a: "<number>" }),
      net("/api/jobs", { a: "<number>" }, { status: 500 }),
    ],
    T1
  );
  const recs = Object.values(d.net);
  assert.equal(recs.length, 2); // status 200 and 500 are separate records
  const ok = recs.find((r) => r.status === 200);
  assert.equal(ok.method, "GET");
  assert.equal(ok.endpoint, "/api/jobs");
  assert.equal(ok.contentType, "application/json");
  assert.equal(ok.count, 3);
  assert.equal(ok.firstAt, T1);
  assert.equal(ok.lastAt, T1);
  assert.equal(ok.variants.length, 2); // same endpoint, different shapes
  assert.equal(ok.variants.reduce((s, v) => s + v.count, 0), 3);
});

test("mergeEntries caps variants at 3, evicting lowest count then oldest", () => {
  const d = fresh();
  const seed = [];
  for (let i = 0; i < 5; i++) seed.push(net("/api/x", { a: true }));
  for (let i = 0; i < 2; i++) seed.push(net("/api/x", { b: true }));
  seed.push(net("/api/x", { c: true }));
  mergeEntries(d, seed, T0);
  let vars = Object.values(d.net)[0].variants;
  assert.equal(vars.length, 3);

  // A fourth distinct shape: counts are a=5, b=2, c=1, d=1; c is older -> c out.
  mergeEntries(d, [net("/api/x", { d: true })], T2);
  vars = Object.values(d.net)[0].variants;
  assert.equal(vars.length, 3);
  const stored = vars.map((v) => JSON.stringify(v.shape));
  assert.ok(stored.includes(JSON.stringify({ a: true })));
  assert.ok(stored.includes(JSON.stringify({ b: true })));
  assert.ok(stored.includes(JSON.stringify({ d: true })));
});

test("mergeEntries evicts the stalest records at the caps", () => {
  const d = fresh();
  // One old record, then 500 fresh ones -> 501 total, the old one goes.
  mergeEntries(d, [net("/api/oldest", {})], T0);
  mergeEntries(d, Array.from({ length: 500 }, (_, i) => net(`/api/n${i}`, {})), T1);
  assert.equal(Object.keys(d.net).length, 500);
  assert.ok(!("GET /api/oldest 200" in d.net));
  assert.ok("GET /api/n499 200" in d.net);

  const d2 = fresh();
  mergeEntries(d2, [page("portal.x/old", { v: 0 })], T0);
  mergeEntries(d2, Array.from({ length: 200 }, (_, i) => page(`portal.x/p${i}`, { v: i })), T1);
  assert.equal(Object.keys(d2.pages).length, 200);
  assert.ok(!("portal.x/old" in d2.pages));
});

test("mergeEntries stores a truncation marker for oversized shapes", () => {
  const d = fresh();
  const big = { filler: "x".repeat(160000), keep: "y" };
  mergeEntries(d, [net("/api/big", big)], T1);
  const v = Object.values(d.net)[0].variants[0];
  assert.equal(v.shape.truncated, true);
  assert.ok(v.shape.chars > 150000);
  assert.deepEqual(v.shape.topKeys, ["filler", "keep"]);
  assert.ok(v.hash);
});

test("mergeEntries tracks page records by path with outline variants", () => {
  const d = fresh();
  mergeEntries(
    d,
    [
      page("portal.x/jobs", { headings: ["h1: Jobs"] }),
      page("portal.x/jobs", { headings: ["h1: Jobs"], extra: true }),
    ],
    T1
  );
  const rec = d.pages["portal.x/jobs"];
  assert.equal(rec.path, "portal.x/jobs");
  assert.equal(rec.title, "Page");
  assert.equal(rec.count, 2);
  assert.equal(rec.variants.length, 2);
  // Bad entries are ignored rather than throwing.
  mergeEntries(d, [null, { kind: "mystery" }, {}], T1);
  assert.equal(rec.count, 2);
});
