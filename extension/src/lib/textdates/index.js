// @ts-check
/*
  Shared text-date extraction: pulls dated phrases out of outline rows, Learn
  items, Discord messages and quick-add text. Runs anywhere (no DOM/Node APIs);
  parsing is chrono-node, all output instants are built from wall-clock
  components via zonedIso so results never depend on the machine time zone.
*/

import { en } from "chrono-node";
import { zonedIso, zonedParts, weekdayOf } from "./tz.js";
import { inferYear } from "./term.js";

export * from "./tz.js";
export * from "./term.js";

/** @typedef {import("../../core/contract.js").DateHit} DateHit */

const MONTH_RE = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
const WEEKDAY_RE = /\b(?:mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thur?s(?:day)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/i;
const REL_RE = /\b(?:today|tonight|tomorrow|yesterday)\b/i;
const ISO_RE = /\b\d{4}-\d{2}-\d{2}\b/;
const MONTH_G = new RegExp(MONTH_RE.source, "gi");
// Casual time-of-day words that also appear inside event names ("game night",
// "pitch night", "gala evening"): chrono merges the word into a following
// date expression ("pitch night on Oct 23 at 7pm") and drops the whole
// result. Those texts get a second pass with the words blanked (same length,
// so result offsets still map to the original); a masked hit is kept only
// where no real hit overlaps.
const CASUAL_MASK_RE = /\b(?:night|tonight|evening|morning|afternoon|noon|midnight|midday)\b/gi;

/**
 * Rewrite `text` into a chrono-friendlier copy, keeping for every normalised
 * character the half-open span it covers in the original.
 * @returns {{s: string, startOf: number[], endOf: number[]}}
 */
function normalise(text) {
  let s = text;
  const startOf = Array.from(s, (_, i) => i);
  const endOf = Array.from(s, (_, i) => i + 1);
  /** @param {RegExp} re @param {string} rep */
  const apply = (re, rep) => {
    s = s.replace(re, (m, ...a) => {
      const off = a[a.length - 2];
      const r = rep.replace(/\$(\d)/g, (_, g) => a[Number(g) - 1]);
      const os = startOf[off], oe = endOf[off + m.length - 1];
      const ns = [], ne = [];
      for (let i = 0; i < r.length; i++) { ns.push(i ? oe : os); ne.push(oe); }
      startOf.splice(off, m.length, ...ns);
      endOf.splice(off, m.length, ...ne);
      return r;
    });
  };
  apply(/[\u2013\u2014]/g, "-");            // en/em dash -> hyphen
  apply(/(\d)(?=[A-Z])/g, "$1 ");          // "Oct 6Grp" -> "Oct 6 Grp"
  return { s, startOf, endOf };
}

/** @param {number} h @param {string|undefined} mer  "a"|"p" */
function toHour(h, mer) {
  if (mer === "p" || mer === "P") return h % 12 + 12;
  if (mer === "a" || mer === "A") return h % 12;
  return h;
}

/**
 * Casual-text meridiem guess for a bare hour: 1-7 is PM ("meet Thursday at 2"
 * is 2 PM, not 2 AM), 8-11 stays AM, 12 stays noon. Only when chrono saw no
 * explicit AM/PM; 24-hour hours (>12) are never touched.
 * @param {number} h @param {boolean} meridiemCertain
 */
const meridiemGuess = (h, meridiemCertain) =>
  !meridiemCertain && h >= 1 && h <= 7 ? h + 12 : h;

/** "YYYY-MM-DD" wall date of an ISO instant in tz. */
function dayStr(iso, tz) {
  const p = zonedParts(new Date(iso), tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/**
 * @param {string} text
 * @param {{now?: Date, termCode?: number, tz?: string}} [opts]
 * @returns {DateHit[]}
 */
export function extractDates(text, { now = new Date(), termCode, tz = "America/Toronto" } = {}) {
  const { s: norm, startOf, endOf } = normalise(text);
  const p0 = zonedParts(now, tz);
  // Fake-local reference: chrono reads its fields as "now" in the target tz.
  const ref = new Date(p0.y, p0.m - 1, p0.d, p0.h, p0.mi);
  const results = en.casual.parse(norm, ref, { forwardDate: true });
  const masked = norm.replace(CASUAL_MASK_RE, (m) => " ".repeat(m.length));
  if (masked !== norm) {
    // The poisoned normal result sorts before the masked hit covering the
    // same date, so a surviving real hit suppresses the masked duplicate via
    // the prevEnd overlap check; a result the guards drop suppresses nothing.
    results.push(...en.casual.parse(masked, ref, { forwardDate: true }));
    results.sort((a, b) => a.index - b.index);
  }

  /** @type {DateHit[]} */
  const hits = [];
  let prevEnd = -1;

  for (const r of results) {
    let nStart = r.index;
    const nEnd = r.index + r.text.length;
    let body = norm.slice(nStart, nEnd);
    let forcedAllDay = false;

    // "Grp 1-20: Tue Oct 6" -> chrono glues the range number in as a "20:" time.
    const glued = /^\d{1,2}:\s+/.exec(body);
    if (glued && nStart > 0 && /\S/.test(norm[nStart - 1])) {
      nStart += glued[0].length;
      body = body.slice(glued[0].length);
      forcedAllDay = true;
    }

    const hasMonth = MONTH_RE.test(body);
    const hasWd = WEEKDAY_RE.test(body);
    const hasRel = REL_RE.test(body);
    const hasIso = ISO_RE.test(body);
    if (!hasMonth && !hasWd && !hasRel && !hasIso) continue;   // "11-26", "7.5"

    const st = r.start;
    const dayC = st.isCertain("day");
    const monC = st.isCertain("month");
    const yrC = st.isCertain("year");
    const wdC = st.isCertain("weekday");
    if (!dayC && !wdC && !hasRel) continue;                    // time-only "at 6pm"

    let hrC = st.isCertain("hour") && !forcedAllDay;
    const monthDay = hasMonth || hasIso;
    const d = st.get("day") ?? 0, mo = st.get("month") ?? 0;
    const y = yrC ? (st.get("year") ?? 0) : monthDay ? inferYear(mo, d, { now, termCode, tz }) : (st.get("year") ?? 0);
    let h = hrC ? meridiemGuess(st.get("hour") ?? 0, st.isCertain("meridiem")) : 0;
    let mi = hrC ? (st.get("minute") ?? 0) : 0;

    let origStart = startOf[nStart] ?? text.length;
    let origEnd = nEnd - 1 >= nStart ? endOf[nEnd - 1] : origStart;
    if (origStart < prevEnd) continue;                         // overlap

    // ---- find the end day: chrono's own r.end, a trailing "- NN" it folded
    // into the start as an hour, or a bare day after the match ("through 27",
    // "& 20", "/8"). The end year always follows the start's resolved year.
    let alternative = false;
    /** @type {string|null} */ let endAt = null;
    /** Exclusive all-day end (midnight after day `ed`); month 13 rolls to January. */
    const endIso = (/** @type {number} */ ey, /** @type {number} */ em, /** @type {number} */ ed) => {
      if (em > 12) { em = 1; ey += 1; }
      else if (Date.UTC(ey, em - 1, ed) < Date.UTC(y, mo - 1, d)) ey += 1;
      return zonedIso(ey, em, ed + 1, 0, 0, tz);
    };
    if (!r.end && monthDay) {
      const tail = /[-\u2013\u2014]\s*(\d{1,2})\s*$/.exec(body);
      if (tail && (!hrC || (st.get("hour") ?? -1) === Number(tail[1]))) {
        // "December 9, 2025 - 12": chrono read the bare end day as a start hour.
        if (hrC) { hrC = false; forcedAllDay = true; h = 0; mi = 0; }
        const last = Number(tail[1]);
        let em = mo;
        if (last <= d) em = mo + 1;
        endAt = endIso(y, em, last);
      } else {
        const win = text.slice(origEnd, origEnd + 40);
        const ex = /^(\s*)([-\u2013\u2014]|through|to|until|&|and|\/)\s*(\d{1,2})(?!\d|:\d{2})/i.exec(win);
        if (ex) {
          const conn = ex[2].toLowerCase();
          const after = win.slice(ex[0].length);
          // "12 students" / "10% penalty" are counts, not end days; "/" is
          // laxer ("Dec 7/8 in E7") so it only rejects a trailing percent.
          const bad = conn === "/" ? /^\s*%/.test(after) : /^\s*[%A-Za-z]/.test(after);
          const last = Number(ex[3]);
          const rolls = /^(?:[-\u2013\u2014]|through|to|until)$/i.test(conn);
          if (!bad && (last > d || rolls)) {
            alternative = conn === "/";
            let em = mo;
            if (last <= d) em = mo + 1;
            endAt = endIso(y, em, last);
            origEnd += ex[0].length;
          }
        }
      }
    } else if (r.end) {
      const ed = r.end.get("day") ?? 0;
      let em = r.end.get("month") ?? mo;
      const endTimed = r.end.isCertain("hour") && !forcedAllDay;
      // A bare end day ("Dec 30 - 2") reports month-certain by inheritance;
      // trust it only when a second month name was actually written.
      if (!endTimed && ed <= d && (body.match(MONTH_G) || []).length < 2) em = mo + 1;
      let ey;
      if (r.end.isCertain("year")) {
        ey = r.end.get("year") ?? y;
        if (em > 12) em = 1;
      } else {
        // year follows the start's, rolling forward when the end reads earlier
        ey = y;
        if (em > 12) { em = 1; ey = y + 1; }
        else if (Date.UTC(y, em - 1, ed) < Date.UTC(y, mo - 1, d)) ey = y + 1;
      }
      endAt = endTimed
        ? zonedIso(ey, em, ed,
            meridiemGuess(r.end.get("hour") ?? 0, r.end.isCertain("meridiem")),
            r.end.get("minute") ?? 0, tz)
        : zonedIso(ey, em, ed + 1, 0, 0, tz);
    }

    // ---- pull in a trailing " (8:30am)" / " (before 11:59pm)" chrono left separate
    if (!hrC) {
      const win = text.slice(origEnd, origEnd + 40);
      const preM = /^[\s(,]*(?:(?:at|by|before|around|until|from)\s+)?/i.exec(win);
      const pre = preM ? preM[0] : "";
      if (pre.length <= 15) {
        const rest = win.slice(pre.length);
        const tm = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/i.exec(rest)
                || /^(\d{1,2}):(\d{2})(?![\d:])/.exec(rest);
        if (tm) {
          h = tm[3] ? toHour(Number(tm[1]), tm[3]) : meridiemGuess(Number(tm[1]), false);
          mi = Number(tm[2] ?? 0);
          hrC = true;
          origEnd += pre.length + tm[0].length;
          if (text[origEnd] === ")") origEnd += 1;
        }
      }
    }

    const startAt = zonedIso(y, mo, d, h, mi, tz);
    const allDay = !hrC;

    let conf = alternative ? 0.6 : monthDay ? 0.8 : 0.55;
    if (hrC) conf += 0.1;
    if (yrC && monthDay) conf += 0.05;
    let mismatch = false;
    if (wdC && monthDay) {
      if ((st.get("weekday") ?? -1) === weekdayOf(y, mo, d)) conf += 0.05;
      else mismatch = true;
    }
    if (mismatch) conf = Math.min(conf, 0.35);
    conf = Math.min(1, Math.round(conf * 100) / 100);

    /** @type {DateHit} */
    const hit = {
      startAt,
      allDay,
      text: text.slice(origStart, origEnd),
      index: origStart,
      confidence: conf,
    };
    if (endAt) hit.endAt = endAt;
    if (mismatch) hit.weekdayMismatch = true;
    hits.push(hit);
    prevEnd = origEnd;
  }
  return hits;
}

/**
 * Outline week-table label: "Week 5: October 5 - 9", "Week 8(Oct 26 - Nov 1)",
 * "Week 3" -> {n, start, end} with inclusive "YYYY-MM-DD" dates, or null.
 * @param {string} text
 * @param {{now?: Date, termCode?: number, tz?: string}} [opts]
 * @returns {{n: number, start: string|null, end: string|null}|null}
 */
export function parseWeekLabel(text, { now = new Date(), termCode, tz = "America/Toronto" } = {}) {
  const m = /^\s*week\s+(\d+)\s*([\s\S]*)$/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  let rest = m[2].trim();
  if (!rest) return { n, start: null, end: null };
  if (rest.startsWith(":")) rest = rest.slice(1).trim();
  else if (rest.startsWith("(")) {
    rest = rest.slice(1);
    const close = rest.lastIndexOf(")");
    if (close >= 0) rest = rest.slice(0, close);
    rest = rest.trim();
  } else return null;
  const hits = extractDates(rest, { now, termCode, tz });
  if (!hits.length) return null;
  const h0 = hits[0];
  const start = dayStr(h0.startAt, tz);
  const end = h0.endAt ? dayStr(new Date(Date.parse(h0.endAt) - 1).toISOString(), tz) : start;
  return { n, start, end };
}
