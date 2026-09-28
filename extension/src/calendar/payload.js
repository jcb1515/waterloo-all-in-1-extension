// @ts-check
/*
  Builds the v2 publish payload for the calendar feed server (see
  server/README.md). Pure: takes the merged items map, userState, the
  settings.calendar slice and a "now". No storage, no chrome.*, no fetch.

  The server clamps/validates each field and skips bad events; we still keep
  the payload small and honest here.
*/

import { effectiveItem } from "../core/effective.js";
import { typesCompatible, itemRank, titleSimilarity, orgsCompatible } from "../core/merge.js";
import { zonedParts } from "../lib/textdates/index.js";

const DAY = 86400000;
const MAX_EVENTS = 3000;
const MAX_BYTES = 1.8 * 1024 * 1024; // stay under the server's 2 MiB / 413
const PAST_WINDOW = 60 * DAY; // anchors older than 60 days are dropped
const DETAILS_LIMIT = 300;

const CLASS_TYPES = new Set(["class", "tutorial", "lab"]);
/** Task categories that are to-dos (answer/book), not calendar events. */
const TODO_TASK_CATEGORIES = new Set(["reply", "book-call"]);

const MAX_FACTS = 12;
const FACT_LABEL_MAX = 40;
const FACT_VALUE_MAX = 300;

/** Derived "Type" fact — plain Deadline/Class add nothing. */
const TYPE_FACT = {
  quiz: "Quiz",
  presentation: "Presentation",
  tutorial: "Tutorial",
  lab: "Lab",
  meeting: "Meeting",
  interview: "Interview",
  "application-deadline": "Application deadline",
  "offer-deadline": "Offer deadline",
  "cycle-date": "Cycle date",
  task: "Task",
  event: "Event",
  "term-date": "Term date",
};
function typeFact(it) {
  if (it.type === "exam") {
    if (it.category === "midterm") return "Midterm";
    if (it.category === "final") return "Final exam";
    if (it.category === "make-up") return "Make-up exam";
    return "Exam";
  }
  return TYPE_FACT[it.type] || null;
}

/**
 * meta.facts first (the source's own labels win), then generic derived facts —
 * clamped to the server's limits and deduped by label, case-insensitive.
 */
function eventFacts(it) {
  /** @type {{label: string, value: string}[]} */
  const out = [];
  const seen = new Set();
  const push = (label, value) => {
    const l = String(label == null ? "" : label).trim().slice(0, FACT_LABEL_MAX);
    const v = String(value == null ? "" : value).trim().slice(0, FACT_VALUE_MAX);
    if (!l || !v || out.length >= MAX_FACTS) return;
    const key = l.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ label: l, value: v });
  };
  for (const f of (it.meta && it.meta.facts) || []) {
    push(f && f.label, f && f.value);
  }
  const tf = typeFact(it);
  if (tf) push("Type", tf);
  if (it.group != null && it.group !== "") push("Group", it.group);
  return out.length ? out : undefined;
}

const TYPE_ALARMS = {
  deadline: [1440, 60],
  quiz: [1440, 60],
  exam: [2880, 1440],
  interview: [1440, 60],
};

/**
 * @param {any} it merged canonical item
 * @param {any} us userState[it.id] (may be undefined)
 * @param {any} cal settings.calendar
 * @param {number} nowMs
 * @param {Set<string>} [excludedProjects]  project ids kept off the feed
 * @returns {any|null} the event to publish, or null to exclude
 */
function toEvent(it, us, cal, nowMs, excludedProjects) {
  if (!it || !it.id) return null;
  if (it.review === "pending" || it.review === "dismissed") return null;
  if (us && us.hidden) return null;
  if (it.status === "cancelled") return null;
  // Gmail invitations are already on the user's Google Calendar — publishing
  // them again would duplicate the event. The panel still shows them.
  if (it.meta && it.meta.onCalendar) return null;
  // Per-item and per-project calendar opt-outs.
  if (it.meta && it.meta.calendar === false) return null;
  if (it.meta && it.meta.projectId && excludedProjects && excludedProjects.has(it.meta.projectId)) {
    return null;
  }

  const done = it.status === "done" || it.status === "submitted" || !!(us && us.done);
  const inc = (cal && cal.include) || {};
  if (done && inc.completed === false) return null;
  if (CLASS_TYPES.has(it.type) && it.startAt && inc.classes === false) return null;
  if (it.confidence === "tentative" && inc.tentative === false) return null;
  if (it.type === "term-date" && inc.termDates === false) return null;
  // Reply / book-a-call to-dos (email, Discord) are to-dos, not events: they
  // reach the feed only when to-dos are opted in (include.todos, which the
  // publisher sets from settings.todos.includeInCalendar).
  if (it.type === "task" && TODO_TASK_CATEGORIES.has(it.category) && inc.todos !== true) return null;

  const dueMs = it.dueAt ? Date.parse(it.dueAt) : NaN;
  const start0 = it.startAt ? Date.parse(it.startAt) : NaN;
  const anchorMs = Number.isNaN(dueMs) ? start0 : dueMs; // dueAt || startAt
  const endMs = it.endAt ? Date.parse(it.endAt) : NaN;
  const anchor = Math.max(
    Number.isNaN(anchorMs) ? -Infinity : anchorMs,
    Number.isNaN(endMs) ? -Infinity : endMs
  );
  if (anchor === -Infinity) return null; // no dueAt/startAt at all
  if (anchor < nowMs - PAST_WINDOW) return null;

  // Classes publish only inside a rolling window: a week back, classWeeks
  // ahead. This keeps a full course load publishable within the feed
  // server's per-publish CPU budget; uids are stable, so items enter the
  // feed as the window slides.
  if (CLASS_TYPES.has(it.type) && !Number.isNaN(start0)) {
    const w = Number(inc.classWeeks);
    const ahead = (Number.isFinite(w) && w > 0 ? w : 8) * 7 * DAY;
    if (start0 < nowMs - 7 * DAY || start0 > nowMs + ahead) return null;
  }

  const ev = {
    id: String(it.id),
    type: it.type,
    title: String(it.title || ""),
  };
  const put = (k, v) => {
    if (v !== undefined && v !== null && v !== "") ev[k] = v;
  };
  put("org", it.org);
  put("dueAt", it.dueAt);
  put("startAt", it.startAt);
  put("endAt", it.endAt);
  if (it.allDay) ev.allDay = true;
  put("url", it.url);
  ev.status = done ? "done" : it.status || "open";
  put("confidence", it.confidence);
  put("weight", typeof it.weight === "number" ? it.weight : undefined);
  put("section", it.section);
  put("location", it.location);
  put("details", it.details);
  put("source", it.source);
  if (Array.isArray(it.seenIn) && it.seenIn.length) {
    const seen = new Set();
    const list = [];
    for (const s of it.seenIn) {
      const id = s && s.source;
      if (id && !seen.has(id)) {
        seen.add(id);
        list.push({ source: id });
      }
    }
    if (list.length) ev.seenIn = list;
  }
  if (it.calendar && it.calendar.uid) {
    ev.calendar = { uid: it.calendar.uid, seq: it.calendar.seq || 0 };
  }
  const facts = eventFacts(it);
  if (facts) ev.facts = facts;
  return ev;
}

/**
 * @param {Record<string, any>} items  merged canonical items (the stored map)
 * @param {Record<string, any>} userState
 * @param {any} calSettings            settings.calendar
 * @param {Date} [now]
 * @param {{acceptPending?: boolean, projects?: any[]}} [opts]
 *   acceptPending: review.showPending — pending items publish as accepted
 *   instead of being skipped. projects: items whose project has
 *   calendar:false or is archived are excluded, as is any item carrying
 *   meta.calendar === false.
 * @returns {{payload: any, count: number, trimmed: boolean, collapsed: number}}
 */
/**
 * The publish-time duplicate guard — a pair that the merge engine missed is
 * collapsed when all of these hold: compatible types, the same start (timed:
 * within 5 minutes; all-day: the same Toronto date), title similarity ≥ 0.6,
 * and compatible orgs. The higher itemRank wins; ties keep the first.
 * @param {{ev: any, it: any, anchor: number}[]} picked
 * @returns {{kept: {ev: any, it: any, anchor: number}[], collapsed: number}}
 */
function collapseDuplicates(picked) {
  const evAnchor = (/** @type {any} */ ev) => {
    const s = ev.startAt || ev.dueAt;
    const ms = s ? Date.parse(s) : NaN;
    return Number.isNaN(ms) ? null : ms;
  };
  const isDup = (/** @type {any} */ a, /** @type {any} */ b) =>
    typesCompatible(a.type, b.type) &&
    titleSimilarity(a.title, a.org, b.title, b.org) >= 0.6 &&
    orgsCompatible(a.org, b.org);
  const loser = (/** @type {any} */ a, /** @type {any} */ b) =>
    itemRank(b.it) > itemRank(a.it) ? a : b;

  const removed = new Set();
  let collapsed = 0;

  // Timed items: sorted sweep, comparing only entries within 5 minutes.
  const timed = picked
    .filter((p) => !p.ev.allDay)
    .map((p) => ({ p, ms: evAnchor(p.ev) }))
    .filter((p) => p.ms != null)
    .sort((a, b) => /** @type {number} */ (a.ms) - /** @type {number} */ (b.ms));
  for (let i = 0; i < timed.length; i++) {
    const a = timed[i];
    if (removed.has(a.p)) continue;
    for (let j = i + 1; j < timed.length; j++) {
      const b = timed[j];
      if (removed.has(b.p)) continue;
      if (/** @type {number} */ (b.ms) - /** @type {number} */ (a.ms) > 5 * 60 * 1000) break;
      if (isDup(a.p.it, b.p.it)) {
        const drop = loser(a.p, b.p);
        removed.add(drop);
        collapsed++;
        if (drop === a.p) break;
      }
    }
  }

  // All-day items: same Toronto calendar date.
  /** @type {Map<string, any[]>} */
  const byDay = new Map();
  for (const p of picked) {
    if (!p.ev.allDay || removed.has(p)) continue;
    const ms = evAnchor(p.ev);
    if (ms == null) continue;
    const z = zonedParts(new Date(ms), "America/Toronto");
    const key = `${z.y}-${z.m}-${z.d}`;
    const arr = byDay.get(key) || [];
    arr.push(p);
    byDay.set(key, arr);
  }
  for (const arr of byDay.values()) {
    for (let i = 0; i < arr.length; i++) {
      if (removed.has(arr[i])) continue;
      for (let j = i + 1; j < arr.length; j++) {
        if (removed.has(arr[j])) continue;
        if (isDup(arr[i].it, arr[j].it)) {
          removed.add(loser(arr[i], arr[j]));
          collapsed++;
        }
      }
    }
  }

  // Mixed pairs: an all-day event and a timed one on the same Toronto date
  // can still be one thing (an outline's all-day deadline vs the Learn item
  // due at 23:59). The timed member wins — it is more precise.
  for (const p of picked) {
    if (!p.ev.allDay || removed.has(p)) continue;
    const ams = evAnchor(p.ev);
    if (ams == null) continue;
    const az = zonedParts(new Date(ams), "America/Toronto");
    for (const t of timed) {
      if (removed.has(t.p)) continue;
      const tz = zonedParts(new Date(/** @type {number} */ (t.ms)), "America/Toronto");
      if (az.y !== tz.y || az.m !== tz.m || az.d !== tz.d) continue;
      if (isDup(p.it, t.p.it)) {
        removed.add(p);
        collapsed++;
        break;
      }
    }
  }

  return { kept: picked.filter((p) => !removed.has(p)), collapsed };
}

export function buildFeedPayload(items, userState, calSettings, now = new Date(), opts = {}) {
  const nowMs = now.getTime();
  const us = userState || {};
  const cal = calSettings || {};
  const effOpts = { acceptPending: !!opts.acceptPending };

  /** @type {Set<string>} */
  const excludedProjects = new Set();
  for (const p of Array.isArray(opts.projects) ? opts.projects : []) {
    if (p && p.id && (p.calendar === false || p.status === "archived")) {
      excludedProjects.add(p.id);
    }
  }

  /** @type {{ev: any, it: any, anchor: number}[]} */
  const pickedRaw = [];
  for (const it of Object.values(items || {})) {
    const eff = effectiveItem(it, us[it && it.id], effOpts);
    const ev = toEvent(eff, us[it && it.id], cal, nowMs, excludedProjects);
    if (!ev) continue;
    const a = Math.max(
      ev.dueAt ? Date.parse(ev.dueAt) : -Infinity,
      ev.startAt ? Date.parse(ev.startAt) : -Infinity,
      ev.endAt ? Date.parse(ev.endAt) : -Infinity
    );
    pickedRaw.push({ ev, it: eff, anchor: a });
  }

  const { kept: picked, collapsed } = collapseDuplicates(pickedRaw);

  // Nearest to now wins under the cap: upcoming first (soonest first), then
  // the most recent past.
  const upcoming = picked
    .filter((p) => p.anchor >= nowMs)
    .sort((a, b) => a.anchor - b.anchor);
  const past = picked
    .filter((p) => p.anchor < nowMs)
    .sort((a, b) => b.anchor - a.anchor);
  let ordered = [...upcoming, ...past];

  let trimmed = false;
  if (ordered.length > MAX_EVENTS) {
    ordered = ordered.slice(0, MAX_EVENTS);
    trimmed = true;
  }

  const payload = {
    version: 2,
    calendarName: "Waterloo All-in-1",
    timeZone: "America/Toronto",
  };
  if (cal.alarms === true) payload.alarms = { ...TYPE_ALARMS };

  let events = ordered.map((p) => p.ev);
  let json = "";
  const size = () => {
    payload.events = events;
    json = JSON.stringify(payload);
    return json.length;
  };

  if (size() > MAX_BYTES) {
    // First shrink details; if still over, drop the farthest events.
    events = events.map((ev) =>
      typeof ev.details === "string" && ev.details.length > DETAILS_LIMIT
        ? { ...ev, details: ev.details.slice(0, DETAILS_LIMIT) }
        : ev
    );
    trimmed = true;
  }
  while (events.length && size() > MAX_BYTES) {
    events.pop();
    trimmed = true;
  }

  return { payload, count: events.length, trimmed, collapsed };
}

/** Key-sorted stringify: key order and array order aside, stable bytes. */
function sortedStringify(v) {
  if (Array.isArray(v)) return `[${v.map(sortedStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${sortedStringify(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * FNV-1a (32-bit, hex) over a key-sorted stringify — stable across key order.
 * @param {any} payload
 */
export function stableHash(payload) {
  const s = sortedStringify(payload);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
