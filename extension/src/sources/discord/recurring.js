// @ts-check
// Recurring-meeting detection: enough same-key/same-slot meeting candidates
// (or an explicit "every Tuesday at 6pm" line) yield one pending suggestion
// item. Pure; the adapter feeds it state.meetingLog.

import { itemId } from "../../core/contract.js";
import { zonedIso, zonedParts } from "../../lib/textdates/index.js";
import { SOURCE, SCOPE } from "./messages.js";

/** @typedef {import("../../core/contract.js").Item} Item */

const TZ = "America/Toronto";
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = [
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
];
const DAY3 = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** "weekly sync" / "Sync!" / "sync at 6pm Oct 3" -> "sync". */
const KEY_STOPWORDS = new Set([
  "the", "a", "an", "at", "on", "in", "of", "for", "to", "and", "this",
  "next", "our", "every", "each", "weekly",
]);
const MONTHS = [
  "january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december",
];
const KEY_DATE_WORDS = new Set([
  ...WEEKDAYS.map((w) => w.slice(0, 3)),
  ...WEEKDAYS,
  ...MONTHS.map((w) => w.slice(0, 3)),
  ...MONTHS,
]);

/**
 * Stable per-meeting key: lowercase, digits/dates/punctuation stripped,
 * stopwords removed, first 4 remaining words.
 * @param {string} title
 */
export function meetingKey(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !/\d/.test(w) && !KEY_STOPWORDS.has(w) && !KEY_DATE_WORDS.has(w))
    .slice(0, 4)
    .join(" ");
}

const TIME_RES = [
  /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i,
  /\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?\b/i,
  /\b(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)\b/i,
];

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

const EVERY_DAY_RE = new RegExp(
  `\\b(?:every|each)\\s+(${WEEKDAYS.join("|")})s?\\b`,
  "i"
);
const PLURAL_DAY_RE = new RegExp(
  `\\b(${WEEKDAYS.map((w) => w + "s").join("|")})\\b`,
  "i"
);

/**
 * "every Tuesday at 6pm" / "we meet Thursdays 6:30" -> {weekday, h, mi}.
 * Requires BOTH a weekly weekday phrase and a time.
 * @param {string} text  stripped message text
 */
export function textWeeklyHint(text) {
  const s = String(text || "");
  const day = EVERY_DAY_RE.exec(s) || PLURAL_DAY_RE.exec(s);
  if (!day) return null;
  const time = parseLooseTime(s);
  if (!time) return null;
  return { weekday: WEEKDAYS.indexOf(day[1].replace(/s$/, "").toLowerCase()), ...time };
}

/** ISO week id (year*100+week) of a Toronto wall date — week buckets. */
function isoWeekId(y, m, d) {
  // Thursday of this week defines the ISO week/year.
  const utc = new Date(Date.UTC(y, m - 1, d));
  const dow = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + (4 - dow));
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.floor((utc.getTime() - yearStart.getTime()) / (7 * DAY_MS)) + 1;
  return utc.getUTCFullYear() * 100 + week;
}

/**
 * Next Toronto wall occurrence of weekday/h:mi at or after `now`.
 * @param {number} nowMs @param {number} weekday 0=Sun @param {number} h @param {number} mi
 */
export function nextOccurrence(nowMs, weekday, h, mi) {
  for (let add = 0; add < 8; add++) {
    const p = zonedParts(new Date(nowMs + add * DAY_MS), TZ);
    if (p.weekday !== weekday) continue;
    const iso = zonedIso(p.y, p.m, p.d, h, mi, TZ);
    if (Date.parse(iso) >= nowMs) return iso;
  }
  return null;
}

const slug = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "weekly";

/**
 * meetingLog -> weekly-meeting suggestion items.
 * Log entry shapes:
 *   occurrence: {guildId, channelId, key, startAt, endAt?, url, at}
 *   text hint:  {guildId, channelId, key, url, at, fromText: true,
 *                weekday, hhmm: "HH:MM"}
 * A group with occurrences in >= 2 distinct Toronto ISO weeks (or any
 * fromText hint) produces one suggestion.
 * @param {any[]} meetingLog
 * @param {{nowMs: number, nowIso: string, teamOf?: (guildId: string) => string|undefined}} o
 * @returns {Item[]}
 */
export function recurringSuggestions(meetingLog, o) {
  /** @type {Map<string, {guildId: string, channelId: string, key: string,
   *  weekday: number, h: number, mi: number, weeks: Set<number>,
   *  durations: number[], occurrences: string[], url?: string,
   *  fromText: boolean}>} */
  const groups = new Map();
  for (const e of meetingLog || []) {
    if (!e) continue;
    let weekday, h, mi;
    if (e.fromText) {
      weekday = Number(e.weekday);
      [h, mi] = String(e.hhmm || "").split(":").map(Number);
      if (!Number.isInteger(weekday) || !Number.isFinite(h)) continue;
    } else {
      const ms = Date.parse(e.startAt || "");
      if (!Number.isFinite(ms)) continue;
      const p = zonedParts(new Date(ms), TZ);
      weekday = p.weekday;
      h = p.h;
      mi = p.mi;
    }
    const gkey = `${e.guildId || "?"}|${e.key}|${weekday}|${h}:${mi}`;
    let g = groups.get(gkey);
    if (!g) {
      g = {
        guildId: e.guildId, channelId: e.channelId, key: e.key || "meeting",
        weekday, h, mi, weeks: new Set(), durations: [],
        occurrences: [], url: undefined, fromText: false,
      };
      groups.set(gkey, g);
    }
    if (e.fromText) {
      g.fromText = true;
    } else {
      const p = zonedParts(new Date(e.startAt), TZ);
      g.weeks.add(isoWeekId(p.y, p.m, p.d));
      g.occurrences.push(e.startAt);
      const dur = Date.parse(e.endAt || "") - Date.parse(e.startAt || "");
      if (Number.isFinite(dur) && dur > 0) g.durations.push(dur);
    }
    if (e.url) g.url = e.url;
  }

  /** @type {Item[]} */
  const items = [];
  for (const g of groups.values()) {
    if (!g.fromText && g.weeks.size < 2) continue;
    const startAt = nextOccurrence(o.nowMs, g.weekday, g.h, g.mi);
    if (!startAt) continue;
    const dur = g.durations.length
      ? g.durations.sort((a, b) => a - b)[Math.floor(g.durations.length / 2)]
      : 60 * 60 * 1000;
    const key = `recurring:${g.guildId || "unknown"}:${slug(g.key)}:${DAY3[g.weekday]}-${String(g.h).padStart(2, "0")}${String(g.mi).padStart(2, "0")}`;
    const titleKey = g.key ? g.key[0].toUpperCase() + g.key.slice(1) : "Meeting";
    items.push({
      id: itemId(SOURCE, key),
      source: SOURCE,
      type: "meeting",
      category: "recurring",
      title: `${titleKey} (weekly)`,
      org: o.teamOf ? o.teamOf(g.guildId) : undefined,
      startAt,
      endAt: new Date(Date.parse(startAt) + dur).toISOString(),
      url: g.url || undefined,
      status: "open",
      confidence: "tentative",
      review: "pending",
      seenIn: [{ source: SOURCE, key, scope: SCOPE, at: o.nowIso }],
      meta: {
        guildId: g.guildId,
        channelId: g.channelId,
        recurrence: {
          freq: "WEEKLY",
          byDay: BYDAY[g.weekday],
          time: `${String(g.h).padStart(2, "0")}:${String(g.mi).padStart(2, "0")}`,
          tz: TZ,
          weeks: g.weeks.size,
          fromText: g.fromText || undefined,
          occurrences: g.occurrences.slice(-10),
        },
      },
    });
  }
  return items;
}
