// @ts-check
// Loose time-of-day parsing shared by recurring-meeting hints and
// "Time: …" announcement lines. All times are interpreted as Toronto wall
// time — explicit EST/EDT/ET/etc labels are ignored.

const TIME_RES = [
  /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i,
  /\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?\b/i,
  /\b(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)\b/i,
];

/**
 * North-American timezone labels Discord users tack onto times
 * ("5:00 PM EST"). Ignored — the adapter always reads Toronto wall time.
 */
const TZ_LABEL_RE = /\b(?:e[sd]?t|c[sd]?t|m[sd]?t|p[sd]?t|utc|gmt)\b\.?/gi;

/**
 * A "5:00–7:00 PM" / "5–7 PM" / "11 AM to 1 PM" range. A single trailing
 * meridiem applies to both ends; an explicit meridiem on the start wins.
 */
const RANGE_RE =
  /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:[-–—−]|\bto\b)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i;

/** @param {string} hs @param {string|undefined} ms @param {string|undefined} ap */
function toHMI(hs, ms, ap) {
  let h = Number(hs);
  const mi = Number(ms || 0);
  const aps = String(ap || "");
  if (/p/i.test(aps) && h < 12) h += 12;
  if (/a/i.test(aps) && h === 12) h = 0;
  if (!aps && h > 23) return null;
  if (h > 23 || mi > 59) return null;
  return { h, mi };
}

/** "at 6pm" / "6:30 PM" / "18:00" -> {h, mi} or null. */
export function parseLooseTime(text) {
  const s = String(text || "");
  let m;
  if ((m = TIME_RES[0].exec(s))) return toHMI(m[1], m[2], m[3]);
  if ((m = TIME_RES[1].exec(s))) return toHMI(m[1], m[2], m[3]);
  if ((m = TIME_RES[2].exec(s))) return toHMI(m[1], "0", m[2]);
  return null;
}

/**
 * A time value -> {start: {h,mi}, end: {h,mi}|null} or null.
 * Handles ranges and ignores trailing timezone labels.
 * @param {string} text  e.g. "5:00 PM EST", "5:00–7:00 PM"
 */
export function parseTimeValue(text) {
  const s = String(text || "").replace(TZ_LABEL_RE, " ").trim();
  if (!s) return null;
  const m = RANGE_RE.exec(s);
  if (m) {
    const start = toHMI(m[1], m[2], m[3] || m[6]);
    const end = toHMI(m[4], m[5], m[6] || m[3]);
    if (start && end) return { start, end };
  }
  const t = parseLooseTime(s);
  return t ? { start: t, end: null } : null;
}
