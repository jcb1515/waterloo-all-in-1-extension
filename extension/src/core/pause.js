// @ts-check
// The reminders pause ("Pause 1 hour / until tomorrow"): pure helpers shared
// by core/remind.js and the panel. Leaf module — lib/textdates only.

import { zonedParts, zonedIso } from "../lib/textdates/index.js";

const TZ = "America/Toronto";

/**
 * The ms instant a reminders pause ends, or null when unset, expired or
 * invalid. An expired `pausedUntil` is simply ignored.
 * @param {any} rem `settings.reminders`
 * @param {Date|number} now
 */
export function pauseEndMs(rem, now) {
  const t = rem && rem.pausedUntil ? Date.parse(rem.pausedUntil) : NaN;
  const n = now instanceof Date ? now.getTime() : Number(now);
  return Number.isFinite(t) && t > n ? t : null;
}

/**
 * "Pause until tomorrow": 08:00 the next Toronto day, as an ISO string.
 * zonedIso resolves DST gaps/overlaps so it is always a real instant.
 * @param {Date|number} now
 */
export function pauseUntilTomorrow(now = new Date()) {
  const p = zonedParts(new Date(now), TZ);
  return zonedIso(p.y, p.m, p.d + 1, 8, 0, TZ);
}
