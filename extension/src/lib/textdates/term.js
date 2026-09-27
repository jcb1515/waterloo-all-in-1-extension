// @ts-check
/* UW term codes: 1xys where xy = year - 1900 and s = 1 winter, 5 spring, 9 fall. */

import { zonedParts } from "./tz.js";

/** @param {number} code e.g. 1269 -> 2026 */
export function termYear(code) {
  return 1900 + Math.floor(code / 10);
}

/** @param {number} code @returns {"winter"|"spring"|"fall"} */
export function termSeason(code) {
  const s = code % 10;
  return s === 1 ? "winter" : s === 5 ? "spring" : "fall";
}

/**
 * Term code containing `date`, by Toronto wall date:
 * Jan-Apr -> 1, May-Aug -> 5, Sep-Dec -> 9.
 * @param {Date} date @param {string} [tz]
 */
export function termCodeFor(date, tz = "America/Toronto") {
  const p = zonedParts(date, tz);
  return (p.y - 1900) * 10 + (p.m <= 4 ? 1 : p.m <= 8 ? 5 : 9);
}

/** Term midpoint (month, day) per season digit, used as the "closest" reference. */
const MIDPOINT = { 1: [3, 1], 5: [7, 1], 9: [11, 1] };

/**
 * Guess the year of a written month/day: the candidate (term year -1/0/+1, or
 * now's Toronto year -1/0/+1 when no termCode) whose date is closest to the
 * term midpoint (winter Mar 1, spring Jul 1, fall Nov 1) or to `now`.
 * @param {number} month  1-12
 * @param {number} day
 * @param {{now?: Date, termCode?: number, tz?: string}} opts
 */
export function inferYear(month, day, { now = new Date(), termCode, tz = "America/Toronto" } = {}) {
  let ty, ref;
  if (termCode != null) {
    ty = termYear(termCode);
    const mid = MIDPOINT[termCode % 10] || MIDPOINT[9];
    ref = Date.UTC(ty, mid[0] - 1, mid[1]);
  } else {
    ty = zonedParts(now, tz).y;
    ref = now.getTime();
  }
  let best = ty, bestDist = Infinity;
  for (const y of [ty - 1, ty, ty + 1]) {
    const dist = Math.abs(Date.UTC(y, month - 1, day) - ref);
    if (dist < bestDist) { bestDist = dist; best = y; }
  }
  return best;
}
