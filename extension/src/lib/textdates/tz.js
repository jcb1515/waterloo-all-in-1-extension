// @ts-check
/*
  Time-zone helpers: convert wall-clock times in an IANA zone to UTC instants
  and back using only Intl (works in service workers, content scripts and Node).
*/

/** @type {Map<string, Intl.DateTimeFormat>} */
const fmtCache = new Map();

/** @param {string} tz */
function dtf(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/**
 * Wall-clock reading of an instant in tz, expressed as a UTC-millis number
 * (i.e. the offset in ms is `wallMs(ms) - ms`).
 * @param {number} ms
 * @param {Intl.DateTimeFormat} f
 */
function wallMs(ms, f) {
  const p = f.formatToParts(new Date(ms));
  /** @param {string} t */
  const g = (t) => Number(p.find((x) => x.type === t)?.value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
}

/**
 * UTC ISO instant for the wall time `y-m-d h:mi` in `tz`.
 * Ambiguous wall times (fall-back) resolve to the earlier instant; nonexistent
 * wall times (spring-forward) are shifted forward by the gap, e.g. 02:30 -> 03:30.
 * @param {number} y @param {number} m  1-12 @param {number} d
 * @param {number} [h] @param {number} [mi] @param {string} [tz]
 */
export function zonedIso(y, m, d, h = 0, mi = 0, tz = "America/Toronto") {
  const f = dtf(tz);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const o1 = wallMs(guess, f) - guess;
  const t = guess - o1;
  const o2 = wallMs(t, f) - t;
  if (o2 === o1) return new Date(t).toISOString();
  const t2 = guess - o2;
  if (wallMs(t2, f) - t2 === o2) return new Date(t2).toISOString();
  // Neither offset is consistent: the wall time sits in the spring-forward gap.
  // guess - o1 already lands on wall + gap (the shifted-forward reading).
  return new Date(t).toISOString();
}

/**
 * Wall-clock components of `date` in `tz`.
 * @param {Date} date @param {string} [tz]
 * @returns {{y: number, m: number, d: number, h: number, mi: number, weekday: number}} weekday 0=Sun
 */
export function zonedParts(date, tz = "America/Toronto") {
  const p = dtf(tz).formatToParts(date);
  /** @param {string} t */
  const g = (t) => Number(p.find((x) => x.type === t)?.value);
  const y = g("year"), m = g("month"), d = g("day");
  return { y, m, d, h: g("hour") % 24, mi: g("minute"), weekday: weekdayOf(y, m, d) };
}

/**
 * Day of week for a calendar date (0=Sun). Pure calendar math, no tz.
 * @param {number} y @param {number} m  1-12 @param {number} d
 */
export function weekdayOf(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
