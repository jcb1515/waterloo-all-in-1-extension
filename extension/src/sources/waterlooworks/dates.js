// @ts-check
// WaterlooWorks date parsing (pure). WW renders times like
// "Oct 02, 2026 04:00 PM ET", "Sep 29, 2026 9:00 AM", "September 30, 2026
// 09:00 AM", "09/25/2026 12:01 PM", and date-only "Oct 2, 2026" / "MM/DD/YYYY".
// Wall-time → UTC conversion is the shared textdates zonedIso (DST-safe).

import { zonedIso } from "../../lib/textdates/index.js";

const MONTHS = Object.freeze({
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9,
  sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
});

const WEEKDAY = "(?:mon|tues|wednes|thurs|fri|satur|sun)day";

// "October 1, 2026" | "Thursday, October 1, 2026" | "Oct 2, 2026 4:00 PM ET"
const NAMED_DATE = new RegExp(
  `^(?:${WEEKDAY},?\\s+)?([A-Za-z]+)\\s+(\\d{1,2}),?\\s+(\\d{4})` +
    `(?:\\s+(\\d{1,2}):(\\d{2})\\s*([ap])\\.?m\\.?)?\\s*(?:ET|EST|EDT)?\\s*$`,
  "i"
);
// "09/25/2026 12:01 PM" | "09/25/2026"
const NUMERIC_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*([ap])\.?m\.?)?\s*$/i;
const TIME = /(\d{1,2}):(\d{2})\s*([ap])\.?m\.?/i;
// "Oct 2, 2026 from 4:00 PM ET to 4:30 PM ET"
const RANGE = /^(.*?)\s+from\s+(\d{1,2}:\d{2}\s*[ap]\.?m\.?)\s*(?:ET|EST|EDT)?\s+to\s+(\d{1,2}:\d{2}\s*[ap]\.?m\.?)\s*(?:ET|EST|EDT)?\s*$/i;
// "12:30 PM ET to 01:00 PM ET" (slot rows carry their date in a day header)
const TIME_RANGE = /(\d{1,2}:\d{2}\s*[ap]\.?m\.?)\s*(?:ET|EST|EDT)?\s+to\s+(\d{1,2}:\d{2}\s*[ap]\.?m\.?)\s*(?:ET|EST|EDT)?/i;

/** @typedef {{y: number, m: number, d: number, h?: number, mi?: number}} DateParts */

/**
 * @param {string} text
 * @returns {DateParts|null}
 */
function parseParts(text) {
  const named = NAMED_DATE.exec(text.trim());
  if (named) {
    const key = /** @type {keyof typeof MONTHS} */ (named[1].toLowerCase());
    if (!Object.hasOwn(MONTHS, key)) return null;
    const month = MONTHS[key];
    const parts = { y: +named[3], m: month, d: +named[2] };
    if (named[4] !== undefined) {
      parts.h = to24h(+named[4], named[6]);
      parts.mi = +named[5];
    }
    return parts;
  }
  const numeric = NUMERIC_DATE.exec(text.trim());
  if (numeric) {
    const parts = { y: +numeric[3], m: +numeric[1], d: +numeric[2] };
    if (numeric[4] !== undefined) {
      parts.h = to24h(+numeric[4], numeric[6]);
      parts.mi = +numeric[5];
    }
    return parts.m >= 1 && parts.m <= 12 && parts.d >= 1 && parts.d <= 31 ? parts : null;
  }
  return null;
}

/**
 * @param {number} h12
 * @param {string} meridiem  "a"|"p" (any case)
 */
function to24h(h12, meridiem) {
  const h = h12 % 12;
  return meridiem.toLowerCase() === "p" ? h + 12 : h;
}



/**
 * Parse a WW date/datetime string. Timed values are Toronto wall time and
 * return a UTC ISO instant; a date-only value returns "YYYY-MM-DD".
 * @param {unknown} text
 * @param {string} [tz]
 * @returns {string|null}
 */
export function parseWwDate(text, tz = "America/Toronto") {
  if (typeof text !== "string") return null;
  const parts = parseParts(text);
  if (!parts) return null;
  if (parts.h === undefined) {
    const mm = String(parts.m).padStart(2, "0");
    const dd = String(parts.d).padStart(2, "0");
    return `${parts.y}-${mm}-${dd}`;
  }
  return zonedIso(parts.y, parts.m, parts.d, parts.h, parts.mi ?? 0, tz);
}

/**
 * "Oct 2, 2026 from 4:00 PM ET to 4:30 PM ET" -> {startAt, endAt} (UTC ISO).
 * @param {unknown} text
 * @param {string} [tz]
 */
export function parseWwRange(text, tz = "America/Toronto") {
  if (typeof text !== "string") return null;
  const match = RANGE.exec(text.trim());
  if (!match) return null;
  return rangeFromParts(match[1], match[2], match[3], tz);
}

/**
 * Slot rows: the date lives in a day header ("Thursday, October 1, 2026") and
 * the cell carries just "12:30 PM ET to 01:00 PM ET".
 * @param {unknown} dateText
 * @param {unknown} rangeText
 * @param {string} [tz]
 */
export function parseWwTimeRange(dateText, rangeText, tz = "America/Toronto") {
  if (typeof dateText !== "string" || typeof rangeText !== "string") return null;
  const match = TIME_RANGE.exec(rangeText);
  if (!match) return null;
  return rangeFromParts(dateText, match[1], match[2], tz);
}

function rangeFromParts(dateText, timeText1, timeText2, tz) {
  const date = parseParts(dateText);
  const t1 = TIME.exec(timeText1);
  const t2 = TIME.exec(timeText2);
  if (!date || !t1 || !t2) return null;
  return {
    startAt: zonedIso(date.y, date.m, date.d, to24h(+t1[1], t1[3]), +t1[2], tz),
    endAt: zonedIso(date.y, date.m, date.d, to24h(+t2[1], t2[3]), +t2[2], tz),
  };
}
