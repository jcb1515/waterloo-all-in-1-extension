// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import {
  recompute,
  applyResult,
  mergeApplications,
  mergeUpdates,
  mergeCourses,
  mergeTerms,
  itemRank,
  titleKey,
} from "../../extension/src/core/merge.js";

const NOW = new Date("2025-09-15T16:00:00.000Z"); // a Monday noon EDT
const nowIso = NOW.toISOString();

let seq = 0;
/** Build a raw item the way a source's raw record stores it. */
function raw(source, key, over = {}) {
  return {
    id: `${source}:${key}`,
    source,
    type: "deadline",
    title: key,
    status: "open",
    confidence: "tentative",
    review: "auto",
    seenIn: [{ source, key, scope: "feed", at: nowIso }],
    ...over,
  };
}

const raws = (...pairs) =>
  Object.fromEntries(pairs.map(([s, items]) => [s, { items, updatedAt: nowIso }]));

/* ------------------------------------------------------------------ */

test("a Learn deadline and a tentative outline assignment merge into one", () => {
  const learn = raw("learn", "dropbox:1", {
    type: "deadline",
    category: "assignment",
    title: "ECE 105 Assignment 1",
    org: "ECE 105",
    dueAt: "2025-09-21T03:59:00.000Z",
    confidence: "exact",
    url: "https://learn.uwaterloo.ca/dropbox/1",
    evidence: { method: "api", url: "https://learn.uwaterloo.ca/api" },
  });
  const outline = raw("outline", "a1", {
    type: "deadline",
    title: "Assignment #1 due Sunday Sept 20",
    org: "ECE 105",
    dueAt: "2025-09-21T00:00:00.000Z",
    confidence: "tentative",
    review: "pending",
    weight: 10,
    evidence: { method: "html" },
  });
  const r = recompute({ raws: raws(["learn", [learn]], ["outline", [outline]]), now: NOW });
  assert.equal(Object.keys(r.items).length, 1);
  const it = r.items["learn:dropbox:1"]; // learn ranked first -> canonical id
  assert.ok(it, "cluster should use the learn raw id");
  assert.equal(it.dueAt, learn.dueAt, "exact Learn date wins");
  assert.equal(it.weight, 10, "outline weight retained");
  assert.equal(it.confidence, "exact");
  assert.equal(it.meta.dateFrom, "learn");
  assert.deepEqual(
    it.seenIn.map((s) => s.source).sort(),
    ["learn", "outline"]
  );
});

test("outline class beats portal class at the same time", () => {
  const start = "2025-09-16T14:30:00.000Z";
  const oc = raw("outline", "lec2", {
    type: "class",
    title: "ECE 105 LEC 002",
    org: "ECE 105",
    startAt: start,
    location: "RCH 101",
    section: "LEC 002",
  });
  const pc = raw("portal", "cls:9", {
    type: "class",
    title: "ECE 105 lecture",
    org: "ECE 105",
    startAt: start,
    location: "E7 1234",
    confidence: "exact",
    evidence: { method: "api" },
  });
  // Portal is an api source, but for class types outline always outranks it.
  assert.ok(itemRank(oc) > itemRank(pc));
  const r = recompute({ raws: raws(["portal", [pc]], ["outline", [oc]]), now: NOW });
  assert.equal(Object.keys(r.items).length, 1);
  const it = Object.values(r.items)[0];
  assert.equal(it.title, "ECE 105 LEC 002");
  assert.equal(it.location, "RCH 101");
  assert.equal(it.meta.dateFrom, "outline");
});

test("'Quiz 3' and 'Quiz 4' a week apart do not merge", () => {
  const q3 = raw("outline", "q3", { type: "quiz", title: "Quiz 3", org: "ECE 105", dueAt: "2025-09-22T15:00:00.000Z" });
  const q4 = raw("portal", "q4", { type: "quiz", title: "Quiz 4", org: "ECE 105", dueAt: "2025-09-29T15:00:00.000Z" });
  const r = recompute({ raws: raws(["outline", [q3]], ["portal", [q4]]), now: NOW });
  assert.equal(Object.keys(r.items).length, 2);
});

test("a tentative all-day outline window swallows an exact hit inside it", () => {
  // MATH 117 outline: "Final exam Dec 10-24" (a window, not a date).
  const win = raw("outline", "math117-final", {
    type: "exam",
    title: "MATH 117 Final Exam",
    org: "MATH 117",
    confidence: "tentative",
    allDay: true,
    startAt: "2025-12-10",
    endAt: "2025-12-25",
  });
  const exact = raw("portal", "exam:1", {
    type: "exam",
    title: "MATH 117 Final Exam",
    org: "MATH 117",
    confidence: "exact",
    startAt: "2025-12-18T19:00:00.000Z",
    endAt: "2025-12-18T21:30:00.000Z",
    location: "PAC",
  });
  const r = recompute({ raws: raws(["outline", [win]], ["portal", [exact]]), now: NOW });
  assert.equal(Object.keys(r.items).length, 1, "window + exact hit merge");
  const it = Object.values(r.items)[0];
  assert.equal(it.startAt, exact.startAt, "the exact side's date wins");
  assert.equal(it.location, "PAC");
});

test("window containment does not merge anchors outside the window", () => {
  const win = raw("outline", "math117-final", {
    type: "exam",
    title: "MATH 117 Final Exam",
    org: "MATH 117",
    confidence: "tentative",
    allDay: true,
    startAt: "2025-12-10",
    endAt: "2025-12-25",
  });
  const outside = raw("portal", "exam:2", {
    type: "exam",
    title: "MATH 117 Final Exam",
    org: "MATH 117",
    confidence: "exact",
    startAt: "2026-01-06T19:00:00.000Z",
  });
  const r = recompute({ raws: raws(["outline", [win]], ["portal", [outside]]), now: NOW });
  assert.equal(Object.keys(r.items).length, 2);
});

test("window containment still requires the same org", () => {
  const win = raw("outline", "math117-final", {
    type: "exam",
    title: "MATH 117 Final Exam",
    org: "MATH 117",
    confidence: "tentative",
    allDay: true,
    startAt: "2025-12-10",
    endAt: "2025-12-25",
  });
  const otherOrg = raw("portal", "exam:3", {
    type: "exam",
    title: "ECE 105 Final Exam",
    org: "ECE 105",
    confidence: "exact",
    startAt: "2025-12-18T19:00:00.000Z",
  });
  const r = recompute({ raws: raws(["outline", [win]], ["portal", [otherOrg]]), now: NOW });
  assert.equal(Object.keys(r.items).length, 2);
});

test("a midterm title does not merge with a final-exam window", () => {
  const win = raw("outline", "math117-final", {
    type: "exam",
    title: "MATH 117 Final Exam",
    org: "MATH 117",
    confidence: "tentative",
    allDay: true,
    startAt: "2025-12-10",
    endAt: "2025-12-25",
  });
  const midterm = raw("portal", "exam:4", {
    type: "exam",
    title: "MATH 117 Midterm",
    org: "MATH 117",
    confidence: "exact",
    startAt: "2025-12-18T19:00:00.000Z",
  });
  const r = recompute({ raws: raws(["outline", [win]], ["portal", [midterm]]), now: NOW });
  assert.equal(Object.keys(r.items).length, 2);
});

test("same-source duplicates never merge", () => {
  const a = raw("learn", "a", { title: "Assignment 1", org: "ECE 105", dueAt: "2025-09-21T03:59:00.000Z", confidence: "exact" });
  const b = raw("learn", "b", { title: "Asst 1", org: "ECE 105", dueAt: "2025-09-21T03:59:00.000Z", confidence: "exact" });
  const r = recompute({ raws: raws(["learn", [a, b]]), now: NOW });
  assert.equal(Object.keys(r.items).length, 2);
});

test("links keep canonical ids stable when raw order changes", () => {
  const a = raw("learn", "a", { title: "Assignment 1", org: "ECE 105", dueAt: "2025-09-21T03:59:00.000Z", confidence: "exact" });
  const b = raw("learn", "b", { title: "Assignment 2", org: "ECE 105", dueAt: "2025-09-25T03:59:00.000Z", confidence: "exact" });
  const o = raw("outline", "o1", { title: "Assignment #1", org: "ECE 105", dueAt: "2025-09-20T23:00:00.000Z", weight: 10 });

  const r1 = recompute({ raws: raws(["learn", [a, b]], ["outline", [o]]), now: NOW });
  assert.equal(r1.links["outline:o1"], "learn:a");
  assert.equal(r1.links["learn:b"], "learn:b");

  // Same raws, different order, links from the previous run.
  const r2 = recompute({
    raws: raws(["outline", [o]], ["learn", [b, a]]),
    links: r1.links,
    prevItems: r1.items,
    uidMap: r1.uidMap,
    now: NOW,
  });
  assert.deepEqual(r2.links, r1.links);
  assert.equal(r2.items["learn:a"].title, r1.items["learn:a"].title);
});

test("calendar uid is stable; seq bumps only when the hash changes", () => {
  const a = raw("learn", "a", { title: "Assignment 1", org: "ECE 105", dueAt: "2025-09-21T03:59:00.000Z", confidence: "exact" });
  const r1 = recompute({ raws: raws(["learn", [a]]), now: NOW });
  const cal1 = r1.items["learn:a"].calendar;
  assert.match(cal1.uid, /@wa1$/);
  assert.equal(cal1.seq, 0);

  const r2 = recompute({ raws: raws(["learn", [a]]), prevItems: r1.items, links: r1.links, uidMap: r1.uidMap, now: NOW });
  assert.equal(r2.items["learn:a"].calendar.uid, cal1.uid);
  assert.equal(r2.items["learn:a"].calendar.seq, 0, "unchanged fields keep seq");

  const moved = { ...a, dueAt: "2025-09-22T03:59:00.000Z" };
  const r3 = recompute({ raws: raws(["learn", [moved]]), prevItems: r2.items, links: r2.links, uidMap: r2.uidMap, now: NOW });
  assert.equal(r3.items["learn:a"].calendar.uid, cal1.uid);
  assert.equal(r3.items["learn:a"].calendar.seq, 1, "date change bumps seq");
});

test("same date provider changing the date sets moved + a 'moved' update", () => {
  const a = raw("learn", "a", { title: "Assignment 1", org: "ECE 105", dueAt: "2025-09-21T03:59:00.000Z", confidence: "exact" });
  const r1 = recompute({ raws: raws(["learn", [a]]), now: NOW });
  const moved = { ...a, dueAt: "2025-09-23T03:59:00.000Z" };
  const r2 = recompute({ raws: raws(["learn", [moved]]), prevItems: r1.items, links: r1.links, uidMap: r1.uidMap, now: NOW });
  const it = r2.items["learn:a"];
  assert.deepEqual(it.moved, { from: a.dueAt, at: NOW.toISOString() });
  assert.ok(r2.updates.some((u) => u.kind === "moved" && u.refId === "learn:a"));
});

test("a stronger source confirming a tentative date is not a move", () => {
  const o = raw("outline", "o1", { title: "Assignment 1", org: "ECE 105", dueAt: "2025-09-20T20:00:00.000Z" });
  const r1 = recompute({ raws: raws(["outline", [o]]), now: NOW });
  const a = raw("learn", "a", { title: "ECE 105 Assignment 1", org: "ECE 105", dueAt: "2025-09-21T03:59:00.000Z", confidence: "exact" });
  const r2 = recompute({
    raws: raws(["outline", [o]], ["learn", [a]]),
    prevItems: r1.items,
    links: r1.links,
    uidMap: r1.uidMap,
    now: NOW,
  });
  // outline's canonical id survives; learn joined it.
  const it = r2.items["outline:o1"];
  assert.ok(it);
  assert.equal(it.dueAt, a.dueAt);
  assert.equal(it.moved, undefined, "provider change is not a move");
  const upd = r2.updates.find((u) => u.refId === "outline:o1");
  assert.equal(upd && upd.kind, "new");
  assert.match(upd && upd.text, /Confirmed date/);
});

test("first import is silent; later new items produce a 'new' update", () => {
  const a = raw("learn", "a", { title: "Assignment 1", dueAt: "2025-09-21T03:59:00.000Z" });
  const r1 = recompute({ raws: raws(["learn", [a]]), now: NOW });
  assert.equal(r1.updates.length, 0, "bulk import creates no updates");
  const b = raw("learn", "b", { title: "Assignment 2", dueAt: "2025-09-28T03:59:00.000Z" });
  const r2 = recompute({ raws: raws(["learn", [a, b]]), prevItems: r1.items, links: r1.links, uidMap: r1.uidMap, now: NOW });
  assert.ok(r2.updates.some((u) => u.kind === "new" && u.refId === "learn:b"));
});

test("a vanished exact item produces a 'cancelled' update", () => {
  const a = raw("learn", "a", { title: "Assignment 1", dueAt: "2025-09-21T03:59:00.000Z", confidence: "exact" });
  const r1 = recompute({ raws: raws(["learn", [a]]), now: NOW });
  const r2 = recompute({ raws: raws(["learn", []]), prevItems: r1.items, links: r1.links, uidMap: r1.uidMap, now: NOW });
  assert.equal(r2.items["learn:a"], undefined);
  assert.equal(r2.links["learn:a"], undefined, "dead links are dropped");
  assert.ok(r2.updates.some((u) => u.kind === "cancelled" && u.refId === "learn:a"));
});

test("userState.review overrides; members' review otherwise decides", () => {
  const t = raw("discord", "m1", { title: "Study group", type: "event", startAt: "2025-09-16T22:00:00.000Z", review: "pending" });
  const r1 = recompute({ raws: raws(["discord", [t]]), now: NOW });
  assert.equal(r1.items["discord:m1"].review, "pending");
  const r2 = recompute({
    raws: raws(["discord", [t]]),
    userState: { "discord:m1": { review: "accepted" } },
    now: NOW,
  });
  assert.equal(r2.items["discord:m1"].review, "accepted");
});

test("status precedence: done > submitted > cancelled > open", () => {
  const submitted = raw("learn", "a", { title: "Assignment 1", status: "submitted", dueAt: "2025-09-21T03:59:00.000Z" });
  const open = raw("outline", "o", { title: "Assignment 1", dueAt: "2025-09-21T00:00:00.000Z" });
  let r = recompute({ raws: raws(["learn", [submitted]], ["outline", [open]]), now: NOW });
  assert.equal(Object.values(r.items)[0].status, "submitted", "any submitted wins over open");

  r = recompute({
    raws: raws(["learn", [submitted]], ["outline", [open]]),
    userState: { "learn:a": { done: true } },
    now: NOW,
  });
  assert.equal(r.items["learn:a"].status, "done", "user done beats submitted");

  const c1 = raw("learn", "c", { title: "Seminar", type: "event", status: "cancelled", startAt: "2025-09-18T15:00:00.000Z", confidence: "exact" });
  const c2 = raw("portal", "c", { title: "Seminar", type: "event", status: "cancelled", startAt: "2025-09-18T15:30:00.000Z", confidence: "exact" });
  r = recompute({ raws: raws(["learn", [c1]], ["portal", [c2]]), now: NOW });
  assert.equal(Object.values(r.items)[0].status, "cancelled", "all cancelled -> cancelled");
});

/* ------------------------- titleKey / methods ------------------------- */

test("titleKey normalises numbered items and exams", () => {
  assert.equal(titleKey("ECE 105 Assignment 2", "ECE 105"), titleKey("Asst 2", "ECE 105"));
  assert.equal(titleKey("Assignment #1 due Sunday Sept 20"), "a1");
  assert.equal(titleKey("Assignment #4"), titleKey("a4"));
  assert.equal(titleKey("Quiz #3"), titleKey("q3"));
  assert.equal(titleKey("Midterm Exam"), "midterm");
  assert.equal(titleKey("Final exam"), "final");
  assert.equal(titleKey("Deliverable 2 part 3"), "d2p3");
  assert.equal(titleKey("Tutorial 5"), "tut5");
});

/* ------------------------------ applyResult ------------------------------ */

test("applyResult sync: complete replaces; incomplete keeps missing ids", () => {
  const p1 = raw("learn", "1");
  const p2 = raw("learn", "2");
  const n1 = raw("learn", "3");
  const prev = { items: [p1, p2], updatedAt: "x" };

  const rep = applyResult(prev, { items: [n1], complete: true }, { mode: "sync" });
  assert.deepEqual(rep.items.map((i) => i.id), ["learn:3"]);

  const inc = applyResult(prev, { items: [n1], complete: false }, { mode: "sync" });
  assert.deepEqual(inc.items.map((i) => i.id), ["learn:1", "learn:2", "learn:3"]);
});

test("applyResult sync: readOk keeps only items from unread scopes", () => {
  const feed = raw("learn", "f", { seenIn: [{ source: "learn", key: "f", scope: "feed", at: nowIso }] });
  const labs = raw("learn", "l", { seenIn: [{ source: "learn", key: "l", scope: "labs", at: nowIso }] });
  const n = raw("learn", "f2", { seenIn: [{ source: "learn", key: "f2", scope: "feed", at: nowIso }] });
  const out = applyResult({ items: [feed, labs] }, { items: [n], complete: false, readOk: ["feed"] }, { mode: "sync" });
  assert.deepEqual(out.items.map((i) => i.id), ["learn:l", "learn:f2"], "labs wasn't re-read so it stays");
});

test("applyResult scope: replaces only items reported under that scope", () => {
  const feed = raw("ww", "f", { seenIn: [{ source: "ww", key: "f", scope: "feed", at: nowIso }] });
  const inter = raw("ww", "i", { seenIn: [{ source: "ww", key: "i", scope: "interviews", at: nowIso }] });
  const n = raw("ww", "i2", { seenIn: [{ source: "ww", key: "i2", scope: "interviews", at: nowIso }] });
  const out = applyResult({ items: [feed, inter] }, { items: [n] }, { mode: "scope", scope: "interviews" });
  assert.deepEqual(out.items.map((i) => i.id), ["ww:f", "ww:i2"]);
});

test("applyResult replaces applications/courses/terms when present", () => {
  const out = applyResult(
    { items: [], applications: [{ id: "a1" }], courses: [{ code: "OLD 1" }] },
    { items: [], applications: [{ id: "a2" }], terms: [{ termCode: 1269 }] },
    { mode: "sync" }
  );
  assert.deepEqual(out.applications.map((a) => a.id), ["a2"]);
  assert.deepEqual(out.courses.map((c) => c.code), ["OLD 1"], "absent means keep");
  assert.deepEqual(out.terms.map((t) => t.termCode), [1269]);
});

/* ------------------------- applications / updates ------------------------- */

test("mergeApplications unions raws by id; the most recently read raw wins", () => {
  const older = { applications: [{ id: "waterlooworks:j1", status: "applied" }], updatedAt: "2026-09-20T00:00:00Z" };
  const newer = { applications: [{ id: "waterlooworks:j1", status: "interview-scheduled" }], updatedAt: "2026-09-25T00:00:00Z" };
  const out = mergeApplications({ waterlooworks: older, other: { applications: [{ id: "manual:m1", status: "open" }] } });
  assert.deepEqual(Object.keys(out).sort(), ["manual:m1", "waterlooworks:j1"]);
  const out2 = mergeApplications({ waterlooworks: newer, stale: older });
  assert.equal(out2["waterlooworks:j1"].status, "interview-scheduled");
});

test("mergeUpdates dedupes by id and stays newest-first", () => {
  const existing = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const incoming = [{ id: "x" }, { id: "b" }, { id: "x" }];
  const out = mergeUpdates(existing, incoming, 10);
  assert.deepEqual(out.map((u) => u.id), ["x", "a", "b", "c"]);
  assert.equal(mergeUpdates(existing, incoming, 2).map((u) => u.id).join(","), "x,a");
});

/* ------------------------- courses / terms ------------------------- */

test("mergeCourses unions fields across sources by code", () => {
  const out = mergeCourses({
    learn: { courses: [{ code: "ECE 105", name: "Physics", learnOrgUnitId: 1 }] },
    outline: { courses: [{ code: "ECE 105", weights: [{ name: "A1", weight: 10 }], sourceUrls: ["https://x"] }] },
  });
  assert.equal(Object.keys(out).length, 1);
  assert.equal(out["ECE 105"].name, "Physics");
  assert.deepEqual(out["ECE 105"].weights, [{ name: "A1", weight: 10 }]);
});

test("mergeTerms prefers portal fields", () => {
  const out = mergeTerms({
    outline: { terms: [{ termCode: 1269, start: "2025-09-02", name: "Fall 2025" }] },
    portal: { terms: [{ termCode: 1269, start: "2025-09-03" }] },
  });
  assert.equal(out[1269].start, "2025-09-03", "portal wins its own fields");
  assert.equal(out[1269].name, "Fall 2025", "portal-empty fields fall through");
});
