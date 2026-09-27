// @ts-check
/*
  Light priority for one effective item. "high" earns a gold marker in the
  agenda; "low" (tentative, unweighted routine) is visually quiet.
*/

const DAY = 86400000;

/** Types with intrinsic urgency — a plain weight-0 class is not "urgent". */
const URGENT_TYPES = new Set([
  "deadline",
  "quiz",
  "exam",
  "presentation",
  "interview",
  "application-deadline",
  "offer-deadline",
]);

/**
 * @param {any} eff  an item already passed through effectiveItem
 * @param {Date} now
 * @returns {"high"|"normal"|"low"}
 */
export function priorityOf(eff, now = new Date()) {
  if (!eff) return "normal";
  const nowMs = now.getTime();
  const due = eff.dueAt ? Date.parse(eff.dueAt) : NaN;
  const start = eff.startAt ? Date.parse(eff.startAt) : NaN;
  const anchorMs = Number.isNaN(due) ? start : due;
  const weight = typeof eff.weight === "number" ? eff.weight : null;
  const open = eff.status === "open" && !eff.hidden;

  if (open && !Number.isNaN(anchorMs)) {
    if (anchorMs < nowMs) {
      if (weight != null && weight >= 5) return "high"; // overdue + weighted
    } else {
      if (!Number.isNaN(due) && due - nowMs <= DAY && weight != null && weight >= 10) {
        return "high"; // heavy thing due within a day
      }
      if (
        (eff.type === "exam" || eff.type === "interview") &&
        anchorMs - nowMs <= 3 * DAY
      ) {
        return "high";
      }
    }
  }

  if (eff.confidence === "tentative") return "low";
  if (!URGENT_TYPES.has(eff.type) && (weight == null || weight === 0)) return "low";
  return "normal";
}
