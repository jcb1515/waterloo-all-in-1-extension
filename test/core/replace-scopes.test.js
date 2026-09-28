// @ts-check
// applyResult scope mode + result.replaceScopes: a read that replaced a
// whole scope set (e.g. an email backfill re-reading each message's scope)
// drops stored items it didn't re-emit — but only when EVERY scope the
// item was seen under is inside {scope} ∪ replaceScopes.
import test from "node:test";
import assert from "node:assert/strict";
import { applyResult } from "../../extension/src/core/merge.js";

const AT = "2026-09-29T18:00:00.000Z";

/** @param {string} id @param {string[]} scopes @param {any} [over] */
function mailRaw(id, scopes, over = {}) {
  return {
    id,
    source: "gmail",
    type: "event",
    title: id,
    seenIn: scopes.map((scope) => ({ source: "gmail", key: id, scope, at: AT })),
    ...over,
  };
}

const apply = (prevItems, scope, newItems, replaceScopes) =>
  applyResult(
    { items: prevItems },
    { items: newItems, replaceScopes },
    { mode: "scope", scope },
  );
const ids = (out) => out.items.map((/** @type {any} */ i) => i.id).sort();

test("a re-read drops a message's stale item", () => {
  const prev = [
    mailRaw("gmail:thr1:old", ["email:gmail:thr1"]),
    mailRaw("gmail:thr2:gone", ["email:gmail:thr2"]),
    mailRaw("gmail:list:keep", ["email:gmail:list"]),
  ];
  const out = apply(
    prev,
    "email:gmail:backfill",
    [mailRaw("gmail:thr1:new", ["email:gmail:thr1"])],
    ["email:gmail:thr1", "email:gmail:thr2"],
  );
  // thr1's stale copy dropped (its only scope was re-read); thr2's item
  // dropped entirely; the list-scope item — not part of the re-read — stays.
  assert.deepEqual(ids(out), ["gmail:list:keep", "gmail:thr1:new"]);
});

test("an item also seen under an outside scope stays", () => {
  const prev = [
    mailRaw("gmail:both", ["email:gmail:thr1", "email:gmail:list"]),
    mailRaw("gmail:only", ["email:gmail:thr1"]),
  ];
  const out = apply(prev, "email:gmail:backfill", [], ["email:gmail:thr1"]);
  assert.deepEqual(ids(out), ["gmail:both"]);
});

test("no replaceScopes: prior scope-mode behaviour is unchanged", () => {
  const prev = [
    mailRaw("gmail:a", ["email:gmail:list"]),
    mailRaw("gmail:b", ["email:gmail:thr1"]),
  ];
  const out = apply(prev, "email:gmail:list", []);
  // Only the read scope's items are replaced; thr1's item is untouched.
  assert.deepEqual(ids(out), ["gmail:b"]);
});

test("an item with no seenIn is never dropped by replaceScopes", () => {
  const prev = [{ id: "gmail:bare", source: "gmail", type: "event" }];
  const out = apply(prev, "email:gmail:backfill", [], ["email:gmail:thr1"]);
  assert.deepEqual(ids(out), ["gmail:bare"]);
});

test("the sibling provider's items (shared adapter raw) are untouched", () => {
  // gmail and outlook share raw:outlook — a gmail re-read must not drop
  // outlook items, whose scopes are outside {scope} ∪ replaceScopes.
  const prev = [
    {
      id: "outlook:x",
      source: "outlook",
      type: "event",
      seenIn: [{ source: "outlook", key: "x", scope: "email:outlook:thr9", at: AT }],
    },
    mailRaw("gmail:gone", ["email:gmail:thr1"]),
  ];
  const out = apply(prev, "email:gmail:backfill", [], ["email:gmail:thr1"]);
  assert.deepEqual(ids(out), ["outlook:x"]);
});
