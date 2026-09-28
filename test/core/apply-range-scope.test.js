// @ts-check
// Range-scope replacement in applyResult's scope mode: a date-range read
// ("portal:events:YYYY-MM-DD..YYYY-MM-DD") replaces every stored item seen
// under a same-prefix range scope when the stored scope uses the legacy
// bound format, or when the item's anchor falls inside the new window.
import test from "node:test";
import assert from "node:assert/strict";
import { applyResult } from "../../extension/src/core/merge.js";

const AT = "2026-09-28T16:00:00.000Z";
const TODAY_SCOPE = "portal:events:2026-09-21..2027-01-26";
const LEGACY_SCOPE =
  "portal:events:2026-08-01T04:00:00.000Z..2026-11-01T03:59:59.999Z";

/** @param {string} id @param {string} scope @param {any} [over] */
function portalRaw(id, scope, over = {}) {
  return {
    id,
    source: "portal",
    type: "event",
    title: id,
    confidence: "exact",
    seenIn: [{ source: "portal", key: id, scope, at: AT }],
    ...over,
  };
}
const apply = (prevItems, scope = TODAY_SCOPE, newItems = []) =>
  applyResult({ items: prevItems }, { items: newItems }, { mode: "scope", scope });
const ids = (out) => out.items.map((/** @type {any} */ i) => i.id);

test("legacy ISO-format range scope is removed even when its anchor is outside the new window", () => {
  const zombie = portalRaw("portal:event:learn:2026-09-14", LEGACY_SCOPE, {
    startAt: "2026-09-14T12:30:00.000Z", // Sep 14 Toronto — before the window
  });
  const out = apply([zombie]);
  assert.deepEqual(ids(out), []);
});

test("same-format raw anchored before the window is kept", () => {
  const past = portalRaw(
    "portal:event:importantDate:aa11bb22:2026-08-25",
    "portal:events:2026-08-01..2026-12-01", // an earlier same-format window
    { startAt: "2026-08-25T16:00:00.000Z" },
  );
  const out = apply([past]);
  assert.deepEqual(ids(out), ["portal:event:importantDate:aa11bb22:2026-08-25"]);
});

test("same-format raw inside the window that the read no longer emits is removed", () => {
  const stale = portalRaw("portal:learn:deadbeef:2026-10-05", TODAY_SCOPE, {
    dueAt: "2026-10-05T16:00:00.000Z", // Oct 5 — inside the window
  });
  const out = apply([stale]);
  assert.deepEqual(ids(out), []);
});

test("different-prefix and non-range scopes are untouched", () => {
  const learn = portalRaw("x1", "learn:events:2026-09-21..2027-01-26", {
    dueAt: "2026-10-05T16:00:00.000Z",
  });
  const sched = portalRaw("x2", "portal:schedule", {
    dueAt: "2026-10-05T16:00:00.000Z",
  });
  const other = portalRaw("x3", "portal:events", {
    dueAt: "2026-10-05T16:00:00.000Z",
  }); // same prefix string but not a range
  const out = apply([learn, sched, other]);
  assert.deepEqual(ids(out), ["x1", "x2", "x3"]);
});

test("non-range incoming scope behaves exactly as before", () => {
  const a = portalRaw("a", "feed");
  const b = portalRaw("b", "other");
  const out = apply([a, b], "feed");
  assert.deepEqual(ids(out), ["b"]);
});

test("live shape: colliding old-shape raws go, new-shape raws survive the read", () => {
  const zombies = ["WHMIS Completion", "Tutorial 2", "Résumé Review"].map((t) =>
    portalRaw("portal:event:learn:2026-09-14", LEGACY_SCOPE, {
      title: t,
      startAt: "2026-09-14T12:30:00.000Z",
    }),
  );
  const fresh = portalRaw("portal:learn:6b5ff13f:2026-09-23", TODAY_SCOPE, {
    type: "deadline",
    dueAt: "2026-09-23T16:30:00.000Z",
  });
  const emitted = portalRaw("portal:learn:aa00bb11:2026-10-05", TODAY_SCOPE, {
    type: "deadline",
    dueAt: "2026-10-05T16:00:00.000Z",
  });
  const out = apply([...zombies, fresh], TODAY_SCOPE, [emitted]);
  assert.deepEqual(ids(out), ["portal:learn:aa00bb11:2026-10-05"]);
});
