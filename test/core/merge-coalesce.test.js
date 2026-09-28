// @ts-check
// Coalesce pass: raw items pinned to separate canonical ids by stored links
// (a pair split before a matcher fix) must merge back into one canonical.
// The pass is merge-only and reuses clusterScore unchanged — real clashes
// and same-source pairs stay split.

import test from "node:test";
import assert from "node:assert/strict";

import { recompute } from "../../extension/src/core/merge.js";
import { buildFeedPayload } from "../../extension/src/calendar/payload.js";

const NOW = new Date("2026-10-15T16:00:00.000Z");
const nowIso = NOW.toISOString();

/** @param {any} item */
const rec = (item, src) => ({ items: [item], updatedAt: nowIso, _src: src });

const PORTAL_M115 = {
  id: "portal:exam:MATH115:midterm",
  source: "portal",
  type: "exam",
  category: "midterm",
  title: "MATH 115 Midterm exam",
  org: "MATH 115",
  startAt: "2026-10-23T23:00:00.000Z",
  endAt: "2026-10-24T01:00:00.000Z",
  location: "MC 2034",
  status: "open",
  confidence: "exact",
  review: "auto",
  evidence: { method: "api" },
  seenIn: [{ source: "portal", key: "exams", scope: "portal:exams", at: "2026-10-15T11:00:00.000Z" }],
};

const OUTLINE_M115 = {
  id: "outline:m115-midterm",
  source: "outline",
  type: "exam",
  category: "midterm",
  title: "Midterm exam",
  org: "MATH 115",
  startAt: "2026-10-23T23:00:00.000Z",
  endAt: "2026-10-24T01:00:00.000Z",
  status: "open",
  confidence: "exact",
  review: "auto",
  weight: 25,
  evidence: { method: "html" },
  seenIn: [{ source: "outline", key: "math115", scope: "outline:math115", at: "2026-10-14T10:00:00.000Z" }],
};

const SURV = PORTAL_M115.id; // portal's api rank beats outline's html rank
const LOST = OUTLINE_M115.id;

/**
 * The pre-split live state: each raw already owns a canonical, links pin
 * them apart, and uidMap carries one uid per canonical.
 */
function presplit() {
  const soloPortal = recompute({ raws: { portal: rec(PORTAL_M115, "portal") }, now: NOW });
  const soloOutline = recompute({ raws: { outline: rec(OUTLINE_M115, "outline") }, now: NOW });
  return {
    prevItems: { ...soloPortal.items, ...soloOutline.items },
    links: { [PORTAL_M115.id]: PORTAL_M115.id, [OUTLINE_M115.id]: OUTLINE_M115.id },
    uidMap: { ...soloPortal.uidMap, ...soloOutline.uidMap },
    absorbedUid: soloOutline.uidMap[OUTLINE_M115.id].uid,
  };
}

test("live shape: pre-split Portal + outline MATH 115 midterms coalesce", () => {
  const pre = presplit();
  const out = recompute({
    raws: { portal: rec(PORTAL_M115, "portal"), outline: rec(OUTLINE_M115, "outline") },
    prevItems: pre.prevItems,
    links: pre.links,
    uidMap: pre.uidMap,
    now: NOW,
  });

  // Exactly one canonical, both raws linked to the survivor.
  assert.deepEqual(Object.keys(out.items), [SURV]);
  assert.equal(out.links[PORTAL_M115.id], SURV);
  assert.equal(out.links[OUTLINE_M115.id], SURV);
  assert.deepEqual(out.merged, { [LOST]: SURV });

  // No "cancelled"/"new" noise: nothing vanished, nothing is new.
  assert.equal(out.updates.length, 0, JSON.stringify(out.updates));

  // The survivor carries Portal's exact time and room.
  const it = out.items[SURV];
  assert.equal(it.startAt, "2026-10-23T23:00:00.000Z");
  assert.equal(it.endAt, "2026-10-24T01:00:00.000Z");
  assert.equal(it.location, "MC 2034");
  assert.deepEqual(it.seenIn.map((s) => s.source).sort(), ["outline", "portal"]);

  // The feed publishes one event and the absorbed uid is gone.
  const feed = buildFeedPayload(out.items, {}, {}, NOW, { acceptPending: true });
  assert.equal(feed.count, 1);
  assert.equal(feed.collapsed, 0);
  assert.equal(out.uidMap[LOST], undefined);
  assert.equal(out.items[SURV].calendar.uid, pre.uidMap[SURV].uid);
  assert.ok(!JSON.stringify(feed.payload).includes(pre.absorbedUid));
});

test("coalesce is idempotent: a second recompute changes nothing", () => {
  const pre = presplit();
  const raws = { portal: rec(PORTAL_M115, "portal"), outline: rec(OUTLINE_M115, "outline") };
  const out = recompute({ raws, prevItems: pre.prevItems, links: pre.links, uidMap: pre.uidMap, now: NOW });
  const out2 = recompute({ raws, prevItems: out.items, links: out.links, uidMap: out.uidMap, now: new Date(NOW.getTime() + 60000) });
  assert.deepEqual(out2.items, out.items);
  assert.deepEqual(out2.links, out.links);
  assert.deepEqual(out2.uidMap, out.uidMap);
  assert.equal(out2.updates.length, 0);
  assert.deepEqual(out2.merged, {});
});

test("real clash: MATH 117 and ECE 105 at the same time stay split", () => {
  const m117 = {
    ...PORTAL_M115,
    id: "portal:exam:MATH117:midterm",
    title: "MATH 117 Midterm exam",
    org: "MATH 117",
  };
  const ece105 = {
    ...OUTLINE_M115,
    id: "outline:ece105-midterm",
    title: "Midterm exam",
    org: "ECE 105",
  };
  const pre117 = recompute({ raws: { portal: rec(m117, "portal") }, now: NOW });
  const pre105 = recompute({ raws: { outline: rec(ece105, "outline") }, now: NOW });
  const out = recompute({
    raws: { portal: rec(m117, "portal"), outline: rec(ece105, "outline") },
    prevItems: { ...pre117.items, ...pre105.items },
    links: { [m117.id]: m117.id, [ece105.id]: ece105.id },
    now: NOW,
  });
  assert.equal(Object.keys(out.items).length, 2);
  assert.equal(out.links[m117.id], m117.id);
  assert.equal(out.links[ece105.id], ece105.id);
  assert.deepEqual(out.merged, {});
});

test("same source: two portal items never coalesce", () => {
  const a = { ...PORTAL_M115, id: "portal:exam:MATH115:midterm" };
  const b = { ...PORTAL_M115, id: "portal:exam:MATH115:midterm2", title: "MATH 115 Midterm exam" };
  const preA = recompute({ raws: { portal: rec(a, "portal") }, now: NOW });
  const preB = recompute({ raws: { portal: rec(b, "portal") }, now: NOW });
  const out = recompute({
    raws: { portal: { items: [a, b], updatedAt: nowIso } },
    prevItems: { ...preA.items, ...preB.items },
    links: { [a.id]: a.id, [b.id]: b.id },
    now: NOW,
  });
  assert.equal(Object.keys(out.items).length, 2);
  assert.deepEqual(out.merged, {});
});

/* ------------------ userState migration in recomputeAll ------------------ */

test("recomputeAll migrates userState and repoints references", async () => {
  // Minimal chrome.storage stub — the scheduler's store helpers go through it.
  const store = new Map();
  const prevChrome = globalThis.chrome;
  globalThis.chrome = /** @type {any} */ ({
    storage: {
      local: {
        get: async (keys) => {
          if (typeof keys === "string") return { [keys]: store.get(keys) };
          if (Array.isArray(keys)) {
            const out = /** @type {Record<string, any>} */ ({});
            for (const k of keys) out[k] = store.get(k);
            return out;
          }
          return keys || {};
        },
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        },
        remove: async (keys) => {
          for (const k of [].concat(keys)) store.delete(k);
        },
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
    action: { setBadgeText: async () => {} },
    alarms: { create() {}, clear() {}, get: async () => undefined },
  });

  try {
    const { recomputeAll } = await import("../../extension/src/core/scheduler.js");
    const pre = presplit();
    // Seed the live-shaped split store.
    store.set("raw:portal", rec(PORTAL_M115, "portal"));
    store.set("raw:outline", rec(OUTLINE_M115, "outline"));
    store.set("items", pre.prevItems);
    store.set("links", pre.links);
    store.set("uidMap", pre.uidMap);
    // A carried-over offer to-do whose meta still references the absorbed
    // cid (deriveTodos clones prev meta for done rows).
    store.set("todos", {
      "todo:offer:app1": {
        id: "todo:offer:app1",
        title: "Respond to offer — Acme",
        status: "open",
        meta: { auto: "offer", applicationId: "app1", parentId: LOST, linkedItemId: LOST, other: 1 },
      },
    });
    store.set("userState", {
      [LOST]: { notes: "outline note", done: true },
      [SURV]: { notes: "portal note" },
    });
    // An application whose stored itemIds still points at the absorbed cid.
    // Status "ranked" + fresh history keeps its offer to-do alive as done.
    store.set("raw:waterlooworks", {
      items: [],
      applications: [
        {
          id: "app1",
          jobId: "j1",
          employer: "Acme",
          status: "ranked",
          history: [{ at: "2026-10-15T12:00:00.000Z", to: "ranked" }],
          itemIds: [LOST, "other-item"],
        },
      ],
      updatedAt: nowIso,
    });

    await recomputeAll(NOW);

    const after = /** @type {Record<string, any>} */ (store.get("userState"));
    // Survivor keys win; absorbed keys fill gaps; absorbed entry deleted.
    assert.deepEqual(after[SURV], { notes: "portal note", done: true });
    assert.equal(after[LOST], undefined);

    // Stored references point at the survivor now.
    const todos = /** @type {Record<string, any>} */ (store.get("todos"));
    const todo = todos["todo:offer:app1"];
    assert.ok(todo, "offer to-do carried over as done");
    assert.equal(todo.status, "done");
    assert.equal(todo.meta.parentId, SURV);
    assert.equal(todo.meta.linkedItemId, SURV);
    assert.equal(todo.meta.other, 1);
    const apps = /** @type {Record<string, any>} */ (store.get("applications"));
    assert.deepEqual(new Set(apps["app1"].itemIds), new Set([SURV, "other-item"]));

    const items = /** @type {Record<string, any>} */ (store.get("items"));
    assert.deepEqual(Object.keys(items), [SURV]);
    assert.equal(items[SURV].status, "done", "absorbed done state reached the survivor");
    const uidMap = /** @type {Record<string, any>} */ (store.get("uidMap"));
    assert.equal(uidMap[LOST], undefined);
  } finally {
    globalThis.chrome = prevChrome;
  }
});
