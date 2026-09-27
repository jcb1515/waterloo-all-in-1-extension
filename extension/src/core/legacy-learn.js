// @ts-check
/*
  Temporary Learn adapter (Window 1). Wraps WATnow's LiveSource — which reads
  every deadline from the student's signed-in Learn session — so Learn keeps
  feeding the merged store until Window 2's real adapter lands at Checkpoint 1.
  This file is deleted then. Do not edit sources/learn/live-source.js here.
*/

import { itemId } from "./contract.js";
import { LiveSource, termCodeFor } from "../sources/learn/live-source.js";

const LEARN_BASE = "https://learn.uwaterloo.ca";

/**
 * Runs one GET through an open Learn tab's content script
 * (src/sources/learn/content.js answers "live:fetch"). Copied with
 * attribution from WATnow's background.js (watnow @ 801a1b1, MIT, Eric Zou).
 * @param {string} base
 * @param {string} path
 */
async function relayFetch(base, path) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: `${base}/*` });
  } catch {
    return { noTab: true };
  }
  tabs.sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
  for (const tab of tabs) {
    if (tab.discarded || tab.id == null) continue;
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: "live:fetch", path });
      if (res) return res;
    } catch {
      /* no bridge in this tab */
    }
  }
  return { noTab: true };
}

/** WATnow category -> contract ItemType. */
const TYPE_BY_CATEGORY = {
  assignment: "deadline",
  content: "deadline",
  discussion: "deadline",
  lab: "lab",
  quiz: "quiz",
};

/**
 * Maps one WATnow item to a contract Item.
 * @param {any} w WATnow item (see live-source.js listDeadlines)
 * @param {Map<string, any>} courseById WATnow course objects keyed by course.id
 * @param {string} now ISO timestamp
 * @returns {import("./contract.js").Item}
 */
export function toItem(w, courseById, now) {
  const course = courseById.get(w.courseId);
  const seen = Array.isArray(w.seenIn) && w.seenIn.length ? w.seenIn[0] : "feed";
  const item = {
    id: itemId("learn", w.id),
    source: /** @type {const} */ ("learn"),
    type: /** @type {import("./contract.js").ItemType} */ (TYPE_BY_CATEGORY[w.category] || "deadline"),
    title: String(w.title || "Learn item"),
    status: /** @type {import("./contract.js").ItemStatus} */ (w.status === "submitted" ? "submitted" : "open"),
    confidence: /** @type {const} */ ("exact"),
    review: /** @type {const} */ ("auto"),
    seenIn: [{ source: /** @type {const} */ ("learn"), key: String(w.id), scope: String(seen), at: now }],
    evidence: { method: /** @type {const} */ ("api"), url: w.url || undefined },
    meta: { orgUnitId: course ? course.orgUnitId : undefined, kind: w.kind },
  };
  if (w.category) item.category = w.category;
  if (course && course.code) item.org = course.code;
  if (w.dueAt) item.dueAt = w.dueAt;
  if (w.opensAt) item.opensAt = w.opensAt;
  if (w.url) item.url = w.url;
  return item;
}

/**
 * @param {any} ctx SyncContext
 * @returns {Promise<import("./contract.js").SyncResult>}
 */
async function sync(ctx) {
  const settings = { mode: "live", ...(ctx.settings || {}) };
  const source = new LiveSource(settings, { relay: relayFetch, now: ctx.now });
  const session = await source.checkSession();
  if (!session.signedIn) {
    const reason = session.reason || "unreachable";
    return { items: [], complete: false, session: /** @type {any} */ (reason === "signed-in" ? "signed-out" : reason) };
  }

  const all = await source.listCourses();
  const current = all.filter((c) => c.current !== false);
  const extras = all.filter((c) => c.current === false);
  const byId = new Map(all.map((c) => [c.id, c]));
  const wItems = [];
  let failed = false;
  for (const c of current) {
    try {
      wItems.push(...(await source.listDeadlines(c)));
    } catch (e) {
      const err = /** @type {any} */ (e);
      if (err && err.code === "signed-out") throw e;
      failed = true;
      if (ctx.log) ctx.log(`course ${c.code} failed: ${(err && err.code) || (err && err.message) || err}`);
    }
  }
  const keptExtraIds = new Set();
  for (const c of extras) {
    try {
      const kept = source.keepTermless(c, await source.listDeadlines(c));
      if (kept) {
        keptExtraIds.add(c.id);
        wItems.push(...kept);
      }
    } catch (e) {
      const err = /** @type {any} */ (e);
      if (err && err.code === "signed-out") throw e;
      failed = true;
      if (ctx.log) ctx.log(`unit ${c.code} failed: ${(err && err.code) || (err && err.message) || err}`);
    }
  }

  const kept = [...current, ...extras.filter((c) => keptExtraIds.has(c.id))];
  const keptIds = new Set(kept.map((c) => c.id));
  const now = ctx.now.toISOString();
  const term = termCodeFor(ctx.now);
  const courses = kept.map((c) => ({
    code: c.code,
    name: c.name || undefined,
    term,
    learnOrgUnitId: c.orgUnitId,
  }));
  const items = wItems.filter((w) => keptIds.has(w.courseId)).map((w) => toItem(w, byId, now));

  /** @type {import("./contract.js").SyncResult} */
  const result = { items, courses, complete: !failed, session: "signed-in" };
  // LiveSource.readOk is a Map courseId -> Set<scope>; flatten to the scopes
  // that read completely for at least one course.
  if (source.readOk instanceof Map && source.readOk.size) {
    result.readOk = [...new Set([...source.readOk.values()].flatMap((s) => [...s]))];
  }
  return result;
}

/** @type {import("./contract.js").Adapter} */
export default {
  id: "learn",
  label: "Learn",
  origins: [LEARN_BASE],
  intervalMinutes: 30,
  syncOnTabOpen: true,
  sync,
};
