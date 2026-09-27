// @ts-check
/*
  Pure mappers: portalapi2.uwaterloo.ca JSON rows -> contract Items, plus the
  course/term field patches each response carries. No fetch, no DOM, no chrome.

  Every Portal timestamp is Eastern time (user-confirmed): bare
  "YYYY-MM-DDTHH:mm(:ss)" strings are America/Toronto wall time; a Z or ±hh:mm
  offset is honoured literally.
*/

import { normCourseCode } from "../../core/contract.js";
import { hashString } from "../../capture/redact.js";
import { termCodeFor, zonedIso } from "../../lib/textdates/index.js";
import { factsOf } from "../learn/classify.js";
import { KIND_TITLE, addDays, dow, slug, torontoDate } from "../outline/expand.js";

/** @typedef {import("../../core/contract.js").Item} Item */
/** @typedef {{name: string, email?: string}} InstructorName */
/** @typedef {InstructorName & {section: string}} CourseInstructor */

const TZ = "America/Toronto";
export const EVIDENCE_ACADEMICS = { method: /** @type {const} */ ("api"), url: "https://portal.uwaterloo.ca/academics" };
export const EVIDENCE_CALENDAR = { method: /** @type {const} */ ("api"), url: "https://portal.uwaterloo.ca/calendar" };

const OFFSET = /(?:z|[+-]\d{2}:?\d{2})$/i;
const WALL = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

/**
 * A Portal timestamp -> ISO instant. Z/offset strings are parsed literally;
 * anything else in YYYY-MM-DDTHH:mm(:ss) form is Toronto wall time.
 * @param {string} s @returns {string|null}
 */
export function portalInstant(s) {
  const str = String(s ?? "").trim();
  if (!str) return null;
  if (OFFSET.test(str)) {
    const t = Date.parse(str);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  const m = str.match(WALL);
  if (!m) return null;
  return zonedIso(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), TZ);
}

/**
 * The Toronto calendar day a Portal timestamp lands on.
 * @param {string} s @returns {string|null} YYYY-MM-DD
 */
export function torontoDay(s) {
  const str = String(s ?? "");
  if (!/T|\d{2}:\d{2}/.test(str)) {
    const d = str.match(/\d{4}-\d{2}-\d{2}/);
    return d ? d[0] : null;
  }
  const iso = portalInstant(str);
  return iso ? torontoDate(iso) : null;
}

/** Toronto midnight on a YYYY-MM-DD day. */
export const midnight = (day) => {
  const [y, m, d] = String(day).split("-").map(Number);
  return zonedIso(y, m, d, 0, 0, TZ);
};

const seenIn = (key, scope, at) => [{ source: /** @type {const} */ ("portal"), key, scope, at }];

/** @type {Record<string, import("../../core/contract.js").ItemType>} */
const COMP_TYPE = { TUT: "tutorial", LAB: "lab", TST: "exam" };

/**
 * CourseSchedule rows -> meeting items + course patches. `instructors` is the
 * accumulated {"CODE|section": [{name, email}]} map from enrollments: an
 * Instructor fact only appears when enrollments were observed first.
 * @param {any[]} rows
 * @param {{scope: string, at: string, instructors?: Record<string, InstructorName[]>}} ctx
 * @returns {{items: Item[], patches: {code: string, name?: string, term?: number, sections: string[]}[]}}
 */
export function mapSchedule(rows, { scope, at, instructors } = {}) {
  /** @type {Item[]} */
  const items = [];
  const patches = new Map();
  for (const row of rows || []) {
    const code = normCourseCode(`${row.subjectCode || ""} ${row.catalog || ""}`.trim());
    const comp = String(row.componentCode || "").toUpperCase();
    const sect = String(row.sectionCode ?? "").trim();
    const section = `${comp} ${sect}`.trim();
    const startAt = portalInstant(row.startDate);
    if (!code || !startAt) continue;
    const key = `sched:${code.replace(/\s+/g, "")}:${comp}${sect}:${startAt}`;
    const isTst = comp === "TST";
    const names = ((instructors && instructors[`${code}|${section}`]) || [])
      .map((i) => i.name)
      .join(", ");
    const facts = factsOf([
      ["Instructor", names],
      ["Room", row.roomDescription],
      ["Section", section],
    ]);
    items.push(
      /** @type {Item} */ ({
        id: `portal:${key}`,
        source: "portal",
        org: code,
        type: isTst ? "exam" : COMP_TYPE[comp] || "class",
        category: isTst ? "midterm" : undefined,
        title: isTst ? "Midterm" : /** @type {Record<string, string>} */ (KIND_TITLE)[comp] || "Class",
        startAt,
        endAt: portalInstant(row.endDate) || undefined,
        location: row.roomDescription || undefined,
        section: section || undefined,
        status: "open",
        confidence: "exact",
        review: "auto",
        meta: facts ? { facts } : undefined,
        seenIn: seenIn(key, scope, at),
        evidence: { ...EVIDENCE_ACADEMICS },
      }),
    );
    const p = patches.get(code) || { code, sections: /** @type {string[]} */ ([]) };
    if (section) p.sections.push(section);
    if (row.courseTitle) p.name = row.courseTitle;
    if (p.term == null) p.term = termCodeFor(new Date(startAt));
    patches.set(code, p);
  }
  return { items, patches: [...patches.values()] };
}

const MIDTERM = /\b(midterm|mid-term|term test)\b/i;
const CODE_START = /^([A-Za-z]{2,8})\s*-?\s*(\d{3}[A-Z]{0,2})(?![A-Za-z0-9])/;

/**
 * ExamSchedule rows -> exam items. Ids carry no date so a moved exam keeps
 * its id; true duplicates within one payload get :2, :3.
 * @returns {Item[]}
 */
/** "2 h 30 min" / "3 h" / "50 min" from an ISO start/end pair. */
function durationText(startAt, endAt) {
  const min = Math.round((Date.parse(endAt) - Date.parse(startAt)) / 60000);
  if (!(min > 0)) return undefined;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h && m) return `${h} h ${m} min`;
  if (h) return `${h} h`;
  return `${m} min`;
}

export function mapExams(rows, { scope, at }) {
  /** @type {Item[]} */
  const items = [];
  const used = new Map();
  for (const row of rows || []) {
    if (!row.startDate) continue;
    const startAt = portalInstant(row.startDate);
    if (!startAt) continue;
    const endAt = portalInstant(row.endDate) || undefined;
    const rawTitle = String(row.title || "").trim();
    const cm = rawTitle.match(CODE_START);
    const org = cm ? normCourseCode(`${cm[1]} ${cm[2]}`) : undefined;
    const category = MIDTERM.test(rawTitle) ? "midterm" : "final";
    const base = `portal:exam:${org ? org.replace(/\s+/g, "") : slug(rawTitle)}:${category}`;
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    const key = `${base.replace(/^portal:/, "")}${n > 1 ? `:${n}` : ""}`;
    const facts = factsOf([
      ["Room", row.location],
      ["Seat", row.seatCode],
      ["Seat instructions", row.seatInstructions],
      ["Duration", endAt && durationText(startAt, endAt)],
    ]);
    items.push(
      /** @type {Item} */ ({
        id: `portal:${key}`,
        source: "portal",
        org,
        type: "exam",
        category,
        title: category === "midterm" ? "Midterm" : "Final exam",
        startAt,
        endAt,
        location: [row.location, row.seatCode && `Seat ${row.seatCode}`].filter(Boolean).join(" · ") || undefined,
        details: row.seatInstructions || undefined,
        status: "open",
        confidence: "exact",
        review: "auto",
        meta: facts ? { rawTitle, facts } : { rawTitle },
        seenIn: seenIn(key, scope, at),
        evidence: { ...EVIDENCE_ACADEMICS },
      }),
    );
  }
  return items;
}

/**
 * CourseEnrollments rows -> course patches (no items) + instructor names.
 * `instructors` is keyed "CODE|section" for later schedule-item facts;
 * each course patch also carries `instructors: [{name, email, section}]`.
 * @returns {{patches: {code: string, name?: string, outlineUrl?: string, term?: number,
 *   sections: string[], instructors?: CourseInstructor[]}[],
 *   instructors: Record<string, InstructorName[]>}}
 */
export function mapEnrollments(rows, { now }) {
  const patches = new Map();
  /** @type {Record<string, InstructorName[]>} */
  const instructors = {};
  for (const row of rows || []) {
    if (row.droppedDate != null) continue;
    const code = normCourseCode(`${row.courseSubject || ""} ${row.courseCatalogNumber || ""}`.trim());
    if (!code) continue;
    const comp = String(row.courseComponent || "").toUpperCase();
    const section = `${comp} ${String(row.classSection ?? "").padStart(3, "0")}`.trim();
    const p = patches.get(code) || { code, sections: /** @type {string[]} */ ([]) };
    if (section && !p.sections.includes(section)) p.sections.push(section);
    if (row.courseTitle) p.name = row.courseTitle;
    const outlineURL = String(row.outlineURL || "").trim();
    if (outlineURL) p.outlineUrl = /^https?:\/\//i.test(outlineURL) ? outlineURL : `https://${outlineURL}`;
    p.term = termCodeFor(now);

    /** @type {InstructorName[]} */
    const names = [];
    for (const e of Array.isArray(row.instructorData) ? row.instructorData : []) {
      const d = e && e.instructorDetail;
      if (!d) continue;
      const name = `${d.firstname || ""} ${d.lastname || ""}`.trim();
      if (!name || names.some((i) => i.name === name)) continue;
      names.push({ name, email: d.username ? `${d.username}@uwaterloo.ca` : undefined });
    }
    if (names.length && section) {
      const key = `${code}|${section}`;
      const cur = instructors[key] || [];
      for (const i of names) if (!cur.some((c) => c.name === i.name)) cur.push(i);
      instructors[key] = cur;
      const pi = p.instructors || [];
      for (const i of names) {
        if (!pi.some((c) => c.name === i.name && c.section === section)) pi.push({ ...i, section });
      }
      p.instructors = pi;
    }
    patches.set(code, p);
  }
  return { patches: [...patches.values()], instructors };
}

/** Titles that mean an academic-calendar date rather than a campus event. */
const TERM_RE =
  /(lectures?|classes) (begin|start|end)|first day of (lectures|classes)|last day of (lectures|classes)|reading week|mid-?term (week|period|break)|(final )?exam(ination)?s? (period|begin|start|end)|drop|withdraw|add (period|deadline)|holiday|thanksgiving|remembrance|fall break|study (day|break)|convocation|tuition|fee (payment|deadline)|grades? (due|available)/i;

/** Class echoes on the calendar feed duplicate CourseSchedule rows. */
const CLASS_ECHO = /^[A-Z]{2,5}\s?\d{3}[A-Z]?\s*[-–:]?\s*(LEC|TUT|LAB|SEM|TST)\b/;

/**
 * DailyEventsV2 rows -> event/term-date items + TermInfo patches.
 * @returns {{items: Item[], terms: {termCode: number, start?: string, end?: string,
 *   readingWeek?: {start: string, end?: string}, examPeriod?: {start?: string, end?: string}}[]}}
 */
export function mapEvents(rows, { scope, at }) {
  /** @type {Item[]} */
  const items = [];
  /** @type {Map<number, any>} */
  const terms = new Map();
  for (const row of rows || []) {
    if (row.isEventCancelled) continue;
    const title = String(row.summary || row.name || "").trim();
    if (!title || CLASS_ECHO.test(title)) continue;
    const startDay = torontoDay(row.startDate);
    if (!startDay) continue;

    /** @type {string|null} */
    let startAt;
    /** @type {string|undefined} */
    let endAt;
    if (row.allDay) {
      startAt = midnight(startDay);
      const endDay = torontoDay(row.endDate);
      if (endDay && endDay > startDay) {
        const endClock = String(row.endDate || "").match(/T(\d{2}):(\d{2})/);
        const isMidnight = !endClock || (endClock[1] === "00" && endClock[2] === "00");
        // A 00:00 end is already exclusive; any other time is inclusive.
        const excl = isMidnight ? endDay : nextDay(endDay);
        endAt = midnight(excl);
      }
    } else {
      startAt = portalInstant(row.startDate);
      endAt = portalInstant(row.endDate) || undefined;
    }
    if (!startAt) continue;

    const isTerm = TERM_RE.test(title);
    const key = `event:${row.key || hashString(`${title}|${row.startDate}`)}:${startDay}`;
    /** @type {Item} */
    const item = {
      id: `portal:${key}`,
      source: "portal",
      type: isTerm ? "term-date" : "event",
      category: isTerm ? undefined : "campus",
      title,
      startAt,
      endAt,
      allDay: row.allDay || undefined,
      location: row.location || undefined,
      details: row.description ? String(row.description).slice(0, 500) : undefined,
      status: "open",
      confidence: "exact",
      review: isTerm ? "auto" : "pending",
      meta: row.summary && row.name ? { feed: row.name } : undefined,
      seenIn: seenIn(key, scope, at),
      evidence: { ...EVIDENCE_CALENDAR },
    };
    items.push(item);

    if (isTerm) collectTerm(terms, title, startDay, endDayInclusive(row, startDay));
  }
  return { items, terms: [...terms.values()] };
}

/** Inclusive last day of an all-day row (single-day rows end on their start day). */
function endDayInclusive(row, startDay) {
  const endDay = torontoDay(row.endDate);
  if (!endDay || endDay <= startDay) return startDay;
  const endClock = String(row.endDate || "").match(/T(\d{2}):(\d{2})/);
  const isMidnight = !endClock || (endClock[1] === "00" && endClock[2] === "00");
  return isMidnight ? prevDay(endDay) : endDay;
}

const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const prevDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

/**
 * UW week numbering for a term: week 1 runs from `start` to the following
 * Sunday, every later week runs Monday–Sunday, and the last week is clipped
 * to `end`. Reading week counts (outlines number it).
 * @param {string} start @param {string} end  inclusive YYYY-MM-DD
 * @returns {{n: number, start: string, end: string}[]}
 */
export function termWeeks(start, end) {
  /** @type {{n: number, start: string, end: string}[]} */
  const weeks = [];
  let ws = String(start);
  const last = String(end);
  for (let n = 1; ws && ws <= last; n++) {
    const sunday = addDays(ws, (7 - dow(ws)) % 7);
    weeks.push({ n, start: ws, end: sunday < last ? sunday : last });
    ws = addDays(sunday, 1);
  }
  return weeks;
}

/** Fold a term-date title into a TermInfo patch keyed by termCode. */
function collectTerm(terms, title, startDay, endDay) {
  const t = title.toLowerCase();
  const termCode = termCodeFor(new Date(`${startDay}T12:00:00Z`));
  const p = terms.get(termCode) || { termCode };
  if (/reading week|fall break|study (day|break)/.test(t)) {
    p.readingWeek = { start: startDay, end: endDay || startDay };
  } else if (/mid-?term/.test(t)) {
    p.midtermWeek = { start: startDay, end: endDay || startDay };
  } else if (/(exam(ination)?s? (period|begin|start))/.test(t)) {
    p.examPeriod = { ...(p.examPeriod || {}), start: startDay };
    if (/period/.test(t) && endDay && endDay > startDay) p.examPeriod.end = endDay;
  } else if (/exam(ination)?s? end/.test(t)) {
    p.examPeriod = { ...(p.examPeriod || {}), end: endDay || startDay };
  } else if (/(lectures?|classes) (begin|start)|first day of (lectures|classes)/.test(t)) {
    p.start = startDay;
  } else if (/(lectures?|classes) end|last day of (lectures|classes)/.test(t)) {
    p.end = endDay || startDay;
  }
  terms.set(termCode, p);
}
