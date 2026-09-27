// @ts-check
/*
  Quick add: turn "ECE 105 quiz Friday 3pm" into a normalised manual item.
  parseQuickAdd is pure — dates come from textdates' extractDates on the
  Toronto clock, orgs match stored course codes and watched Discord teams.
*/

import { normCourseCode } from "./contract.js";
import { extractDates, termCodeFor, zonedParts, zonedIso } from "../lib/textdates/index.js";

const TZ = "America/Toronto";

/** Types that anchor on startAt; everything else anchors on dueAt. */
const TIMED_TYPES = new Set(["exam", "meeting", "interview", "event", "class", "tutorial"]);

/** @type {[RegExp, string, string][]} */
const TYPE_RULES = [
  [/\bquiz(?:zes)?\b/i, "quiz", "Quiz"],
  [/\b(?:exam|midterm|final)\b/i, "exam", "Exam"],
  [/\blab\b/i, "lab", "Lab"],
  [/\btutorial\b/i, "tutorial", "Tutorial"],
  [/\b(?:meeting|sync|stand\s?-?up)\b/i, "meeting", "Meeting"],
  [/\binterview\b/i, "interview", "Interview"],
  [/\bpresentation\b/i, "presentation", "Presentation"],
  [/\b(?:due|assignment|report|deliverable)\b/i, "deadline", "Deadline"],
];

const TYPE_LABEL = Object.fromEntries([
  ...TYPE_RULES.map(([, t, l]) => [t, l]),
  ["event", "Event"],
  ["task", "Task"],
]);

/** Words that make an all-day date a due-time rather than an event. */
const DUE_WORD = /\b(?:due|deadline|assignment|report|deliverable|submit|by)\b/i;

/** Course-code-ish token, e.g. "ECE 105", "MATH117", "CS 246E". */
const CODE_RE = /([A-Za-z]{2,8})\s*(\d{3}[A-Za-z]{0,2})(?![A-Za-z0-9])/g;

/**
 * Room pattern: "E7 2324", "MC 4020", "DWE 1515", "MC4020" — 1-4 letters,
 * up to 2 digits (building), optional space, 3-4 digits (room).
 */
const ROOM_RE = /\b[A-Z]{1,4}\d{0,2}\s?\d{3,4}\b/g;

/** @param {string} text */
function codeTokens(text) {
  /** @type {{raw: string, norm: string, index: number, end: number}[]} */
  const out = [];
  for (const m of text.matchAll(CODE_RE)) {
    const raw = m[0];
    const index = /** @type {number} */ (m.index);
    out.push({ raw, norm: normCourseCode(raw), index, end: index + raw.length });
  }
  return out;
}

/**
 * Parse "ECE 105 quiz Friday 3pm" into the editable quick-add fields.
 * @param {string} text
 * @param {{now?: Date, orgs?: string[]}} [opts] orgs: known course codes and
 *   watched Discord team names
 * @returns {{title: string, org: string, type: string, dueAt?: string,
 *   startAt?: string, endAt?: string, allDay: boolean, location: string,
 *   confidence: number, dateText?: string}}
 */
export function parseQuickAdd(text, { now = new Date(), orgs = [] } = {}) {
  const input = String(text || "");
  const termCode = termCodeFor(now);
  /** @type {any} */
  let hit = null;
  try {
    hit = extractDates(input, { now, termCode })[0] || null;
  } catch {
    hit = null;
  }

  /* ---- org: known course codes and team names, else a leading code ---- */
  /** @type {{org: string, index: number, end: number} | null} */
  let orgSpan = null;
  const tokens = codeTokens(input);
  const known = (orgs || [])
    .map((o) => String(o))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const org of known) {
    // Word-boundary match with flexible internal whitespace, so "MATH 117"
    // also catches "MATH117", and team names like "ECE 2027" (which don't
    // parse as course codes) still match.
    const re = new RegExp(`\\b${escRe(org).replace(/\s+/g, "\\s*")}\\b`, "i");
    const m = re.exec(input);
    if (m) {
      orgSpan = { org, index: m.index, end: m.index + m[0].length };
      break;
    }
  }
  if (!orgSpan && tokens.length && tokens[0].index <= 1) {
    // A leading course code is accepted even when it isn't a known course.
    const t = tokens[0];
    orgSpan = { org: t.norm, index: t.index, end: t.end };
  }
  const org = orgSpan ? orgSpan.org : "";

  /* ---- location: first room token that isn't the org or the date ---- */
  let location = "";
  /** @type {{index: number, end: number} | null} */
  let locSpan = null;
  const inSpan = (i, e) =>
    (hit && i < hit.index + hit.text.length && e > hit.index) ||
    (orgSpan && i < orgSpan.end && e > orgSpan.index);
  for (const m of input.matchAll(ROOM_RE)) {
    const raw = m[0];
    const index = /** @type {number} */ (m.index);
    if (inSpan(index, index + raw.length)) continue;
    if (orgSpan && normCourseCode(raw) === normCourseCode(orgSpan.org)) continue;
    location = raw.replace(/\s+/g, " ").trim();
    locSpan = { index, end: index + raw.length };
    break;
  }

  /* ---- type by keyword; timed -> event, undated/all-day -> task ---- */
  let type = "";
  for (const [re, t] of TYPE_RULES) {
    if (re.test(input)) {
      type = t;
      break;
    }
  }
  if (!type) type = hit && !hit.allDay ? "event" : "task";

  /* ---- anchor ---- */
  /** @type {any} */
  const out = {
    title: "",
    org,
    type,
    allDay: false,
    location,
    confidence: hit ? (typeof hit.confidence === "number" ? hit.confidence : 1) : 0,
  };
  if (hit) {
    out.dateText = hit.text;
    if (hit.endAt) {
      out.startAt = hit.startAt;
      out.endAt = hit.endAt;
    } else if (hit.allDay) {
      // An all-day date anchors at end-of-day Toronto (a due time for
      // deliverables, "all day" for anything else).
      const p = zonedParts(new Date(hit.startAt), TZ);
      out.dueAt = zonedIso(p.y, p.m, p.d, 23, 59, TZ);
      out.allDay = true;
    } else if (TIMED_TYPES.has(type) && !DUE_WORD.test(input)) {
      out.startAt = hit.startAt;
    } else {
      out.dueAt = hit.startAt;
    }
  }

  /* ---- title: input minus the date text, org and location ---- */
  let title = input;
  const spans = [
    hit ? { index: hit.index, end: hit.index + hit.text.length } : null,
    orgSpan ? { index: orgSpan.index, end: orgSpan.end } : null,
    locSpan,
  ]
    .filter(Boolean)
    .sort((a, b) => /** @type {any} */ (b).index - /** @type {any} */ (a).index);
  for (const s of spans) {
    title = title.slice(0, /** @type {any} */ (s).index) + " " + title.slice(/** @type {any} */ (s).end);
  }
  title = title
    .replace(/[-–—·:,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b(?:at|in|on|by|for|from|with|the)\b/gi, " ")
    .replace(/^(?:due|deadline|submit)\b/i, "")
    .replace(/\b(?:due|deadline|submit)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  title = title ? title[0].toUpperCase() + title.slice(1) : "";
  out.title = title || TYPE_LABEL[type] || "Item";

  return out;
}

/**
 * Build the raw manual item stored under raw:manual.
 * @param {{title: string, org?: string, type: string, dueAt?: string,
 *   startAt?: string, endAt?: string, allDay?: boolean, location?: string,
 *   meta?: Record<string, any>}} f
 * @param {{id?: string, now?: Date}} [opts]
 */
export function manualItemFrom(f, { id, now = new Date() } = {}) {
  const itemId = id || `manual:${crypto.randomUUID()}`;
  const at = now.toISOString();
  /** @type {any} */
  const item = {
    id: itemId,
    source: "manual",
    title: f.title,
    type: f.type || "task",
    status: "open",
    confidence: "exact",
    review: "auto",
    allDay: !!f.allDay,
    evidence: { method: "manual" },
    seenIn: [{ source: "manual", key: itemId, scope: "manual", at }],
  };
  if (f.org) item.org = f.org;
  if (f.location) item.location = f.location;
  if (f.meta && typeof f.meta === "object") item.meta = { ...f.meta };
  if (f.startAt) item.startAt = f.startAt;
  if (f.endAt) item.endAt = f.endAt;
  if (f.dueAt) item.dueAt = f.dueAt;
  return item;
}

/**
 * The quick-add/edited fields -> a SyncResult whose whole item list replaces
 * the manual raw (complete semantics).
 * @param {{items?: any[]}|null} prevRaw
 * @param {any} item
 * @returns {{items: any[], complete: boolean}}
 */
export function manualUpsertResult(prevRaw, item) {
  const items = ((prevRaw && prevRaw.items) || []).filter((i) => i && i.id !== item.id);
  items.push(item);
  return { items, complete: true };
}

/** @param {{items?: any[]}|null} prevRaw @param {string} id */
export function manualDeleteResult(prevRaw, id) {
  const items = ((prevRaw && prevRaw.items) || []).filter((i) => i && i.id !== id);
  return { items, complete: true };
}
