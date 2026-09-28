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
  DATE_TAIL,
  DIALOG_SEP,
  GCAL,
  LABEL_HINT,
  MONTHS,
  TIME_RANGE,
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
 * A chip's readable label: its aria-label, else the first descendant whose
 * text starts with a time range or "All day", else its own collapsed text.
 * @param {any} el
 */
export function labelOf(el) {
  const aria = el && el.getAttribute ? String(el.getAttribute("aria-label") || "").trim() : "";
  if (aria) return aria;
  for (const d of (el && el.querySelectorAll("*")) || []) {
    const t = textOf(d);
    if (LABEL_HINT.test(t)) return t;
  }
  return textOf(el);
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
 * @returns {{title: string, startAt: string, endAt?: string, allDay: boolean}|null}
 */
export function parseChipLabel(label, { fallbackDate } = {}) {
  const text = String(label || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const segs = text.split(",").map((s) => s.trim()).filter(Boolean);
  if (segs.length < 2) return null;
  const time = TIME_RANGE.exec(segs[0]);
  const allDay = ALLDAY_PREFIX.test(segs[0]);
  if (!time && !allDay) return null;
  const title = String(segs[1] || "").trim().slice(0, 200);
  if (!title) return null;

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
    /** @type {{title: string, startAt: string, endAt?: string, allDay: boolean}} */
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
    const { view, date } = gcalView(u, d);
    const range = rangeFor(view, date);
    const acct = accountEmail(doc); // compare-only: never serialised

    /** @type {GcalEvent[]} */
    const events = [];
    for (const el of doc.querySelectorAll(GCAL.chip) || []) {
      if (el.closest && el.closest(GCAL.dialog)) continue; // popup read below
      const parsed = parseChipLabel(labelOf(el), { now: d, fallbackDate: date });
      if (!parsed) continue;
      events.push({
        ...parsed,
        calendarKind: kindOf(decodeCalId(el.getAttribute("data-eventid")), acct),
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
