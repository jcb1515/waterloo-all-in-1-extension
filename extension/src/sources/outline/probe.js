// @ts-check
/*
  Reader probe for W1's "Check readers" screen: counts how many of the
  selectors parseOutline depends on actually hit on the current page.
  Pure and never throws — counts only, no text, names, ids or addresses.
*/

import { parseOutline, sectionEls } from "./parsers.js";
import { OFFICE_RE } from "./expand.js";
import { LOGIN_WORDS } from "./index.js";

const HINT_LOGIN =
  "You're on the UW sign-in page — sign in, then reopen the outline.";
const HINT_OPEN =
  "Open one of your course outlines (outline.uwaterloo.ca/viewer/view/…).";
const HINT_SCHEDULE =
  "This outline has no class schedule table — classes can't be read from it.";

/**
 * W1's CheckRow plus the v2 checklist fields (`url` is the page an "Open"
 * button targets, `essential` marks first-run rows, `refreshDays` nudges
 * when the last good read is older).
 * @typedef {import("../probes.js").CheckRow & {
 *   url?: string, essential?: boolean, refreshDays?: number}} CheckRow
 */

/** Pages the user should open to verify this reader. `page` is the probe
 *  page kind the item expects.
 * @type {CheckRow[]} */
export const CHECKLIST = [
  {
    id: "outline-page",
    page: "outline",
    label: "A course outline",
    how: "Open one of your course outlines, e.g. from Portal → a course → Outline.",
    url: "https://outline.uwaterloo.ca/",
  },
  {
    id: "outline-schedule",
    page: "outline",
    label: "An outline with a class schedule",
    how: "Open an outline whose Class Schedule table lists your section.",
  },
];

const UNKNOWN = { page: "unknown", counts: {}, ok: false, hints: [HINT_OPEN] };

/**
 * @param {any} doc   a DOM Document (linkedom or real)
 * @param {string} href
 * @returns {{page: string, counts: Record<string, number>, ok: boolean, hints: string[]}}
 */
export function probe(doc, href) {
  try {
    if (!doc || typeof doc.querySelector !== "function") return { ...UNKNOWN };
    /** @type {URL} */
    let u;
    try {
      u = new URL(String(href || ""));
    } catch {
      return { ...UNKNOWN };
    }

    // An SSO shell: a non-outline host, or a page with no outline content
    // whose text carries the SSO words (LOGIN_WORDS — the regex isLoginShell
    // uses). A real outline can legitimately contain "log in" nav links, so
    // the word match only counts when .outline-courses is absent.
    const data = parseOutline(doc); // null without .outline-courses
    const root = doc.body || doc.documentElement || doc;
    const text = String(root.textContent || "").slice(0, 20000);
    if (u.hostname !== "outline.uwaterloo.ca" || (!data && LOGIN_WORDS.test(text))) {
      return { page: "login", counts: {}, ok: false, hints: [HINT_LOGIN] };
    }

    const viewer = /\/viewer\/view\//.test(u.pathname);
    const page = viewer && data ? "outline" : "outline-other";

    /** @type {Record<string, number>} */
    const counts = {
      title: data && (data.title || data.code) ? 1 : 0,
      scheduleTable: sectionEls(doc, "class_schedule").some(
        (el) =>
          el.querySelector &&
          el.querySelector("figure.schedule-info tbody, .schedule-info tbody, tbody"),
      )
        ? 1
        : 0,
      scheduleRows: data ? data.schedule.length : 0,
      assessmentTables: 0,
      assessmentRows: 0,
      planTables: 0,
      instructorCells: doc.querySelectorAll(".instructor-info").length,
      officeHours:
        data && [...String((data.text && data.text.team) || "").matchAll(OFFICE_RE)].length
          ? 1
          : 0,
    };
    if (data) {
      for (const s of data.schemes || []) {
        counts.assessmentTables += 1;
        counts.assessmentRows += (s.rows || []).length;
      }
      for (const t of data.tables || []) {
        if (t.section === "plan") counts.planTables += 1;
        if (t.section === "assessments") {
          counts.assessmentTables += 1;
          counts.assessmentRows += (t.rows || []).length;
        }
      }
    }

    const ok =
      page === "outline" &&
      counts.title > 0 &&
      (counts.scheduleRows > 0 || counts.assessmentRows > 0);
    /** @type {string[]} */
    const hints = [];
    if (page === "outline" && !counts.scheduleRows) hints.push(HINT_SCHEDULE);
    if (page !== "outline") hints.push(HINT_OPEN);
    return { page, counts, ok, hints };
  } catch {
    return { ...UNKNOWN };
  }
}
