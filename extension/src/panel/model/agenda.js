// @ts-check
/*
  Pure agenda model for the side panel. buildAgenda() reduces the merged
  `items` map + `userState` into grouped, sorted rows; rowView() formats one
  row (times, countdowns, late and moved labels). No DOM, no chrome.* — the
  unit tests drive this directly.
*/

import { normCourseCode } from "../../core/contract.js";

const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const COUNTDOWN_MS = 3 * HOUR;
const DONE_RECENT_MS = 7 * DAY;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* ------------------------------- date helpers ------------------------------ */

/** @param {Date|number|string} d */
export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** "12:30 PM" / "1:20 PM" — drops the minutes' leading zero, keeps AM/PM. */
export function fmtTime(d) {
  const x = new Date(d);
  let h = x.getHours();
  const m = String(x.getMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

/** "Sat, Sep 26" */
export function fmtDay(d) {
  const x = new Date(d);
  return `${WEEKDAYS[x.getDay()]}, ${MONTHS[x.getMonth()]} ${x.getDate()}`;
}

/** "Saturday, September 26" */
export function fmtLongDay(d) {
  const x = new Date(d);
  const wd = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][x.getDay()];
  const mo = [
    "January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December",
  ][x.getMonth()];
  return `${wd}, ${mo} ${x.getDate()}`;
}

/** Same AM/PM: "12:30–1:20 PM"; otherwise "11:30 AM–1:20 PM". */
export function fmtRange(a, b) {
  const sa = new Date(a);
  const sb = new Date(b);
  const sameHalf = (sa.getHours() < 12) === (sb.getHours() < 12);
  let h = sa.getHours();
  const m = String(sa.getMinutes()).padStart(2, "0");
  const aStr = sameHalf ? `${h % 12 || 12}:${m}` : fmtTime(sa);
  return `${aStr}–${fmtTime(sb)}`;
}

/** "in 45m" / "in 2h 10m" — null unless 0 < ms < 3h. */
export function fmtCountdown(ms) {
  if (ms <= 0 || ms >= COUNTDOWN_MS) return null;
  const mins = Math.floor(ms / MIN);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `in ${m}m`;
  return m ? `in ${h}h ${m}m` : `in ${h}h`;
}

/** "just now"/"45m late"/"5h late"/"2d late" for a past anchor. */
export function fmtLate(ms) {
  if (ms < MIN) return "just now";
  if (ms >= DAY) return `${Math.round(ms / DAY)}d late`;
  const mins = Math.floor(ms / MIN);
  if (mins < 60) return `${mins}m late`;
  return `${Math.floor(mins / 60)}h late`;
}

/** "4m ago" / "2h ago" / "3d ago" / "Sep 20" */
export function fmtAgo(iso, now) {
  const t = new Date(iso).getTime();
  const ms = now.getTime() - t;
  if (ms < MIN) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MIN)}m ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`;
  if (ms < 7 * DAY) return `${Math.floor(ms / DAY)}d ago`;
  return fmtDay(iso);
}

/* ------------------------------- item shaping ------------------------------ */

const anchor = (/** @type {any} */ item) => item.dueAt || item.startAt || null;

/** class, tutorial, or a lab that has a start time (a session, not a deliverable). */
const isClassish = (/** @type {any} */ i) =>
  i.type === "class" || i.type === "tutorial" || (i.type === "lab" && !!i.startAt);

const doneState = (/** @type {any} */ item, /** @type {any} */ us) =>
  !!(us && us.done) || item.status === "done" || item.status === "submitted";

/**
 * @param {any} item
 * @param {any} us
 * @param {Date} now
 */
function visible(item, us, now) {
  if (!item || item.type === "term-date") return false;
  if (item.status === "cancelled") return false;
  if (item.review === "pending" || item.review === "dismissed") return false;
  if (us) {
    if (us.hidden) return false;
    if (us.snoozedUntil && Date.parse(us.snoozedUntil) > now.getTime()) return false;
  }
  return true;
}

/**
 * @param {any} item
 * @param {string} filter "all"|"deadlines"|"classes"|"exams"|"meetings"|"coop"
 */
function inFilter(item, filter) {
  switch (filter) {
    case "deadlines":
      return (
        item.type === "deadline" || item.type === "quiz" || item.type === "presentation" ||
        item.type === "task" || (item.type === "lab" && !!item.dueAt)
      );
    case "classes":
      return isClassish(item);
    case "exams":
      return item.type === "exam";
    case "meetings":
      return item.type === "meeting" || item.type === "event";
    case "coop":
      return (
        item.type === "interview" || item.type === "application-deadline" ||
        item.type === "offer-deadline" || item.type === "cycle-date"
      );
    default:
      return true;
  }
}

/* --------------------------------- row view --------------------------------- */

/**
 * Display strings for one row.
 * @param {any} item
 * @param {Date} now
 */
export function rowView(item, now) {
  const a = anchor(item);
  const aMs = a ? Date.parse(a) : NaN;
  const isTimed = !!item.startAt;
  const rangeLabel =
    isTimed && item.endAt ? fmtRange(item.startAt, item.endAt) : isTimed ? fmtTime(item.startAt) : null;
  const timeLabel = a ? (item.allDay ? "All day" : rangeLabel || fmtTime(a)) : null;
  const countdown = Number.isNaN(aMs) ? null : fmtCountdown(aMs - now.getTime());
  const lateLabel =
    item.dueAt && !Number.isNaN(aMs) && aMs < now.getTime() ? fmtLate(now.getTime() - aMs) : null;
  const statusLabel =
    item.status === "submitted" ? "Submitted" : item.status === "done" ? "Done" : null;
  const movedFrom = item.moved && item.moved.from ? fmtDay(item.moved.from) : null;
  return { anchor: a, anchorMs: aMs, timeLabel, rangeLabel, countdown, lateLabel, statusLabel, movedFrom };
}

/* --------------------------------- buildAgenda ------------------------------ */

/**
 * @param {Object} p
 * @param {Record<string, any>} p.items       merged items map
 * @param {Record<string, any>} p.userState
 * @param {any} p.settings                    wa1Settings (agenda.showClasses)
 * @param {Date} p.now
 * @param {string} [p.filter]                 "all"|deadlines|classes|exams|meetings|coop
 * @param {string|null} [p.org]               restrict to one org (normalised compare)
 * @param {string} [p.q]                      free-text match on title/org/location
 * @returns {{summary: any, nextClass: any, groups: any[]}}
 */
export function buildAgenda({ items = {}, userState = {}, settings = {}, now, filter = "all", org = null, q = "" }) {
  const today = startOfDay(now);
  const tomorrow = new Date(today.getTime() + DAY);
  const dayAfter = new Date(today.getTime() + 2 * DAY);
  // Week runs Sun–Sat: the week's last day starts (6 - dow) days after today.
  const dow = today.getDay();
  const weekEnd = new Date(today.getTime() + (7 - dow) * DAY); // Sun of next week
  const nextWeekEnd = new Date(weekEnd.getTime() + 7 * DAY);
  const next7End = new Date(today.getTime() + 7 * DAY);

  const showClasses = (settings.agenda && settings.agenda.showClasses) || "today";
  const normOrg = org ? normCourseCode(org) : null;
  const needle = q.trim().toLowerCase();

  const buckets = new Map(); // groupId -> rows
  const push = (id, item) => {
    const rows = buckets.get(id) || [];
    rows.push(item);
    buckets.set(id, rows);
  };

  /** @type {any[]} */
  const doneRecent = [];
  let overdueCount = 0;
  let dueToday = 0;
  let dueWeek = 0;
  /** @type {any} */
  let nextClass = null;
  const nextClassLimit = tomorrow.getTime() + DAY;

  const sorted = Object.values(items)
    .filter((it) => it && anchor(it))
    .sort((a, b) => Date.parse(anchor(a)) - Date.parse(anchor(b)));

  for (const item of /** @type {any[]} */ (sorted)) {
    const us = userState[item.id];
    if (!visible(item, us, now)) continue;

    if (doneState(item, us)) {
      const doneAt = us && us.doneAt ? Date.parse(us.doneAt) : null;
      if (doneAt === null || now.getTime() - doneAt <= DONE_RECENT_MS) doneRecent.push(item);
      continue;
    }

    if (normOrg && normCourseCode(item.org) !== normOrg) continue;
    if (
      needle &&
      !`${item.title} ${item.org || ""} ${item.location || ""}`.toLowerCase().includes(needle)
    )
      continue;
    if (!inFilter(item, filter)) continue;
    if (filter !== "classes" && isClassish(item)) {
      if (showClasses === "none") continue;
      if (showClasses === "today") {
        const aMs = Date.parse(anchor(item));
        if (aMs < today.getTime() || aMs >= dayAfter.getTime()) continue;
      }
    }
    if (filter === "classes") {
      const aMs = Date.parse(anchor(item));
      if (aMs >= next7End.getTime()) continue;
    }

    const aMs = Date.parse(anchor(item));
    const classish = isClassish(item);

    // "Next class" — the next classish item later today or tomorrow.
    if (
      classish && item.startAt && aMs > now.getTime() && aMs < nextClassLimit &&
      (!nextClass || aMs < Date.parse(anchor(nextClass)))
    ) {
      nextClass = item;
    }

    // Counts ignore classish rows (they're sessions, not work due).
    if (!classish) {
      if (aMs < today.getTime()) overdueCount++;
      else if (aMs < tomorrow.getTime()) dueToday++;
      if (aMs >= today.getTime() && aMs < weekEnd.getTime()) dueWeek++;
    }

    if (aMs < today.getTime()) push("overdue", item);
    else if (aMs < tomorrow.getTime()) push("today", item);
    else if (aMs < dayAfter.getTime()) push("tomorrow", item);
    else if (aMs < weekEnd.getTime()) push(`day:${new Date(aMs).toDateString()}`, item);
    else if (aMs < nextWeekEnd.getTime()) push("next-week", item);
    else push("later", item);
  }

  /** @type {any[]} */
  const groups = [];
  const emit = (id, label, opts = {}) => {
    const rows = buckets.get(id) || [];
    if (!rows.length && !opts.always) return;
    groups.push({
      id,
      label,
      count: rows.length,
      collapsedByDefault: !!opts.collapsed,
      tone: opts.tone || null,
      rows,
    });
  };

  emit("overdue", "Overdue", { tone: "danger" });
  emit("today", "Today");
  emit("tomorrow", "Tomorrow");

  // The rest of this week, one group per day.
  for (let t = dayAfter.getTime(); t < weekEnd.getTime(); t += DAY) {
    const key = `day:${new Date(t).toDateString()}`;
    const rows = buckets.get(key);
    if (rows && rows.length) {
      groups.push({ id: key, label: fmtDay(t), count: rows.length, collapsedByDefault: false, rows });
    }
  }

  emit("next-week", "Next week");
  emit("later", "Later", { collapsed: true });

  if (doneRecent.length) {
    doneRecent.sort((a, b) => {
      const da = userState[a.id] && userState[a.id].doneAt;
      const db = userState[b.id] && userState[b.id].doneAt;
      return (db ? Date.parse(db) : 0) - (da ? Date.parse(da) : 0);
    });
    groups.push({
      id: "done",
      label: "Done recently",
      count: doneRecent.length,
      collapsedByDefault: true,
      rows: doneRecent,
      done: true,
    });
  }

  return {
    summary: {
      dateLabel: fmtLongDay(now),
      dueToday,
      dueWeek,
      overdue: overdueCount,
    },
    nextClass: nextClass
      ? {
          id: nextClass.id,
          org: nextClass.org || "",
          label: nextClass.title,
          rangeLabel:
            nextClass.endAt ? fmtRange(nextClass.startAt, nextClass.endAt) : fmtTime(nextClass.startAt),
          location: nextClass.location || "",
          startAt: nextClass.startAt,
        }
      : null,
    groups,
  };
}
