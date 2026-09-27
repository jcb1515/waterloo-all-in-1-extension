// @ts-check
/*
  Cross-source merge engine. Pure functions — no chrome APIs — so the whole
  thing is unit-testable.

  recompute() clusters raw items (one per source read) into canonical items:
  stable ids via links, ranks decide which member supplies each field, and
  change detection produces Update records and item.moved markers.
*/

import { normCourseCode } from "./contract.js";
import { hashString } from "../capture/redact.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MOVED_KEEP_MS = 7 * DAY_MS;

const CLASS_TYPES = new Set(["class", "tutorial", "lab"]);

// Type compatibility groups: two types can describe the same thing only when
// they share at least one group.
const TYPE_GROUPS = [
  ["deadline", "quiz", "lab", "presentation", "task"],
  ["exam", "quiz", "event", "presentation"],
  ["class", "tutorial", "lab"],
  ["meeting", "event", "interview"],
  ["application-deadline", "offer-deadline", "cycle-date", "interview"],
].map((g) => new Set(g));

/** @param {string} a @param {string} b */
export function typesCompatible(a, b) {
  return TYPE_GROUPS.some((g) => g.has(/** @type {any} */ (a)) && g.has(/** @type {any} */ (b)));
}

const METHOD_RANK = { manual: 5, api: 4, invite: 4, html: 3, text: 1 };

/** The merge method for an item: explicit evidence.method, else inferred per source. */
export function methodOf(item) {
  const m = item && item.evidence && item.evidence.method;
  if (m && m in METHOD_RANK) return m;
  const source = item && item.source;
  if (source === "learn" || source === "portal") return "api";
  if (source === "outline") return item && item.review === "pending" ? "text" : "html";
  if (source === "waterlooworks") return "html";
  if (source === "manual") return "manual";
  return "text"; // discord, outlook, gmail and anything unknown
}

/**
 * Merge precedence of a raw member. Higher wins for title, dates and url.
 * For timetable types the outline schedule (10) always beats Portal (2).
 */
export function itemRank(item) {
  let r = (METHOD_RANK[methodOf(item)] || 1) + (item.confidence === "exact" ? 2 : 0);
  if (CLASS_TYPES.has(item.type)) {
    if (item.source === "outline") r = 10;
    else if (item.source === "portal") r = 2;
  }
  return r;
}

/* ------------------------------------------------------------------ */
/* Titles                                                              */
/* ------------------------------------------------------------------ */

const SMALL_NUM = /^\d{1,2}$/;

/**
 * Normalises item-numbered and exam tokens so differently-worded versions of
 * the same thing compare equal: "Assignment 2"/"Asst 2"/"A2" -> "a2",
 * "Midterm exam"/"ME" -> "midterm", "Deliverable 2 part 3" -> "d2p3".
 * @param {string[]} tokens
 */
function normalizeTokens(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if ((t === "assignment" || t === "asst" || t === "assgn" || t === "a") && next && SMALL_NUM.test(next)) {
      out.push(`a${next}`);
      i++;
      continue;
    }
    if (/^a\d+$/.test(t)) {
      out.push(t);
      continue;
    }
    if (t === "quiz" && next && SMALL_NUM.test(next)) {
      out.push(`quiz${next}`);
      i++;
      continue;
    }
    if (/^q\d+$/.test(t)) {
      out.push(`quiz${t.slice(1)}`);
      continue;
    }
    if (t === "lab" && next && SMALL_NUM.test(next)) {
      out.push(`lab${next}`);
      i++;
      continue;
    }
    if (/^lab\d+$/.test(t)) {
      out.push(t);
      continue;
    }
    if (t === "deliverable" && next && SMALL_NUM.test(next) && tokens[i + 2] === "part" && tokens[i + 3] && SMALL_NUM.test(tokens[i + 3])) {
      out.push(`d${next}p${tokens[i + 3]}`);
      i += 3;
      continue;
    }
    if (t === "tutorial" && next && SMALL_NUM.test(next)) {
      out.push(`tut${next}`);
      i++;
      continue;
    }
    if (t === "midterm" && (next === "exam" || next === "test")) {
      out.push("midterm");
      i++;
      continue;
    }
    if (t === "midterm" || t === "me") {
      out.push("midterm");
      continue;
    }
    if (t === "final" && next === "exam") {
      out.push("final");
      i++;
      continue;
    }
    out.push(t);
  }
  // A trailing date phrase ("… due Sunday Sept 20") describes the when, not
  // the what — drop it so outlines and Learn titles still match. Needs at
  // least two date-ish tokens so a bare trailing number ("Workshop 1") stays.
  let drop = 0;
  while (drop < out.length && DATEISH(out[out.length - 1 - drop])) drop++;
  if (drop >= 2) out.length -= drop;
  return out;
}

const MONTH_WORD = /^(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)$/;
const WEEKDAY_WORD = /^(mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday)$/;
const DATEISH = (/** @type {string} */ t) =>
  t === "due" ||
  t === "by" ||
  t === "on" ||
  t === "at" ||
  t === "of" ||
  MONTH_WORD.test(t) ||
  WEEKDAY_WORD.test(t) ||
  /^\d{4}$/.test(t) ||
  /^\d{1,2}(st|nd|rd|th)?$/.test(t);

/**
 * A title's comparison key: lowercase, org code removed, punctuation to
 * spaces, tokens normalised. Exported for tests.
 */
export function titleKey(title, org) {
  let t = String(title || "").toLowerCase();
  if (org) {
    const norm = normCourseCode(org).toLowerCase();
    for (const v of new Set([String(org).toLowerCase(), norm, norm.replace(/\s+/g, "")])) {
      if (v) t = t.split(v).join(" ");
    }
  }
  return normalizeTokens(t.split(/[^a-z0-9]+/).filter(Boolean)).join(" ");
}

/** Jaccard similarity of the two titles' token keys; 1 when the keys are equal. */
export function titleSimilarity(titleA, orgA, titleB, orgB) {
  const ka = titleKey(titleA, orgA);
  const kb = titleKey(titleB, orgB);
  if (ka === kb) return 1;
  const A = new Set(ka.split(" ").filter(Boolean));
  const B = new Set(kb.split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

const anchorOf = (/** @type {any} */ i) => i.dueAt || i.startAt || null;

/** Same local calendar day. */
export function sameLocalDay(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

/**
 * Whether candidate c may join member m's cluster, and how well
 * (sim = title similarity, delta = |anchor difference| in ms).
 * @returns {{sim: number, delta: number} | null}
 */
function memberMatch(c, m) {
  if (!typesCompatible(c.type, m.type)) return null;
  const sim = titleSimilarity(c.title, c.org, m.title, m.org);

  // Org rule: both present -> same course code (or same org, case-insensitive).
  // One missing -> the titles must be near-identical and on the same day.
  const orgA = c.org;
  const orgB = m.org;
  const ca = anchorOf(c);
  const ma = anchorOf(m);
  if (orgA && orgB) {
    if (normCourseCode(orgA).toLowerCase() !== normCourseCode(orgB).toLowerCase()) return null;
  } else if (sim < 0.85 || !ca || !ma || !sameLocalDay(ca, ma)) {
    return null;
  }

  // Timetable entries merge only when they start at the same time.
  if (CLASS_TYPES.has(c.type) && CLASS_TYPES.has(m.type)) {
    if (!c.startAt || !m.startAt) return null;
    const delta = Math.abs(Date.parse(c.startAt) - Date.parse(m.startAt));
    return delta <= 15 * 60 * 1000 ? { sim, delta } : null;
  }

  if (!ca || !ma) return null;
  const delta = Math.abs(Date.parse(ca) - Date.parse(ma));
  if (c.confidence === "exact" && m.confidence === "exact") {
    if (!(sameLocalDay(ca, ma) || delta <= 12 * 60 * 60 * 1000)) return null;
    if (sim < 0.6) return null;
    return { sim, delta };
  }
  // At least one side is tentative.
  if (delta > 7 * DAY_MS || sim < 0.8) return null;
  return { sim, delta };
}

/** Best member score for a candidate against a cluster, or null. */
function clusterScore(c, members) {
  /** @type {{sim:number, delta:number} | null} */
  let best = null;
  for (const m of members) {
    const s = memberMatch(c, m);
    if (!s) continue;
    if (!best || s.sim > best.sim || (s.sim === best.sim && s.delta < best.delta)) best = s;
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Field resolution                                                    */
/* ------------------------------------------------------------------ */

/** Highest-rank member first; ties keep placement order (stable sort). */
function rankedMembers(members) {
  return [...members]
    .map((m, i) => ({ m, i, r: itemRank(m) }))
    .sort((a, b) => b.r - a.r || a.i - b.i)
    .map((x) => x.m);
}

/**
 * Builds the canonical item for a cluster.
 * @param {string} id canonical id
 * @param {any[]} members raw items (already placement order)
 * @param {any} us userState entry for this canonical id
 */
function buildItem(id, members, us) {
  const ranked = rankedMembers(members);
  const top = ranked[0];
  const item = {
    id,
    source: top.source,
    type: top.type,
    title: top.title,
    status: "open",
    confidence: top.confidence === "exact" ? "exact" : "tentative",
    review: "pending",
    seenIn: /** @type {any[]} */ ([]),
    meta: { ...(top.meta || {}), dateFrom: top.source },
  };
  if (top.category != null) item.category = top.category;
  if (top.org != null) item.org = top.org;
  if (top.url != null) item.url = top.url;
  for (const f of ["dueAt", "startAt", "endAt", "allDay", "opensAt"]) {
    if (top[f] != null) item[f] = top[f];
  }
  // Location: highest-rank member that has one, except exams where a Portal
  // member's location (the exam seating room) wins.
  const withLoc = item.type === "exam" ? ranked.find((m) => m.source === "portal" && m.location) : null;
  const loc = (withLoc || ranked.find((m) => m.location != null)) || null;
  if (loc) item.location = loc.location;
  if (top.section != null) item.section = top.section;
  if (top.group != null) item.group = top.group;
  // Weight: outline first (it knows grading), then learn, then anyone.
  const w = ranked.find((m) => m.source === "outline" && m.weight != null) || ranked.find((m) => m.source === "learn" && m.weight != null) || ranked.find((m) => m.weight != null);
  if (w) item.weight = w.weight;
  const details = [...new Set(members.map((m) => m.details).filter(Boolean))];
  if (details.length) item.details = details.join("\n\n");
  /** @type {any[]} */
  const seen = [];
  for (const m of members) for (const s of m.seenIn || []) seen.push(s);
  if (seen.length) item.seenIn = seen;
  if (top.evidence) item.evidence = top.evidence;
  if (us && us.done) item.status = "done";
  else if (members.some((m) => m.status === "submitted")) item.status = "submitted";
  else if (members.every((m) => m.status === "cancelled")) item.status = "cancelled";
  if (us && us.review) item.review = us.review;
  else if (members.some((m) => m.review === "auto")) item.review = "auto";
  return item;
}

/* ------------------------------------------------------------------ */
/* recompute                                                           */
/* ------------------------------------------------------------------ */

/**
 * Rebuilds the merged item view from every source's raw record.
 * @param {object} p
 * @param {Record<string, {items?: any[]}>} p.raws raw record per source
 * @param {Record<string, any>} [p.prevItems] canonical items from the last run
 * @param {Record<string, string>} [p.links] rawId -> canonicalId
 * @param {Record<string, {uid:string, seq:number, hash:string}>} [p.uidMap]
 * @param {Record<string, any>} [p.userState]
 * @param {Date|string} p.now
 * @returns {{items: Record<string, any>, links: Record<string, string>,
 *   uidMap: Record<string, any>, updates: any[]}}
 */
export function recompute({ raws = {}, prevItems = {}, links = {}, uidMap = {}, userState = {}, now }) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowIso = nowDate.toISOString();

  /** @type {any[]} */
  const rawItems = [];
  for (const rec of Object.values(raws)) {
    for (const it of (rec && rec.items) || []) if (it && it.id) rawItems.push(it);
  }
  /** @type {Map<string, any[]>} */
  const clusters = new Map();
  /** @type {Record<string, string>} */
  const outLinks = {};
  const placed = new Set();

  // 1. Items with an existing link keep their cluster (and its canonical id).
  for (const it of rawItems) {
    const canon = links[it.id];
    if (!canon) continue;
    let members = clusters.get(canon);
    if (!members) clusters.set(canon, (members = []));
    members.push(it);
    outLinks[it.id] = canon;
    placed.add(it.id);
  }

  // 2. New raw items join their best cluster or start one, highest rank first.
  const rest = rawItems
    .filter((i) => !placed.has(i.id))
    .sort((a, b) => itemRank(b) - itemRank(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const it of rest) {
    /** @type {string|null} */
    let bestId = null;
    /** @type {{sim:number, delta:number}|null} */
    let bestScore = null;
    for (const [cid, members] of clusters) {
      if (members.some((m) => m.source === it.source)) continue;
      const s = clusterScore(it, members);
      if (!s) continue;
      if (!bestScore || s.sim > bestScore.sim || (s.sim === bestScore.sim && s.delta < bestScore.delta)) {
        bestId = cid;
        bestScore = s;
      }
    }
    if (bestId) {
      const members = clusters.get(bestId);
      if (members) members.push(it);
      outLinks[it.id] = bestId;
    } else {
      clusters.set(it.id, [it]);
      outLinks[it.id] = it.id;
    }
  }

  // Sources seen before this run; a canonical formed only by brand-new sources
  // is a bulk import and must not fire "new" updates.
  const seenSources = new Set();
  for (const p of Object.values(prevItems)) for (const s of p.seenIn || []) seenSources.add(s.source);

  /** @type {Record<string, any>} */
  const items = {};
  /** @type {Record<string, any>} */
  const outUid = {};
  /** @type {any[]} */
  const updates = [];

  for (const [cid, members] of clusters) {
    const item = buildItem(cid, members, userState[cid]);
    const prev = prevItems[cid];
    const anchor = anchorOf(item);
    const prevAnchor = prev ? anchorOf(prev) : null;
    const sameProvider = prev && prev.meta && prev.meta.dateFrom === item.meta.dateFrom;

    if (!prev) {
      if (members.some((m) => seenSources.has(m.source))) {
        updates.push(update("new", item, nowIso, `New: ${item.title}`));
      }
    } else if (prevAnchor !== anchor && prevAnchor && anchor) {
      if (sameProvider) {
        item.moved = { from: prevAnchor, at: nowIso };
        updates.push(update("moved", item, nowIso, `Moved: ${item.title}`));
      } else if (prev.confidence === "tentative" && item.confidence === "exact") {
        // A stronger source confirmed the date — not a move.
        updates.push(update("new", item, nowIso, `Confirmed date for ${item.title}`));
      }
    } else if (prev && prev.moved && prevAnchor === anchor && nowDate.getTime() - Date.parse(prev.moved.at) < MOVED_KEEP_MS) {
      item.moved = prev.moved;
    }

    // Calendar identity: one uid per canonical id, seq bumps on any field change.
    const hash = hashString(
      JSON.stringify({
        title: item.title,
        org: item.org,
        type: item.type,
        dueAt: item.dueAt,
        startAt: item.startAt,
        endAt: item.endAt,
        allDay: item.allDay,
        location: item.location,
        status: item.status,
        weight: item.weight,
        confidence: item.confidence,
        url: item.url,
      })
    );
    let cal = uidMap[cid];
    if (!cal) cal = { uid: `${crypto.randomUUID()}@wa1`, seq: 0, hash };
    else if (cal.hash !== hash) cal = { uid: cal.uid, seq: cal.seq + 1, hash };
    else cal = { uid: cal.uid, seq: cal.seq, hash };
    outUid[cid] = cal;
    item.calendar = { uid: cal.uid, seq: cal.seq, hash: cal.hash };

    items[cid] = item;
  }

  // Canonicals that vanished while they were exact are real cancellations.
  for (const [cid, prev] of Object.entries(prevItems)) {
    if (items[cid]) continue;
    if (prev.confidence === "exact") {
      updates.push({
        id: crypto.randomUUID(),
        at: nowIso,
        source: prev.source,
        kind: "cancelled",
        text: `Removed: ${prev.title}`,
        refId: cid,
      });
    }
  }

  return { items, links: outLinks, uidMap: outUid, updates };
}

/**
 * @param {string} kind
 * @param {any} item
 * @param {string} at
 * @param {string} text
 */
function update(kind, item, at, text) {
  return { id: crypto.randomUUID(), at, source: item.source, kind, text, refId: item.id };
}

/* ------------------------------------------------------------------ */
/* applyResult — fold a SyncResult into a source's raw record          */
/* ------------------------------------------------------------------ */

/**
 * @param {{items?: any[], applications?: any[], courses?: any[], terms?: any[], updatedAt?: string}|null} prevRaw
 * @param {any} result SyncResult
 * @param {{mode: "sync"|"scope", scope?: string}} opts
 */
export function applyResult(prevRaw, result, opts = { mode: "sync" }) {
  const { mode = "sync", scope } = opts || {};
  const prevItems = (prevRaw && Array.isArray(prevRaw.items) && prevRaw.items) || [];
  const newItems = (result && Array.isArray(result.items) && result.items) || [];
  const newIds = new Set(newItems.map((i) => i && i.id));
  // Scope strings differ in formatting between adapters ("ECE150" vs
  // "ECE 150") — compare normalised so readOk scope lists always match.
  const scopeKey = (s) => normCourseCode(s);
  /** @type {any[]} */
  let items;
  if (mode === "scope") {
    // Observed/captured: replace only the items reported under this scope.
    const want = scopeKey(scope);
    items = [
      ...prevItems.filter((p) => !newIds.has(p.id) && !(p.seenIn || []).some((s) => scopeKey(s.scope) === want)),
      ...newItems,
    ];
  } else if (result && result.complete) {
    items = [...newItems];
  } else if (result && Array.isArray(result.readOk)) {
    // Incomplete read that tells us which scopes did succeed: keep items whose
    // reported scopes all failed (i.e. every seenIn scope is absent from readOk).
    const ok = new Set(result.readOk.map(scopeKey));
    items = [
      ...prevItems.filter((p) => !newIds.has(p.id) && (p.seenIn || []).some((s) => s.scope && !ok.has(scopeKey(s.scope)))),
      ...newItems,
    ];
  } else {
    items = [...prevItems.filter((p) => !newIds.has(p.id)), ...newItems];
  }
  const out = { ...(prevRaw || {}), items, updatedAt: new Date().toISOString() };
  if (result && result.applications) out.applications = result.applications;
  if (result && result.courses) out.courses = result.courses;
  if (result && result.terms) out.terms = result.terms;
  return out;
}

/* ------------------------------------------------------------------ */
/* Applications, courses, terms                                        */
/* ------------------------------------------------------------------ */

/**
 * The stored applications map is the union of every source's raw list by id;
 * the most recently read raw wins. The owning adapter diffs statuses itself
 * and reports updates via SyncResult.updates.
 * @param {Record<string, {applications?: any[], updatedAt?: string}>} raws
 * @returns {Record<string, any>}
 */
export function mergeApplications(raws = {}) {
  /** @type {Record<string, any>} */
  const out = {};
  const recs = Object.values(raws).sort(
    (a, b) => Date.parse((a && a.updatedAt) || "") - Date.parse((b && b.updatedAt) || "")
  );
  for (const rec of recs) {
    for (const app of (rec && rec.applications) || []) {
      if (app && app.id) out[app.id] = app;
    }
  }
  return out;
}

/**
 * Feed updates a SyncResult produced itself: `updates` first, with the older
 * `state.lastUpdates` convention as fallback.
 * @param {any} result SyncResult
 * @returns {any[]}
 */
export function resultUpdates(result) {
  if (!result) return [];
  if (Array.isArray(result.updates)) return result.updates;
  if (result.state && Array.isArray(result.state.lastUpdates)) return result.state.lastUpdates;
  return [];
}

const MAX_UPDATES_CAP = 300;

/**
 * Folds newly-produced updates into the newest-first feed: any update whose
 * id is already stored (or already in `incoming`) is dropped — adapter update
 * ids are deterministic, so replayed state must not duplicate.
 * @param {any[]} existing stored feed, newest first
 * @param {any[]} incoming new updates (also newest first)
 * @param {number} cap
 * @returns {any[]}
 */
export function mergeUpdates(existing = [], incoming = [], cap = MAX_UPDATES_CAP) {
  const seen = new Set();
  const out = [];
  const storedIds = new Set();
  for (const u of existing || []) if (u && u.id != null) storedIds.add(u.id);
  for (const u of incoming || []) {
    if (!u || u.id == null || seen.has(u.id) || storedIds.has(u.id)) continue;
    seen.add(u.id);
    out.push(u);
  }
  for (const u of existing || []) {
    if (u && u.id != null && seen.has(u.id)) continue;
    if (u && u.id != null) seen.add(u.id);
    out.push(u);
  }
  return out.slice(0, cap);
}

/**
 * Course fields whose newest read replaces the stored value wholesale
 * (arrays of objects — unioning them would duplicate components).
 */
const COURSE_REPLACE_KEYS = new Set(["grades", "syllabusUrls", "assessments", "gradingSchemes"]);

/** Courses merge by code across raws: first non-empty field wins, arrays union. */
export function mergeCourses(raws = {}) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const rec of Object.values(raws)) {
    for (const c of (rec && rec.courses) || []) {
      if (!c || !c.code) continue;
      const cur = out[c.code];
      if (!cur) {
        out[c.code] = { ...c };
        continue;
      }
      for (const [k, v] of Object.entries(c)) {
        if (v === undefined || v === null || v === "") continue;
        if (Array.isArray(v) && v.length === 0) continue;
        if (COURSE_REPLACE_KEYS.has(k)) {
          cur[k] = v;
        } else if (Array.isArray(v)) {
          cur[k] = [...new Set([...(Array.isArray(cur[k]) ? cur[k] : []), ...v])];
        } else if (cur[k] === undefined || cur[k] === null || cur[k] === "") {
          cur[k] = v;
        }
      }
    }
  }
  return out;
}

/** Terms merge by termCode across raws; Portal's fields win. */
export function mergeTerms(raws = {}) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [source, rec] of Object.entries(raws)) {
    for (const t of (rec && rec.terms) || []) {
      if (!t || t.termCode == null) continue;
      const cur = out[t.termCode] || (out[t.termCode] = { termCode: t.termCode });
      for (const [k, v] of Object.entries(t)) {
        if (k === "termCode" || v === undefined || v === null || v === "") continue;
        if (source === "portal" || cur[k] === undefined || cur[k] === null || cur[k] === "") cur[k] = v;
      }
    }
  }
  return out;
}
