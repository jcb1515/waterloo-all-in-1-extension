// @ts-check
/*
  Google Calendar duplicate suppression. The gcal source keeps a rolling
  `sourceState.gcal.state.events` of what is already on the user's
  calendar (the export read = own calendars; the DOM read also covers
  subscribed ones); suppressAgainstCalendar marks canonical items that
  match an own/subscribed event with meta.onCalendar = "google" so the
  feed payload skips them and the panel shows the "On your Google
  Calendar" badge.

  Matching is course-aware: an item shares the event's course code
  ("ECE 105 LEC - …" / "ECE105 - LEC 001" / "ECE 150 | Assignment 3 due")
  before times and components are compared. Timed items match an event
  starting within ±5 minutes with a compatible component (LEC/TUT/LAB/
  SEM/TST/exam words); deadline items match on same assessment kind and
  number, on the same Toronto day (all-day either side) or ±5 minutes.
  Otherwise the plain title-similarity rule stands.

  Only "own" and "subscribed" events ever suppress. "wa1" is this
  extension's own feed (a "Calendar: Waterloo All-in-1" chip label, an
  ICS X-WR-CALNAME/PRODID saying so, or defensively a "<CODE> · <Label>"
  title) — it must never suppress the items it came from — and "unknown"
  is trusted with nothing.

  The mark is recomputed on every recompute pass from fresh canonical
  items — a gcal event deleted since the last read un-suppresses the item
  on its own; nothing here is sticky.
*/

import { titleSimilarity } from "./merge.js";
import { zonedParts } from "../lib/textdates/index.js";

const TIMED_WINDOW_MS = 5 * 60 * 1000;
const SIM_MIN = 0.6;
const TZ = "America/Toronto";

/* ------------------------- course codes ------------------------------- */

/** "ECE 105", "ECE105", "MATH 117B" -> "ECE105"… (upper-cased input). */
const CODE_RE = /\b([A-Z]{2,6})\s?(\d{3}[A-Z]?)\b/;

/** The course code a title carries, normalised without the space. */
const codeOf = (/** @type {any} */ t) => {
  const m = CODE_RE.exec(String(t || "").toUpperCase());
  return m ? `${m[1]}${m[2]}` : "";
};

/** An item's course code: its org first ("ECE 105"), then its title. */
const itemCode = (/** @type {any} */ it) => codeOf(it.org) || codeOf(it.title);

/* --------------------------- components ------------------------------- */

/** @type {[RegExp, string][]} */
const COMPONENT_RES = [
  [/\bfinals?\b|\bmid-?terms?\b|\bexams?(?:ination)?s?\b/i, "exam"],
  [/\b(?:tst|tests?)\b/i, "tst"],
  [/\b(?:labs?|laborator(?:y|ies))\b/i, "lab"],
  [/\b(?:tuts?|tutorials?)\b/i, "tut"],
  [/\b(?:sems?|seminars?)\b/i, "sem"],
  [/\b(?:lecs?|lectures?)\b|\bmake[- ]?up lectures?\b/i, "lec"],
];

/** The component word an event title carries ("ECE 105 TUT" -> "tut"). */
const componentOf = (/** @type {any} */ title) => {
  const t = String(title || "");
  for (const [re, c] of COMPONENT_RES) if (re.test(t)) return c;
  return "";
};

/** Component by item type, before title words refine it. @type {Record<string, string>} */
const ITEM_COMPONENT = { class: "lec", tutorial: "tut", lab: "lab", seminar: "sem", exam: "exam" };

/**
 * An item's component: its type maps (class -> lec, tutorial -> tut,
 * lab -> lab, exam -> exam — a class titled "Seminar" is sem), then a
 * component word in the title refines it.
 * @param {any} it
 */
const itemComponent = (it) => componentOf(it.title) || ITEM_COMPONENT[it.type] || "";

/**
 * Timed-item compatibility: equal components, or missing on either side.
 * Exam items additionally need an exam word or TST on the event —
 * "ECE105 - FINAL" matches, a bare "ECE 105 LEC" does not.
 * @param {any} it @param {any} ev
 */
const componentsCompatible = (it, ev) => {
  const ic = itemComponent(it);
  const ec = componentOf(ev.title);
  if (ic === "exam") return ec === "exam" || ec === "tst";
  return !ic || !ec || ic === ec;
};

/* --------------------------- assessments ------------------------------ */

/** "Assignment 3", "Quiz 3", "Project 2", "Midterm", "Final" … */
const ASSESS_KIND_RE =
  /\b(assignment|quiz|lab|project|report|essay|paper|deliverable|mid-?term|final)s?\b/i;
const KIND_NORM = { "mid-term": "midterm", midterm: "midterm" };

/**
 * The assessment a title names: {kind, num?}. The number is the digits
 * right after the kind word ("Assignment 3", "Quiz no. 2").
 * @param {any} title
 * @returns {{kind: string, num: string|null}|null}
 */
const assessmentOf = (title) => {
  const t = String(title || "");
  const m = ASSESS_KIND_RE.exec(t);
  if (!m) return null;
  const k = m[1].toLowerCase();
  const kind = /** @type {Record<string, string>} */ (KIND_NORM)[k] || k;
  const rest = t.slice(m.index + m[0].length);
  const n = /^[\s#:.-]*(?:no\.?\s*|number\s*)?(\d{1,2})\b/i.exec(rest);
  return { kind, num: n ? n[1] : null };
};

/** An item's assessment: its title first, else its category's kind word. */
const itemAssessment = (/** @type {any} */ it) => {
  const a = assessmentOf(it.title);
  if (a) return a;
  const m = ASSESS_KIND_RE.exec(String(it.category || ""));
  if (!m) return null;
  const k = m[1].toLowerCase();
  return { kind: /** @type {Record<string, string>} */ (KIND_NORM)[k] || k, num: null };
};

/* --------------------------- calendar kinds --------------------------- */

/** Defensive: our feed's titles are "<CODE> · <Label>" (U+00B7). */
const WA1_TITLE_RE = /^[A-Za-z]{2,6}\s?\d{3}[A-Za-z]?\s+·\s+\S/;

/**
 * This extension's own feed, whichever way it was classified. It must
 * never suppress the source items it republishes.
 * @param {any} e
 */
export const isWa1Event = (e) =>
  !!e && (e.calendarKind === "wa1" || WA1_TITLE_RE.test(String(e.title || "")));

/** An event that is allowed to suppress items: own or subscribed, never wa1/unknown. */
const suppressible = (/** @type {any} */ e) =>
  !!e &&
  (e.calendarKind === "own" || e.calendarKind === "subscribed") &&
  !isWa1Event(e);

const normTitle = (/** @type {any} */ s) =>
  String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The SUMMARY our feed publishes for an item (mirrors the server's
 * summaryOf): "<org> · <title>" when org is set and the title does not
 * already start with it, else the bare title.
 * @param {any} it
 */
const feedSummary = (it) => {
  const title = String(it.title || "");
  const org = String(it.org || "");
  return org && !title.toLowerCase().startsWith(org.toLowerCase())
    ? `${org} · ${title}`
    : title;
};

/**
 * A non-own event whose title is exactly the item's feed summary is our
 * own feed republishing the item — the calendar may have been renamed,
 * which dodges the label/title-shape checks, so compare the summary
 * directly ("✓ " and "Cancelled: " prefixes stripped). Never let it
 * suppress: hiding the item empties the feed event, which would then
 * un-hide the item — a self-suppression flip-flop.
 * @param {any} it @param {any} ev
 */
const feedRepublish = (it, ev) => {
  const want = normTitle(feedSummary(it));
  if (!want) return false;
  const got = normTitle(ev.title).replace(/^(?:✓|cancelled:)\s*/i, "");
  return got === want;
};

/**
 * The events suppression is allowed to see: own calendars plus other
 * subscribed calendars (UW Flow exports, Quest exporters) — minus this
 * extension's own feed, however it was classified.
 * @param {Record<string, any>} sourceState  the stored sourceState map
 */
export function gcalOwnEvents(sourceState) {
  const st =
    sourceState &&
    sourceState.gcal &&
    sourceState.gcal.state &&
    sourceState.gcal.state.events;
  if (!Array.isArray(st)) return [];
  return st.filter(suppressible);
}

/**
 * User-created things never suppress: derived to-dos (meta.auto), project
 * items (meta.projectId) and manual items — the user put those there on
 * purpose. Only adapter-produced source items are eligible.
 * @param {any} it canonical item
 */
function eligible(it) {
  if (!it || typeof it !== "object") return false;
  if (it.source === "manual") return false;
  const meta = it.meta || {};
  if (meta.auto || meta.projectId) return false;
  return true;
}

const torontoDay = (ms) => {
  const z = zonedParts(new Date(ms), TZ);
  return `${z.y}-${z.m}-${z.d}`;
};

/** Same Toronto calendar day when either side is all-day, else ±5 min. */
const closeInTime = (iMs, eMs, allDay) =>
  allDay ? torontoDay(iMs) === torontoDay(eMs) : Math.abs(iMs - eMs) <= TIMED_WINDOW_MS;

/**
 * A deadline item vs a same-code event: same assessment kind ("ECE 150 |
 * Assignment 3 due" vs an "Assignment 3" item), same number (missing on
 * both counts as equal — a bare "Midterm"/"Final" still matches), then
 * the all-day/±5-minute rule.
 * @param {any} it @param {any} ev @param {number} iMs @param {number} eMs
 */
const deadlineMatch = (it, ev, iMs, eMs) => {
  const ia = itemAssessment(it);
  const ea = assessmentOf(ev.title);
  if (!ia || !ea || ia.kind !== ea.kind || ia.num !== ea.num) return false;
  return closeInTime(iMs, eMs, it.allDay || ev.allDay);
};

/**
 * One item vs one event. Same course code first: a deadline pairs on
 * assessment kind + number + timing; a timed item pairs on a ±5-minute
 * start + a compatible component. Without a shared code the fallback is
 * the timing rule plus title similarity ≥ 0.6 against the bare item
 * title or "<org> <title>" (the published form a calendar copy carries).
 * @param {any} it @param {any} ev
 */
function eventMatches(it, ev) {
  if (ev.calendarKind !== "own" && feedRepublish(it, ev)) return false;
  const anchor = it.dueAt || it.startAt;
  const iMs = anchor ? Date.parse(anchor) : NaN;
  const eMs = ev && ev.startAt ? Date.parse(ev.startAt) : NaN;
  if (Number.isNaN(iMs) || Number.isNaN(eMs)) return false;

  const code = itemCode(it);
  if (code && code === codeOf(ev.title)) {
    if (it.dueAt) {
      if (deadlineMatch(it, ev, iMs, eMs)) return true;
    } else if (
      it.startAt &&
      !it.allDay &&
      !ev.allDay &&
      Math.abs(iMs - eMs) <= TIMED_WINDOW_MS &&
      componentsCompatible(it, ev)
    ) {
      return true;
    }
  }

  if (it.allDay || ev.allDay) {
    if (torontoDay(iMs) !== torontoDay(eMs)) return false;
  } else if (Math.abs(iMs - eMs) > TIMED_WINDOW_MS) {
    return false;
  }
  if (titleSimilarity(ev.title, "", it.title, "") >= SIM_MIN) return true;
  const withOrg = it.org ? `${it.org} ${it.title}` : "";
  return !!withOrg && titleSimilarity(ev.title, "", withOrg, "") >= SIM_MIN;
}

/**
 * Mark items already on the user's Google Calendar (own or subscribed —
 * never our own feed). Returns a new map only when something matched;
 * otherwise the input map unchanged.
 * @param {Record<string, any>} items canonical items (id -> item)
 * @param {any[]} gcalEvents sourceState.gcal.state.events (kinds filtered here)
 * @param {Date} [_now] kept for symmetry with the caller; matching is
 *   anchor-vs-anchor so now is unused.
 */
export function suppressAgainstCalendar(items, gcalEvents, _now = new Date()) {
  const src = (gcalEvents || []).filter(suppressible);
  if (!src.length || !items || typeof items !== "object") return items;
  let changed = false;
  /** @type {Record<string, any>} */
  const out = {};
  for (const [id, it] of Object.entries(items)) {
    const meta = (it && it.meta) || {};
    if (!eligible(it) || meta.onCalendar || !src.some((ev) => eventMatches(it, ev))) {
      out[id] = it;
      continue;
    }
    changed = true;
    out[id] = { ...it, meta: { ...meta, onCalendar: "google" } };
  }
  return changed ? out : items;
}
