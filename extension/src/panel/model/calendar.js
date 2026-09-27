// @ts-check
/*
  Pure week/month calendar model over effective items. All day bucketing is in
  America/Toronto (via textdates' zoned helpers) so DST weeks — e.g. the
  fall-back week containing Nov 1 2026 — produce seven real Toronto days.
*/

import { zonedParts, zonedIso, weekdayOf } from "../../lib/textdates/index.js";
import { effectiveItem, isVisible } from "../../core/effective.js";
import { findClashes } from "../../core/clashes.js";

const TZ = "America/Toronto";
const MIN = 60000;
const DEFAULT_START_HOUR = 8;
const DEFAULT_END_HOUR = 22;
/** Minimum rendered block height, in minutes. */
const MIN_BLOCK_MIN = 20;

const TIMED_TYPES = new Set([
  "class",
  "tutorial",
  "lab",
  "exam",
  "meeting",
  "interview",
  "event",
  "presentation",
]);
/** class/tutorial plus labs with a start time — hidden by "Show classes". */
const isClassish = (/** @type {any} */ i) =>
  i.type === "class" || i.type === "tutorial" || (i.type === "lab" && !!i.startAt);

/**
 * Workload-heat bucket for a day's summed due weight:
 * 0 = none, 1 = 1–9, 2 = 10–24, 3 = 25+.
 * @param {number} weight
 */
export function heatBucket(weight) {
  if (!weight || weight <= 0) return 0;
  if (weight < 10) return 1;
  if (weight < 25) return 2;
  return 3;
}

/**
 * Short label for a calendar block/pill too narrow for the full org+title:
 * course orgs split into subject + catalog ("MATH" over "117"); anything
 * else takes the org's (or title's) first word.
 * @param {any} item
 * @returns {{sub: string, main: string}}
 */
export function shortLabel(item) {
  const org = String((item && item.org) || "").trim();
  const m = /^([A-Za-z]{2,6})\s*([0-9]+[A-Za-z]*)$/.exec(org);
  if (m) return { sub: m[1].toUpperCase(), main: m[2].toUpperCase() };
  const word = (org || String((item && item.title) || "")).trim().split(/\s+/)[0] || "";
  return { sub: "", main: word };
}

/** Toronto "YYYY-MM-DD" for an instant. */
export function dayKeyOf(ms) {
  const p = zonedParts(new Date(ms), TZ);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** Minutes since Toronto midnight for an instant (handles DST-safe via parts). */
function minuteOfDay(ms) {
  const p = zonedParts(new Date(ms), TZ);
  return p.h * 60 + p.mi;
}

/**
 * The Monday (Toronto midnight) of the week containing `d`.
 * @param {Date|number|string} d
 * @returns {number} ms
 */
export function weekStartOf(d) {
  const p = zonedParts(new Date(d), TZ);
  const dow = weekdayOf(p.y, p.m, p.d); // 0=Sun
  const back = (dow + 6) % 7; // days since Monday
  return Date.parse(zonedIso(p.y, p.m, p.d - back, 0, 0, TZ));
}

/**
 * Toronto midnights for the 7 days starting at weekStartMs, as ms instants
 * (DST-aware: each is recomputed, never +86400000).
 */
function weekDayStarts(weekStartMs) {
  const p = zonedParts(new Date(weekStartMs), TZ);
  const out = [];
  for (let i = 0; i < 8; i++) {
    out.push(Date.parse(zonedIso(p.y, p.m, p.d + i, 0, 0, TZ)));
  }
  return out; // [0..6] starts, [7] = next week's start
}

/**
 * Assign display columns to overlapping timed entries within one day.
 * @param {{s: number, e: number, item: any}[]} evs  sorted by start
 */
function layoutColumns(evs) {
  /** @type {any[][]} clusters */
  const clusters = [];
  let cur = [];
  let curEnd = -1;
  for (const ev of evs) {
    if (cur.length && ev.s >= curEnd) {
      clusters.push(cur);
      cur = [];
      curEnd = -1;
    }
    cur.push(ev);
    curEnd = Math.max(curEnd, ev.e);
  }
  if (cur.length) clusters.push(cur);
  for (const cl of clusters) {
    /** @type {number[]} col end-times */
    const colEnds = [];
    for (const ev of cl) {
      let c = colEnds.findIndex((end) => end <= ev.s);
      if (c === -1) {
        c = colEnds.length;
        colEnds.push(ev.e);
      } else {
        colEnds[c] = ev.e;
      }
      ev.col = c;
    }
    for (const ev of cl) ev.cols = colEnds.length;
  }
}

/**
 * @param {Record<string, any>} items
 * @param {Record<string, any>} userState
 * @param {any} settings
 * @param {number} weekStartMs  a Toronto-midnight Monday (see weekStartOf)
 * @param {Date} now
 * @param {{showClasses?: boolean}} [opts]
 */
export function weekModel(items, userState, settings, weekStartMs, now, opts = {}) {
  const acceptPending = !!(settings && settings.review && settings.review.showPending);
  const showClasses = opts.showClasses !== false;
  const starts = weekDayStarts(weekStartMs);
  const nowMs = now.getTime();

  const clashIds = new Set();
  let maxSeverity = new Map();
  for (const c of findClashes(items, userState, now, { horizonDays: 14, acceptPending })) {
    if (c.kind !== "overlap") continue;
    for (const id of c.itemIds) {
      clashIds.add(id);
      if (c.severity === "severe") maxSeverity.set(id, "severe");
    }
  }

  /** @type {any[]} */
  const days = starts.slice(0, 7).map((ms, i) => ({
    date: dayKeyOf(ms),
    startMs: ms,
    endMs: starts[i + 1],
    today: nowMs >= ms && nowMs < starts[i + 1],
    due: [],
    timed: [],
    dueWeight: 0,
    heat: 0,
    classCount: 0,
  }));

  const accept = (/** @type {any} */ eff) => {
    if (!eff || eff.status === "cancelled") return false;
    return isVisible(eff, nowMs);
  };

  for (const raw of Object.values(items || {})) {
    if (!raw || !raw.id) continue;
    const eff = effectiveItem(raw, (userState || {})[raw.id], { acceptPending });
    if (!accept(eff)) continue;

    // Due strip / heat: deadlines and anything with dueAt.
    const dueMs = eff.dueAt ? Date.parse(eff.dueAt) : NaN;
    if (!Number.isNaN(dueMs)) {
      const di = starts.findIndex((s, i) => i < 7 && dueMs >= s && dueMs < starts[i + 1]);
      if (di !== -1) {
        days[di].due.push(eff);
        if (typeof eff.weight === "number" && eff.status === "open") {
          days[di].dueWeight += eff.weight;
        }
      }
    }

    // Timed blocks.
    const sMs = eff.startAt ? Date.parse(eff.startAt) : NaN;
    if (!Number.isNaN(sMs) && TIMED_TYPES.has(eff.type)) {
      const di = starts.findIndex((s, i) => i < 7 && sMs >= s && sMs < starts[i + 1]);
      if (di !== -1) {
        if (isClassish(eff)) days[di].classCount++;
        if (showClasses || !isClassish(eff)) {
          const eMs = eff.endAt ? Date.parse(eff.endAt) : sMs + 60 * MIN;
          days[di].timed.push({
            item: eff,
            s: sMs,
            e: Math.max(eMs, sMs + MIN * 15),
            startMin: minuteOfDay(sMs),
            endMin: minuteOfDay(Math.max(eMs, sMs + MIN * 15)),
            clash: clashIds.has(eff.id),
            severe: maxSeverity.get(eff.id) === "severe",
          });
        }
      }
    }
  }

  // Hour range: 8–22 by default, extended to cover the earliest/latest block.
  let startHour = DEFAULT_START_HOUR;
  let endHour = DEFAULT_END_HOUR;
  for (const day of days) {
    day.due.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
    day.heat = heatBucket(day.dueWeight);
    day.timed.sort((a, b) => a.s - b.s || a.e - b.e);
    layoutColumns(day.timed);
    for (const ev of day.timed) {
      startHour = Math.min(startHour, Math.floor(ev.startMin / 60));
      endHour = Math.max(endHour, Math.ceil(ev.endMin / 60));
    }
  }

  // Convert to grid positions (minutes from range start).
  const rangeMin = (endHour - startHour) * 60;
  for (const day of days) {
    for (const ev of day.timed) {
      ev.top = Math.max(0, ev.startMin - startHour * 60);
      ev.height = Math.max(MIN_BLOCK_MIN, Math.min(ev.endMin, endHour * 60) - ev.startMin);
    }
  }

  return { days, range: { startHour, endHour, minutes: rangeMin }, weekStart: starts[0] };
}

/**
 * The 6x7 (Mon-first) grid covering the month containing `anchor`.
 * @param {Record<string, any>} items
 * @param {Record<string, any>} userState
 * @param {any} settings
 * @param {Date|number} anchor   any day inside the month to show
 * @param {Date} now
 */
export function monthModel(items, userState, settings, anchor, now) {
  const acceptPending = !!(settings && settings.review && settings.review.showPending);
  const pa = zonedParts(new Date(anchor), TZ);
  const firstMs = Date.parse(zonedIso(pa.y, pa.m, 1, 0, 0, TZ));
  const firstDow = weekdayOf(pa.y, pa.m, 1);
  const gridStartMs = Date.parse(zonedIso(pa.y, pa.m, 1 - ((firstDow + 6) % 7), 0, 0, TZ));
  const gs = zonedParts(new Date(gridStartMs), TZ);

  const cells = [];
  for (let i = 0; i < 42; i++) {
    const ms = Date.parse(zonedIso(gs.y, gs.m, gs.d + i, 0, 0, TZ));
    const nextMs = Date.parse(zonedIso(gs.y, gs.m, gs.d + i + 1, 0, 0, TZ));
    const p = zonedParts(new Date(ms), TZ);
    cells.push({
      date: dayKeyOf(ms),
      day: p.d,
      startMs: ms,
      endMs: nextMs,
      inMonth: p.m === pa.m,
      today: dayKeyOf(now.getTime()) === dayKeyOf(ms),
      markers: [],
      items: [],
      more: 0,
      classCount: 0,
      dueWeight: 0,
      heat: 0,
    });
  }

  for (const raw of Object.values(items || {})) {
    if (!raw || !raw.id) continue;
    const eff = effectiveItem(raw, (userState || {})[raw.id], { acceptPending });
    if (!eff || eff.status === "cancelled" || !isVisible(eff, now)) continue;
    const a = eff.dueAt || eff.startAt;
    if (!a) continue;
    const aMs = Date.parse(a);
    const cell = cells.find((c) => aMs >= c.startMs && aMs < c.endMs);
    if (!cell) continue;
    cell.items.push(eff);
    if (isClassish(eff) && eff.startAt) {
      cell.classCount++;
      continue; // classes are a count, not markers
    }
    cell.markers.push(eff);
    if (eff.dueAt && typeof eff.weight === "number" && eff.status === "open") {
      cell.dueWeight += eff.weight;
    }
  }

  for (const cell of cells) {
    cell.items.sort(
      (a, b) => Date.parse(a.dueAt || a.startAt) - Date.parse(b.dueAt || b.startAt)
    );
    cell.markers.sort(
      (a, b) =>
        Date.parse(a.startAt || a.dueAt) - Date.parse(b.startAt || b.dueAt)
    );
    if (cell.markers.length > 3) {
      cell.more = cell.markers.length - 3;
      cell.markers = cell.markers.slice(0, 3);
    }
    cell.heat = heatBucket(cell.dueWeight);
  }

  return { cells, month: pa.m, year: pa.y, gridStart: gridStartMs };
}
