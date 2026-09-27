// @ts-check
/*
  Pure courses-view model: course cards (next class, next deliverable, counts)
  and the grade calculator (gradeSummary). No DOM, no chrome.*.
*/

import { normCourseCode } from "../../core/contract.js";
import { titleSimilarity } from "../../core/merge.js";
import { effectiveItem, isVisible } from "../../core/effective.js";

const MIN = 60000;
const DAY = 86400000;
const GRADE_MATCH_MIN = 0.6;

const isClassish = (/** @type {any} */ i) =>
  i.type === "class" || i.type === "tutorial" || (i.type === "lab" && !!i.startAt);

const anchorOf = (/** @type {any} */ i) => i.dueAt || i.startAt || null;

/**
 * Visible effective items for one course code.
 * @param {Record<string, any>} items
 * @param {Record<string, any>} userState
 * @param {string} code   normalised course code
 * @param {Date} now
 */
export function courseItems(items, userState, code, now) {
  const out = [];
  for (const raw of Object.values(items || {})) {
    if (!raw || !raw.id) continue;
    if (normCourseCode(raw.org) !== code) continue;
    const eff = effectiveItem(raw, (userState || {})[raw.id], {
      acceptPending: false,
    });
    if (eff.status === "cancelled" || !isVisible(eff, now)) continue;
    out.push(eff);
  }
  out.sort((a, b) => Date.parse(anchorOf(a)) - Date.parse(anchorOf(b)));
  return out;
}

/**
 * One summary per stored course, sorted by code.
 * @param {Record<string, any>} courses   code -> Course
 * @param {Record<string, any>} items
 * @param {Record<string, any>} userState
 * @param {Date} now
 */
export function courseCards(courses, items, userState, now) {
  const out = [];
  for (const raw of Object.values(courses || {})) {
    const course = raw;
    const code = normCourseCode(course && course.code);
    if (!code) continue;
    const list = courseItems(items, userState, code, now);
    const nowMs = now.getTime();
    const upcoming = list.filter((it) => {
      const a = anchorOf(it);
      return it.status === "open" && a && Date.parse(a) >= nowMs;
    });
    const nextClass = upcoming.find((it) => isClassish(it) && it.startAt) || null;
    const nextDue =
      upcoming.find((it) => !isClassish(it) && it.dueAt) || null;
    out.push({
      course,
      code,
      name: course.name || "",
      sections: Array.isArray(course.sections) ? course.sections : [],
      group: course.group || null,
      nextClass,
      nextDue,
      upcomingCount: upcoming.length,
      learnUrl: course.learnOrgUnitId
        ? `https://learn.uwaterloo.ca/d2l/home/${course.learnOrgUnitId}`
        : null,
      outlineUrl: course.outlineUrl || null,
      syllabusUrls: Array.isArray(course.syllabusUrls) ? course.syllabusUrls : [],
    });
  }
  out.sort((a, b) => a.code.localeCompare(b.code));
  return out;
}

/* ------------------------------ grade summary ------------------------------ */

/**
 * A grade record's percentage: points/max when both present, else parse a
 * display like "18 / 20" or "87%".
 * @param {any} g
 * @returns {number|null}
 */
function gradePct(g) {
  if (!g) return null;
  if (typeof g.points === "number" && typeof g.max === "number" && g.max > 0) {
    return (g.points / g.max) * 100;
  }
  const d = String(g.display ?? "");
  let m = d.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  if (m && Number(m[2]) > 0) return (Number(m[1]) / Number(m[2])) * 100;
  m = d.match(/(\d+(?:\.\d+)?)\s*%/);
  if (m) return Number(m[1]);
  return null;
}

/**
 * Weighted-average calculator for one course.
 * @param {any} course  merged Course
 * @param {{scheme?: any, target?: number}} [opts]
 *   scheme: a gradingSchemes entry ({name, rows:[{component, weight}]}); when
 *   omitted, course.weights are the components.
 *   target: the goal overall % (default 80).
 * @returns {{
 *   components: {component: string, weight: number|null, grade: any|null, pct: number|null}[],
 *   gradedWeight: number, totalWeight: number, remainingWeight: number,
 *   current: number|null, needed: number|null, secured: boolean,
 *   notReachable: boolean, target: number
 * }}
 */
export function gradeSummary(course, opts = {}) {
  const target = typeof opts.target === "number" ? opts.target : 80;
  /** @type {{component: string, weight: number|null}[]} */
  const comps = opts.scheme
    ? (opts.scheme.rows || []).map((/** @type {any} */ r) => ({
        component: r.component,
        weight: r.weight,
      }))
    : Array.isArray(course && course.weights)
      ? course.weights.map((/** @type {any} */ w) => ({
          component: w.component,
          weight: w.weight,
        }))
      : [];

  const grades = Array.isArray(course && course.grades) ? course.grades : [];
  const used = new Set();

  const components = comps.map((c) => {
    let best = null;
    let bestIdx = -1;
    let bestSim = 0;
    grades.forEach((g, gi) => {
      if (used.has(gi)) return;
      const sim = titleSimilarity(
        g.component,
        course && course.code,
        c.component,
        course && course.code
      );
      if (sim >= GRADE_MATCH_MIN && sim > bestSim) {
        best = g;
        bestIdx = gi;
        bestSim = sim;
      }
    });
    if (bestIdx !== -1) used.add(bestIdx);
    return {
      component: c.component,
      weight: typeof c.weight === "number" ? c.weight : null,
      grade: best,
      pct: gradePct(best),
    };
  });

  let gradedWeight = 0;
  let earned = 0;
  let totalWeight = 0;
  for (const c of components) {
    if (typeof c.weight === "number") totalWeight += c.weight;
    if (c.pct != null && typeof c.weight === "number") {
      gradedWeight += c.weight;
      earned += (c.pct * c.weight) / 100;
    }
  }
  const remainingWeight = Math.max(0, totalWeight - gradedWeight);
  const current = gradedWeight > 0 ? (earned / gradedWeight) * 100 : null;

  /** @type {number | null} */
  let needed = null;
  let secured = false;
  let notReachable = false;
  if (current != null && remainingWeight > 0) {
    needed = ((target / 100) * totalWeight - earned) / remainingWeight * 100;
    secured = needed <= 0;
    notReachable = needed > 100;
  } else if (current != null && remainingWeight === 0) {
    needed = null;
    secured = current >= target;
    notReachable = !secured;
  }

  return {
    components,
    gradedWeight,
    totalWeight,
    remainingWeight,
    current,
    needed,
    secured,
    notReachable,
    target,
  };
}

/**
 * This week's class topics for a course — the `details` of its classish
 * items anchored inside the current Toronto-local week.
 * @param {any[]} list   courseItems() output
 * @param {Date} now
 * @returns {string[]}
 */
export function weekTopics(list, now) {
  const start = new Date(now);
  const dow = (start.getDay() + 6) % 7; // Mon-first
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - dow);
  const end = start.getTime() + 7 * DAY;
  const topics = [];
  for (const it of list) {
    if (!isClassish(it) || !it.startAt || !it.details) continue;
    const ms = Date.parse(it.startAt);
    if (ms >= start.getTime() && ms < end) topics.push(it.details);
  }
  return [...new Set(topics)];
}
