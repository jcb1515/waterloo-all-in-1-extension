// @ts-check
/*
  Pure co-op view model: the "coming up" slice, application status grouping,
  and interview-prep checklists. No DOM, no chrome.*.
*/

import { effectiveItem, isVisible } from "../../core/effective.js";

const DAY = 86400000;

const COOP_TYPES = new Set([
  "interview",
  "application-deadline",
  "offer-deadline",
  "cycle-date",
]);

/** A deadline whose category marks it as a WaterlooWorks timeslot pick. */
const isTimeslotDeadline = (/** @type {any} */ i) =>
  i.type === "deadline" && i.category === "interview-timeslot";

/** Co-op item types: interviews, app/offer deadlines, cycle dates, timeslots. */
export const isCoopItem = (/** @type {any} */ i) =>
  COOP_TYPES.has(i && i.type) || isTimeslotDeadline(i);

const anchorOf = (/** @type {any} */ i) => i.dueAt || i.startAt || null;

/**
 * Visible, open co-op items sorted by anchor.
 * @param {Record<string, any>} items
 * @param {Record<string, any>} userState
 * @param {Date} now
 * @param {{acceptPending?: boolean}} [opts]
 */
export function coopItems(items, userState = {}, now = new Date(), opts = {}) {
  const out = [];
  for (const raw of Object.values(items || {})) {
    if (!raw || !raw.id) continue;
    const eff = effectiveItem(raw, userState[raw.id], opts);
    if (!isCoopItem(eff)) continue;
    if (eff.status === "cancelled") continue;
    if (!isVisible(eff, now)) continue;
    out.push(eff);
  }
  out.sort((a, b) => Date.parse(anchorOf(a)) - Date.parse(anchorOf(b)));
  return out;
}

/**
 * Co-op items anchored within the next `days` days (inclusive of overdue that
 * are still open — an unanswered offer deadline should stay visible).
 */
export function comingUp(items, userState = {}, now = new Date(), days = 14, opts = {}) {
  const endMs = now.getTime() + days * DAY;
  return coopItems(items, userState, now, opts).filter((it) => {
    const a = anchorOf(it);
    if (!a) return false;
    const ms = Date.parse(a);
    return ms < endMs && (it.status === "open" ? true : ms >= now.getTime());
  });
}

/* --------------------------- application grouping --------------------------- */

/**
 * Every contract ApplicationStatus mapped to a display group.
 * Unknown/unlisted statuses land in "applied" (per spec).
 */
export const STATUS_GROUP = /** @type {Record<string, string>} */ ({
  applied: "applied",
  unknown: "applied",
  "selected-for-interview": "interviewing",
  "interview-scheduled": "interviewing",
  alternate: "interviewing",
  offer: "offers",
  ranked: "offers",
  matched: "offers",
  "not-selected": "closed",
  withdrawn: "closed",
  declined: "closed",
});

/** Group order for the filter chips. */
export const APP_GROUPS = [
  ["all", "All"],
  ["applied", "Applied"],
  ["interviewing", "Interviewing"],
  ["offers", "Offers"],
  ["closed", "Closed"],
];

/** @param {string} status an ApplicationStatus (or anything) */
export function groupForStatus(status) {
  return STATUS_GROUP[status] || "applied";
}

/** A group's chip tone: muted for closed, warn for interviewing, ok for offers. */
export const GROUP_TONE = {
  applied: "muted",
  interviewing: "warn",
  offers: "ok",
  closed: "muted",
};

/** Last change instant for an application (history tail or null). */
export function appLastAt(app) {
  const h = app && app.history;
  if (Array.isArray(h) && h.length) {
    const at = h[h.length - 1] && h[h.length - 1].at;
    if (at) return Date.parse(at);
  }
  return NaN;
}

/**
 * Bucket applications by status group, newest change first inside each.
 * @param {Record<string, any>} applications
 * @returns {{key: string, label: string, apps: any[]}[]}
 */
export function groupApplications(applications) {
  const byGroup = new Map();
  for (const [key] of APP_GROUPS) if (key !== "all") byGroup.set(key, []);
  const all = [];
  for (const app of Object.values(applications || {})) {
    if (!app || !app.id) continue;
    all.push(app);
    const g = groupForStatus(app.status);
    byGroup.get(g).push(app);
  }
  const byLast = (a, b) => (appLastAt(b) || 0) - (appLastAt(a) || 0);
  all.sort(byLast);
  return APP_GROUPS.map(([key, label]) => ({
    key,
    label,
    apps: (key === "all" ? all : byGroup.get(key)).sort(byLast),
  }));
}

/* ------------------------------ interview prep ------------------------------ */

const VIDEO_RE = /video|virtual|remote|zoom|teams|webex|meet\b|online/i;

/**
 * The prep details from an interview item's meta.prep (plus fallbacks).
 * @param {any} item
 * @returns {{format?: string, location?: string, interviewer?: string,
 *   instructions?: string, jobId?: string, jobTitle?: string, employer?: string,
 *   url?: string, video: boolean}}
 */
export function prepOf(item) {
  const prep = (item && item.meta && item.meta.prep) || {};
  const format = prep.format || prep.interviewType || null;
  const location = prep.location || (item && item.location) || null;
  const video = VIDEO_RE.test(`${format || ""} ${location || ""} ${prep.method || ""}`);
  return {
    format,
    location,
    interviewer: prep.interviewer || null,
    instructions: prep.instructions || null,
    jobId: prep.jobId || (item && item.meta && item.meta.jobId) || null,
    jobTitle: prep.jobTitle || prep.postingTitle || null,
    employer: prep.employer || (item && item.org) || null,
    url: (item && item.url) || null,
    video,
  };
}

/**
 * The default prep checklist — video items also get the camera/mic step.
 * @param {any} item
 * @returns {string[]}
 */
export function defaultChecklist(item) {
  const steps = ["Review the posting", "Research the company", "Prepare 3 questions"];
  if (prepOf(item).video) steps.push("Test camera and mic");
  return steps;
}

/**
 * The item's checklist from userState.subtasks ([{text, done}]), falling back
 * to the defaults. Unknown legacy shapes (string[]) are normalised.
 * @param {any} item
 * @param {any} us  userState[item.id]
 * @returns {{text: string, done: boolean}[]}
 */
export function checklistFor(item, us) {
  const st = us && Array.isArray(us.subtasks) ? us.subtasks : null;
  if (st && st.length) {
    return st
      .map((t) =>
        typeof t === "string" ? { text: t, done: false } : { text: t && t.text, done: !!t.done }
      )
      .filter((t) => t.text);
  }
  return defaultChecklist(item).map((text) => ({ text, done: false }));
}
