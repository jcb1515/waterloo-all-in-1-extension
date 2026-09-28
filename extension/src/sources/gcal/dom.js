// @ts-check
/*
  Pure DOM readers for calendar.google.com — produce a normalised event list
  for duplicate suppression. Every selector is a best guess (see
  selectors.js and README "needs tuning"); a miss just yields fewer events.
  No fetch, no chrome, no storage. Only title/startAt/endAt/allDay/
  calendarKind leave this module — never descriptions, guests, locations,
  owners, response status or calendar ids.
*/

import { extractDates, weekdayOf, zonedIso, zonedParts } from "../../lib/textdates/index.js";
import { accountEmail, textWithBreaks } from "../email/dom.js";
import {
  ALLDAY_PREFIX,
  CALENDAR_SEG,
  COLUMN_HEADER_RE,
  DATE_TAIL,
  DIALOG_SEP,
  GCAL,
  LABEL_HINT,
  MONTHS,
  POINT_HEAD,
  SPAN_HEAD,
  TIME_RANGE,
  TITLE_DAY,
  TITLE_MONTH,
  TITLE_WEEK,
} from "./selectors.js";

/**
 * @typedef {Object} GcalEvent
 * @property {string} title
 * @property {string} startAt     ISO instant (Toronto wall times)
 * @property {string} [endAt]     ISO; for all-day ranges, exclusive midnight after the last day
 * @property {boolean} allDay
 * @property {"own"|"subscribed"|"unknown"} calendarKind
 */

/** @type {Record<string, number>} */
export const KIND_RANK = { own: 0, subscribed: 1, unknown: 2 };

const textOf = (el) => String((el && el.textContent) || "").replace(/\s+/g, " ").trim();
const DAY3 = /** @type {Record<string, number>} */ ({ sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 });
const toHour = (h, mer) => (h % 12) + (/p/i.test(String(mer || "")) ? 12 : 0);
const monthOf = (name) =>
  MONTHS.findIndex((n) => n.startsWith(String(name || "").toLowerCase())) + 1;

/** Calendar-date shift by n days (UTC date math; returns {y,m,d}). */
const shiftDay = (date, n) => {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};

/* --------------------------- view and range --------------------------- */

/**
 * The path form is /calendar/u/<n>/r/<view>/<y>/<m>/<d>. A missing date
 * means today (per `now`, Toronto-side).
 * @param {URL} u @param {Date} now
 * @returns {{view: string, date: {y: number, m: number, d: number}}}
 */
export function gcalView(u, now) {
  const segs = u.pathname.split("/").filter(Boolean);
  const i = segs.indexOf("r");
  const word = i >= 0 ? String(segs[i + 1] || "").toLowerCase() : "";
  const view =
    { day: "day", week: "week", customweek: "week", month: "month", agenda: "schedule" }[word] ||
    "other";
  let date = zonedParts(now);
  const [y, m, d] = [segs[i + 2], segs[i + 3], segs[i + 4]];
  if (
    i >= 0 &&
    /^\d{4}$/.test(y || "") &&
    /^\d{1,2}$/.test(m || "") &&
    /^\d{1,2}$/.test(d || "")
  ) {
    date = { ...date, y: +y, m: +m, d: +d };
  }
  return { view, date: { y: date.y, m: date.m, d: date.d } };
}

/**
 * The rendered view from the DOM: a top-level `[data-viewkey]` in ALL-CAPS
 * ("WEEK"…). View-switcher menuitems carry the attr in lowercase and are
 * ignored; `null` when no marker is present.
 * @param {any} doc
 */
function viewFromDom(doc) {
  const map = {
    day: "day",
    week: "week",
    custom_days: "week",
    customweek: "week",
    month: "month",
    agenda: "schedule",
    schedule: "schedule",
  };
  for (const el of doc.querySelectorAll(GCAL.viewKey) || []) {
    const v = String(el.getAttribute("data-viewkey") || "");
    if (!v || v !== v.toUpperCase()) continue; // menuitems are lowercase
    const k = v.toLowerCase();
    if (map[k]) return map[k];
  }
  return null;
}

/** The focal date named by document.title, when it carries one. */
function titleDate(doc) {
  const t = String((doc && doc.title) || "");
  if (!t) return null;
  /** @type {RegExpMatchArray|null} */
  let m = t.match(TITLE_WEEK) || t.match(TITLE_DAY);
  if (m && monthOf(m[1])) return { y: +m[3], m: monthOf(m[1]), d: +m[2] };
  m = t.match(TITLE_MONTH);
  if (m && monthOf(m[1])) return { y: +m[2], m: monthOf(m[1]), d: 1 };
  return null;
}

/**
 * A "Sun27" column header resolved to a real date: the nearest day to
 * `anchor` (±20 days) whose weekday AND day-of-month both match.
 * @param {[string, string]} head
 * @param {{y:number,m:number,d:number}} anchor
 */
function resolveHeader([dowName, dom], anchor) {
  const dow = DAY3[dowName.slice(0, 3).toLowerCase()];
  const domN = +dom;
  if (dow == null) return null;
  /** @type {{y:number,m:number,d:number}|null} */
  let best = null;
  let bestDist = 21;
  for (let off = -20; off <= 20; off++) {
    const c = shiftDay(anchor, off);
    if (c.d !== domN) continue;
    if (weekdayOf(c.y, c.m, c.d) !== dow) continue;
    if (Math.abs(off) < bestDist) {
      best = c;
      bestDist = Math.abs(off);
    }
  }
  return best;
}

/**
 * The visible range from the DOM: day-cell [data-date] stamps inside the
 * column view first, then the day-number column headers resolved against
 * the title/URL anchor. `null` when neither is present.
 */
function rangeFromDom(doc, view, anchor) {
  if (view !== "day" && view !== "week" && view !== "month") return null;
  const col = doc.querySelector(GCAL.columnView);
  if (col) {
    const days = [...col.querySelectorAll(GCAL.dayStamp)]
      .map((e) => e.getAttribute("data-date"))
      .filter(Boolean)
      .sort();
    if (days.length) {
      const f = (s) => ({ y: +s.slice(0, 4), m: +s.slice(4, 6), d: +s.slice(6, 8) });
      const a = f(days[0]);
      const b = shiftDay(f(days[days.length - 1]), 1);
      return { start: zonedIso(a.y, a.m, a.d, 0, 0), end: zonedIso(b.y, b.m, b.d, 0, 0) };
    }
  }
  if (view === "month") return null; // month headers carry no day numbers
  const heads = /** @type {RegExpMatchArray[]} */ (
    [...doc.querySelectorAll(GCAL.columnHeader)]
      .map((h) => String(h.textContent || "").trim().match(COLUMN_HEADER_RE))
      .filter(Boolean)
  );
  if (!heads.length) return null;
  const start = resolveHeader(/** @type {[string, string]} */ ([heads[0][1], heads[0][2]]), anchor);
  if (!start) return null;
  const end = shiftDay(start, heads.length);
  return {
    start: zonedIso(start.y, start.m, start.d, 0, 0),
    end: zonedIso(end.y, end.m, end.d, 0, 0),
  };
}

/**
 * The visible days as half-open [start, end) ISO instants at Toronto
 * midnights — used by the adapter for delete detection, so an empty
 * visible week still carries a range.
 * @param {string} view @param {{y:number,m:number,d:number}} date
 * @returns {{start: string, end: string}|null}
 */
function rangeFor(view, date) {
  if (view === "day") {
    const e = shiftDay(date, 1);
    return { start: zonedIso(date.y, date.m, date.d, 0, 0), end: zonedIso(e.y, e.m, e.d, 0, 0) };
  }
  if (view === "week") {
    const s = shiftDay(date, -weekdayOf(date.y, date.m, date.d));
    const e = shiftDay(s, 7);
    return { start: zonedIso(s.y, s.m, s.d, 0, 0), end: zonedIso(e.y, e.m, e.d, 0, 0) };
  }
  if (view === "month") {
    const first = { y: date.y, m: date.m, d: 1 };
    const s = shiftDay(first, -weekdayOf(first.y, first.m, first.d));
    const e = shiftDay(s, 42);
    return { start: zonedIso(s.y, s.m, s.d, 0, 0), end: zonedIso(e.y, e.m, e.d, 0, 0) };
  }
  return null; // schedule/other — never deletes
}

/* --------------------------- data-eventid --------------------------- */

/**
 * data-eventid is base64 "<eventId> <calendarId>" (url-safe tolerant,
 * padding optional). Returns the calendarId, "" when undecodable/absent.
 * @param {string} raw
 */
export function decodeCalId(raw) {
  try {
    let b64 = String(raw || "").trim().replace(/-/g, "+").replace(/_/g, "/");
    if (!b64) return "";
    b64 += "=".repeat((4 - (b64.length % 4)) % 4);
    const dec = atob(b64);
    const tok = dec.trim().split(/\s+/).pop() || "";
    return tok.includes("@") ? tok : "";
  } catch {
    return "";
  }
}

/**
 * "own" = the user's primary calendar (the signed-in address, or a writable
 * @group.calendar.google.com calendar); "subscribed" = read-only feeds
 * (@import — including our own feed subscription —, holidays @group.v,
 * other people's calendars); "unknown" otherwise. `account` is compared
 * only and never returned. A calendarId ending in "@m" is the "@gmail.com"
 * shorthand.
 * @param {string} calId @param {string} account
 * @returns {"own"|"subscribed"|"unknown"}
 */
export function kindOf(calId, account) {
  const id = String(calId || "").toLowerCase();
  if (!id) return "unknown";
  const full = id.endsWith("@m") ? `${id.slice(0, -2)}@gmail.com` : id;
  if (account && full === String(account).toLowerCase()) return "own";
  if (full.endsWith("@group.v.calendar.google.com")) return "subscribed";
  if (full.endsWith("@group.calendar.google.com")) return "own";
  if (full.endsWith("@import.calendar.google.com")) return "subscribed";
  if (full.includes("@")) return "subscribed";
  return "unknown";
}

/* ----------------------------- chip labels ----------------------------- */

/**
 * A chip's readable label: its aria-label, else the descendant leaf whose
 * text is the visually-hidden description (starts with a month-date, a
 * time range or "All day" — prefer one that also carries a year, which is
 * what the real description leaf looks like), else its own collapsed text.
 * @param {any} el
 */
export function labelOf(el) {
  const aria = el && el.getAttribute ? String(el.getAttribute("aria-label") || "").trim() : "";
  if (aria) return aria;
  /** @type {string|null} */
  let hinted = null;
  for (const d of (el && el.querySelectorAll("*")) || []) {
    const t = textOf(d);
    if (!t || !LABEL_HINT.test(t)) continue;
    if (/(19|20)\d{2}\b/.test(t)) return t; // the description leaf has a year
    if (hinted == null) hinted = t;
  }
  return hinted || textOf(el);
}

/**
 * Parse a chip label into {title, startAt, endAt?, allDay} — no
 * calendarKind (that comes from the element's data-eventid). Supported
 * shapes (comma-separated segments):
 *   "1pm to 1:30pm, <title>, …, September 29, 2026"
 *   "All day, <title>, …, October 12, 2026"
 *   "All day, <title>, …, September 28 – October 2, 2026"   (end exclusive)
 *   "All day, <title>, …, October 5 – 9, 2026"
 * The title is the first segment after the prefix, so titles containing a
 * comma are truncated at that comma (accepted). Middle segments (owner,
 * response, location) are discarded. No date segment → `fallbackDate`
 * (the URL date). No time and no "All day" → null.
 * @param {string} label
 * @param {{now?: Date, fallbackDate?: {y:number,m:number,d:number}}} [opts]
 * @returns {{title: string, startAt: string, endAt?: string, allDay: boolean, calendar?: string}|null}
 */
export function parseChipLabel(label, { fallbackDate } = {}) {
  const text = String(label || "").replace(/\s+/g, " ").trim();
  if (!text) return null;

  /** First comma-segment after the when-part: the title (✓ marker dropped). */
  const titleAfter = (rest) =>
    (rest.split(",")[1] || "").trim().replace(/^✓\s*/, "").slice(0, 200);
  /** Any "Calendar: <name>" middle segment (names a non-primary calendar). */
  const calOf = (rest) => {
    const seg = rest.split(",").map((s) => s.trim()).find((s) => CALENDAR_SEG.test(s));
    return seg ? seg.replace(CALENDAR_SEG, "").trim() : undefined;
  };

  // A) "September 8, 2026 at 8am to December 23, 2026 at 11:59pm" — a span
  //    whose start date lives in the head (comma-splitting is unsafe there).
  const sp = SPAN_HEAD.exec(text);
  if (sp) {
    const rest = text.slice(sp[0].length);
    const title = titleAfter(rest);
    if (!title) return null;
    const y1 = +sp[3], mo1 = monthOf(sp[1]), d1 = +sp[2];
    const h1 = toHour(+sp[4], sp[6]), mi1 = +(sp[5] || 0);
    const startAt = zonedIso(y1, mo1, d1, h1, mi1);
    const calendar = calOf(rest);
    if (sp[8]) {
      // Full second leg: "<Month> <D>, <YYYY> at <time>".
      const y2 = +sp[10], mo2 = monthOf(sp[8]), d2 = +sp[9];
      const h2 = toHour(+sp[11], sp[13]), mi2 = +(sp[12] || 0);
      const endAt = zonedIso(y2, mo2, d2, h2, mi2);
      // "Sep 27 at 12am to Sep 28 at 12am" is an all-day event.
      if (h1 === 0 && mi1 === 0 && h2 === 0 && mi2 === 0)
        return { title, startAt, endAt, allDay: true, calendar };
      return { title, startAt, endAt, allDay: false, calendar };
    }
    // Time-only second leg ("… to 11pm") — same day, overnight rolls.
    const tm = String(sp[7]).match(/(\d{1,2})(?::(\d{2}))?\s*([ap])/i);
    if (!tm) return null;
    let endAt = zonedIso(y1, mo1, d1, toHour(+tm[1], tm[3]), +(tm[2] || 0));
    if (Date.parse(endAt) <= Date.parse(startAt)) {
      const nx = shiftDay({ y: y1, m: mo1, d: d1 }, 1);
      endAt = zonedIso(nx.y, nx.m, nx.d, toHour(+tm[1], tm[3]), +(tm[2] || 0));
    }
    return { title, startAt, endAt, allDay: false, calendar };
  }

  // B) "September 27, 2026 at 12:59am" — a single point in time.
  const pt = POINT_HEAD.exec(text);
  if (pt) {
    const rest = text.slice(pt[0].length);
    const title = titleAfter(rest);
    if (!title) return null;
    const startAt = zonedIso(+pt[3], monthOf(pt[1]), +pt[2], toHour(+pt[4], pt[6]), +(pt[5] || 0));
    return { title, startAt, allDay: false, calendar: calOf(rest) };
  }

  const segs = text.split(",").map((s) => s.trim()).filter(Boolean);
  if (segs.length < 2) return null;
  const time = TIME_RANGE.exec(segs[0]);
  const allDay = ALLDAY_PREFIX.test(segs[0]);
  if (!time && !allDay) return null;
  const title = String(segs[1] || "").trim().replace(/^✓\s*/, "").slice(0, 200);
  if (!title) return null;
  const calendar = calOf(text.slice(segs[0].length));

  let y = 0, m = 0, d = 0, m2 = 0, d2 = 0;
  const dm = DATE_TAIL.exec(text);
  if (dm) {
    y = +dm[5];
    m = monthOf(dm[1]);
    d = +dm[2];
    if (dm[4]) {
      m2 = dm[3] ? monthOf(dm[3]) : m;
      d2 = +dm[4];
    }
    if (!m || !m2 && dm[3]) return null;
  } else if (fallbackDate && fallbackDate.y) {
    ({ y, m, d } = fallbackDate);
  } else {
    return null;
  }

  if (allDay) {
    /** @type {{title: string, startAt: string, endAt?: string, allDay: boolean, calendar?: string}} */
    const ev = { title, startAt: zonedIso(y, m, d, 0, 0), allDay: true };
    if (d2) {
      // Range end is the midnight after the last day (exclusive); a
      // smaller end month/day rolls forward until it is after the start.
      let ey = y, em = m2 || m;
      while (Date.UTC(ey, em - 1, d2) <= Date.UTC(y, m - 1, d)) {
        em += 1;
        if (em > 12) { em = 1; ey += 1; }
      }
      ev.endAt = zonedIso(ey, em, d2 + 1, 0, 0);
    }
    return ev;
  }

  if (!time) return null; // guaranteed by the guard above; keeps narrowing happy
  const sh = toHour(+time[1], time[3]);
  const eh = toHour(+time[4], time[6]);
  const startAt = zonedIso(y, m, d, sh, +(time[2] || 0));
  let endAt = zonedIso(y, m, d, eh, +(time[5] || 0));
  if (Date.parse(endAt) <= Date.parse(startAt)) {
    const nx = shiftDay({ y, m, d }, 1); // "10pm to 1am" ends tomorrow
    endAt = zonedIso(nx.y, nx.m, nx.d, eh, +(time[5] || 0));
  }
  return { title, startAt, endAt, allDay: false };
}

/* ----------------------------- detail popup ----------------------------- */

/**
 * An open event detail popup: a [role="dialog"] with a heading plus a
 * when-line like "Tuesday, September 29 ⋅ 1:00 – 1:30pm" (⋅/· normalised,
 * then textdates now-relative). calendarKind comes from the dialog's own
 * [data-eventid] when present.
 * @param {any} dialog @param {Date} now @param {string} account
 * @returns {GcalEvent|null}
 */
export function popupEvent(dialog, now, account) {
  try {
    const title = textOf(dialog.querySelector(GCAL.heading)).slice(0, 200);
    if (!title) return null;
    const lines = textWithBreaks(dialog)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    for (const line of lines) {
      if (!/\d/.test(line)) continue;
      /** @type {import("../../core/contract.js").DateHit[]} */
      let hits = [];
      try {
        hits = extractDates(line.replace(DIALOG_SEP, " "), { now });
      } catch {
        continue;
      }
      const hit = hits.find((h) => h.confidence >= 0.5) || hits[0];
      if (!hit) continue;
      const idAttr =
        (dialog.getAttribute && dialog.getAttribute("data-eventid")) ||
        (dialog.querySelector(GCAL.chip) &&
          dialog.querySelector(GCAL.chip).getAttribute("data-eventid")) ||
        "";
      /** @type {GcalEvent} */
      const ev = {
        title,
        startAt: hit.startAt,
        allDay: !!hit.allDay,
        calendarKind: kindOf(decodeCalId(idAttr), account),
      };
      if (hit.endAt) ev.endAt = hit.endAt;
      return ev;
    }
  } catch {
    /* a hostile dialog yields nothing */
  }
  return null;
}

/* ------------------------------ dedupe ------------------------------ */

/**
 * Dedupe by lowercase title + startAt; when duplicates meet, the better
 * calendarKind wins (own > subscribed > unknown).
 * @param {GcalEvent[]} events
 */
export function dedupeEvents(events) {
  /** @type {Map<string, GcalEvent>} */
  const map = new Map();
  for (const e of events) {
    if (!e) continue;
    const k = `${String(e.title || "").toLowerCase()}|${e.startAt}`;
    const prev = map.get(k);
    if (!prev || KIND_RANK[e.calendarKind] < KIND_RANK[prev.calendarKind]) map.set(k, e);
  }
  return [...map.values()];
}

/* ------------------------------ extract ------------------------------ */

/**
 * @param {any} doc   a DOM Document (linkedom or real)
 * @param {string} href
 * @param {{now?: Date}} [opts]
 * @returns {{v: 1, view: string, range: {start: string, end: string}|null, events: GcalEvent[]}}
 */
export function gcalExtract(doc, href, { now } = {}) {
  try {
    const d = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
    const u = new URL(String(href || ""));
    if (u.hostname !== "calendar.google.com" || !doc || typeof doc.querySelectorAll !== "function") {
      return { v: 1, view: "other", range: null, events: [] };
    }
    // DOM first (the URL often has no view or date): the grid's viewkey,
    // then the visible columns' date stamps / headers, then the title.
    const { view: urlView, date: urlDate } = gcalView(u, d);
    const view = viewFromDom(doc) || urlView;
    const anchor = titleDate(doc) || urlDate;
    const range = rangeFromDom(doc, view, anchor) || rangeFor(view, anchor);
    const fallbackDate = range
      ? ((p) => ({ y: p.y, m: p.m, d: p.d }))(zonedParts(new Date(range.start)))
      : anchor;
    const acct = accountEmail(doc); // compare-only: never serialised

    /** @type {GcalEvent[]} */
    const events = [];
    for (const el of doc.querySelectorAll(GCAL.chip) || []) {
      if (el.closest && el.closest(GCAL.dialog)) continue; // popup read below
      const parsed = parseChipLabel(labelOf(el), { now: d, fallbackDate });
      if (!parsed) continue;
      const { calendar, ...rest } = parsed;
      const kind = kindOf(decodeCalId(el.getAttribute("data-eventid")), acct);
      events.push({
        ...rest,
        // A "Calendar: <name>" segment marks a named calendar; subscribed
        // unless the event id already proved it one of the user's own.
        calendarKind: kind === "own" || !calendar ? kind : "subscribed",
      });
    }
    for (const dlg of doc.querySelectorAll(GCAL.dialog) || []) {
      const ev = popupEvent(dlg, d, acct);
      if (ev) events.push(ev);
    }
    return { v: 1, view, range, events: dedupeEvents(events) };
  } catch {
    return { v: 1, view: "other", range: null, events: [] };
  }
}
