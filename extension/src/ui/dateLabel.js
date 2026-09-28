// @ts-check
// Compact date blocks for list rows. The invariant this module exists for:
// **a time is never rendered without its date** outside a day-group header.
// `dateBlockFor` only produces a `time` when it has produced a `date`, and
// `dateBlockText` is the only way the model turns into a string.
// Pure: safe to test in Node.

import { fmtWeekdayShort, fmtShortDate, fmtTime, fmtDate } from "../core/dates.js";

// One time formatter for every UI surface ("7:00 PM"). core/dates.js is the
// implementation; this module is the UI-facing surface.
export { fmtTime, fmtDate };

/**
 * "Tue Sep 29 · 7:00 PM" — a date always accompanies the time.
 * @param {any} d
 */
export function fmtDateTime(d) {
  return `${fmtDate(d)} · ${fmtTime(d)}`;
}

// Types that are always key events (exams, interviews, deadlines) — the
// things a student must not miss.
export const KEY_TYPES = new Set(["exam", "interview", "deadline"]);

/**
 * One key-event rule for the whole UI: a type in KEY_TYPES, or anything with
 * a `dueAt` (deadlines, offer/application/ranking deadlines, assignment
 * dues). Classes, meetings and events with only a startAt are not key.
 * @param {any} item
 * @returns {boolean}
 */
export function isKeyEvent(item) {
  if (!item) return false;
  return KEY_TYPES.has(item.type) || !!item.dueAt;
}

/**
 * The instant a row is about: startAt for timed things, dueAt otherwise.
 * @param {any} item
 * @returns {string | null}
 */
export function itemAnchor(item) {
  if (!item) return null;
  return item.startAt || item.dueAt || null;
}

/** "Thu Oct 8" — compact date with weekday, no comma. @param {any} d */
export function fmtCompactDay(d) {
  const x = new Date(d);
  return `${fmtWeekdayShort(x)} ${fmtShortDate(x)}`;
}

/**
 * Date-block model for an item.
 *  - dated, timed:  {date: "Thu Oct 8", time: "7:00 pm"}
 *  - dated, all-day:{date: "Thu Oct 8", time: null}
 *  - undated:       null
 * Key-event types (exam/interview/deadline) additionally carry the room.
 * `time` is always null when the date cannot be computed — no bare times.
 * @param {any} item
 * @returns {{key: boolean, allDay: boolean, date: string, time: string | null, room: string | null} | null}
 */
export function dateBlockFor(item) {
  const a = itemAnchor(item);
  if (!a) return null;
  // Date-only anchors ("2026-10-13") would parse as UTC midnight — the evening
  // before in Toronto. Anchor them at local noon instead.
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(a) ? `${a}T12:00:00` : a);
  if (Number.isNaN(t)) return null;
  const key = isKeyEvent(item);
  const allDay = !!item.allDay;
  return {
    key,
    allDay,
    date: fmtCompactDay(t),
    time: allDay ? null : fmtTime(t),
    room: key && item.location ? String(item.location) : null,
  };
}

/**
 * Render a block to text: "Thu Oct 8 · 7:00 pm" or "Thu Oct 8".
 * @param {ReturnType<typeof dateBlockFor>} b
 */
export function dateBlockText(b) {
  if (!b) return "";
  let s = b.date;
  if (b.time) s += ` · ${b.time}`;
  if (b.room) s += ` · ${b.room}`;
  return s;
}
