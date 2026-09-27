// @ts-check
// Scheduled-events extracts (Discord "N Events" list modal / event detail
// modal) -> contract Items. Pure: the DOM extract in, Items out.
//
// Discord ships event definitions over the gateway, so the network
// recorder never sees them — content.js reads the rendered modal instead
// (see dom.js eventsModalExtract). Everything here works on line text so
// it survives Discord's generated class names.

import { itemId } from "../../core/contract.js";
import { zonedIso, zonedParts } from "../../lib/textdates/index.js";
import { parseLooseTime } from "./time.js";
import { SOURCE, SCOPE } from "./messages.js";
import {
  EVENT_DATE_RE,
  EVENT_RANGE_SEP_RE,
  EVENT_TIME_ONLY_RE,
  EVENT_REPEAT_RE,
  EVENT_SERIES_RE,
  EVENT_CREATED_BY_RE,
  EVENT_LOCATION_RE,
  EVENT_UI_RES,
} from "./selectors.js";

/** @typedef {import("../../core/contract.js").Item} Item */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const SIX_WEEKS_MS = 6 * 7 * DAY_MS;
const DESC_MAX = 300;
const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const WD3 = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
/** "Tue" / "Tuesdays" / "thursday" -> 0–6 (first three letters). */
const weekdayOf = (word) =>
  WD3[String(word || "").toLowerCase().slice(0, 3)];
const MON3 = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
/** "Repeats every Tuesday" — weekday lookup for the captured word. */
const REPEAT_WEEKDAY_RE =
  /\b(mon|tues?|wed|thur?s?|fri|sat|sun)[a-z]*s?\b/i;

const slug = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "event";

const toHMI = (h, mi, ap) => {
  let hh = Number(h);
  const mm = Number(mi || 0);
  const aps = String(ap || "");
  if (/p/i.test(aps) && hh < 12) hh += 12;
  if (/a/i.test(aps) && hh === 12) hh = 0;
  if (hh > 23 || mm > 59) return null;
  return { h: hh, mi: mm };
};

/**
 * Pick the year for a month/day hint. With a weekday present: the year in
 * {now.y-1, now.y, now.y+1} whose date has that weekday, closest to now.
 * Otherwise the year whose date is closest to now inside
 * [now-60d, now+300d] (fall back to plain closest).
 * @returns {number|null}
 */
function inferYear(month, day, weekday, nowMs, tz) {
  const np = zonedParts(new Date(nowMs), tz);
  /** @type {{y: number, ms: number}[]} */
  const cands = [];
  for (const y of [np.y - 1, np.y, np.y + 1]) {
    const ms = Date.UTC(y, month, day);
    const d = new Date(ms);
    if (d.getUTCMonth() !== month) continue; // e.g. Feb 30
    if (weekday != null && d.getUTCDay() !== weekday) continue;
    cands.push({ y, ms });
  }
  if (!cands.length) return null;
  const inWindow = cands.filter(
    (c) => c.ms >= nowMs - 60 * DAY_MS && c.ms <= nowMs + 300 * DAY_MS
  );
  const pool = weekday == null && inWindow.length ? inWindow : cands;
  pool.sort((a, b) => Math.abs(a.ms - nowMs) - Math.abs(b.ms - nowMs));
  return pool[0].y;
}

/**
 * "Tue Sep 29th · 6:00 PM" / "Today at 6:00 PM" /
 * "Tue Sep 29th · 6:00 PM — Thu Oct 1st · 7:00 PM" ->
 * {start:{y,m,d,h,mi}, end:{...}|null} wall-time parts, or null.
 * @param {string} text @param {number} nowMs @param {string} tz
 */
export function parseEventDateLine(text, nowMs, tz) {
  const m = EVENT_DATE_RE.exec(String(text || ""));
  if (!m) return null;
  const weekday = m[1] ? weekdayOf(m[1]) : null;
  /** @type {{y: number, m: number, d: number, h: number, mi: number}|null} */
  let start = null;
  const time = toHMI(m[6], m[7], m[8]);
  if (!time) return null;
  if (m[5]) {
    // today / tomorrow — resolved against Toronto wall time
    const rel = String(m[5]).toLowerCase();
    const p = zonedParts(new Date(nowMs + (rel === "tomorrow" ? DAY_MS : 0)), tz);
    start = { y: p.y, m: p.m, d: p.d, ...time };
  } else {
    const month = MON3[m[2].toLowerCase().slice(0, 3)];
    const day = Number(m[3]);
    let y = m[4] ? Number(m[4]) : inferYear(month, day, weekday, nowMs, tz);
    if (y == null) return null;
    start = { y, m: month + 1, d: day, ...time };
  }
  // Optional range tail: " — Thu Oct 1st · 7:00 PM" or "– 7:00 PM".
  let end = null;
  const rest = String(text).slice(m[0].length);
  const tail = EVENT_RANGE_SEP_RE.test(rest)
    ? rest.replace(EVENT_RANGE_SEP_RE, "")
    : null;
  if (tail) {
    const m2 = EVENT_DATE_RE.exec(tail);
    if (m2) {
      const w2 = m2[1] ? weekdayOf(m2[1]) : null;
      const t2 = toHMI(m2[6], m2[7], m2[8]);
      if (t2) {
        if (m2[5]) {
          const p = zonedParts(
            new Date(
              nowMs + (String(m2[5]).toLowerCase() === "tomorrow" ? DAY_MS : 0)
            ),
            tz
          );
          end = { y: p.y, m: p.m, d: p.d, ...t2 };
        } else {
          const month2 = MON3[m2[2].toLowerCase().slice(0, 3)];
          const day2 = Number(m2[3]);
          const y2 = m2[4]
            ? Number(m2[4])
            : inferYear(month2, day2, w2, nowMs, tz);
          if (y2 != null) end = { y: y2, m: month2 + 1, d: day2, ...t2 };
        }
      }
    } else {
      const t2m = EVENT_TIME_ONLY_RE.exec(tail);
      if (t2m) {
        const t2 = toHMI(t2m[1], t2m[2], t2m[3]);
        if (t2) end = { y: start.y, m: start.m, d: start.d, ...t2 };
      }
    }
  }
  return { start, end };
}

const isUiLine = (t) => EVENT_UI_RES.some((re) => re.test(t));

/**
 * One parsed card/segment -> its classified fields.
 * @param {{lines: {text: string, heading?: boolean, icon?: boolean}[],
 *   interested?: boolean|null, eventRef?: string|null}} card
 * @param {number} nowMs @param {string} tz @param {string} [guildName]
 */
function parseCard(card, nowMs, tz, guildName) {
  /** @type {any[]} */
  const out = [];
  let inSeries = false;
  let cur = null;
  const push = () => {
    if (cur?.start) out.push(cur);
    cur = null;
    inSeries = false;
  };
  for (const line of card.lines || []) {
    const t = String(line.text || "");
    if (!t || EVENT_CREATED_BY_RE.test(t)) continue;
    if (EVENT_SERIES_RE.test(t)) {
      if (cur) inSeries = true;
      continue;
    }
    const d = parseEventDateLine(t, nowMs, tz);
    if (inSeries && cur) {
      if (d) {
        cur.occurrences.push(d.start);
        continue;
      }
      if (isUiLine(t)) continue;
      inSeries = false; // a content line ends the series block
    }
    if (d) {
      push();
      cur = {
        start: d.start,
        end: d.end,
        repeat: null,
        title: null,
        lines: [],
        occurrences: [],
        interested: card.interested ?? null,
        eventRef: card.eventRef ?? null,
      };
      continue;
    }
    const rep = EVENT_REPEAT_RE.exec(t);
    if (rep && cur && !cur.title) {
      cur.repeat = rep[1].trim();
      continue;
    }
    if (isUiLine(t)) continue;
    if (!cur) continue; // dialog header text before the first card
    cur.lines.push({
      text: t,
      heading: line.heading === true,
      icon: line.icon === true,
    });
  }
  push();

  for (const ev of out) {
    // Title: first heading line after the date, else the first line. A
    // repeated title and the guild's own name (detail modal) are dropped
    // from the leftovers.
    const titleLine =
      ev.lines.find((l) => l.heading) || ev.lines[0] || null;
    ev.title = titleLine ? titleLine.text : null;
    const rest = ev.lines.filter(
      (l) =>
        l !== titleLine &&
        l.text !== ev.title &&
        (!guildName || l.text.trim().toLowerCase() !== guildName.trim().toLowerCase())
    );
    // Location: an icon line if present, else the last location-looking line.
    const iconLine = rest.find((l) => l.icon);
    const locLine =
      iconLine || [...rest].reverse().find((l) => EVENT_LOCATION_RE.test(l.text));
    ev.location = locLine ? locLine.text.slice(0, 200) : null;
    const desc = rest
      .filter((l) => l !== locLine)
      .map((l) => l.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, DESC_MAX);
    ev.description = desc || null;
    delete ev.lines;
  }
  return out.filter((ev) => ev.title);
}

/** Local-date key for an occurrence ("2026-09-29") in the extract tz. */
function localDay(iso, tz) {
  const p = zonedParts(new Date(iso), tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/**
 * An events-modal extract -> Items.
 * @param {{modal?: string, guildName?: string, tz?: string,
 *   location?: {guildId?: string}, cards?: any[]}} extract
 * @param {object} o
 * @param {Date|number|string} o.now @param {string} o.nowIso
 * @param {string} [o.guildId] @param {string} [o.team]
 * @param {Iterable<string>} [o.rsvps]  guild_scheduled_event_ids the user
 *   RSVP'd to (REST /users/@me/scheduled-events) — overrides the button.
 * @returns {Item[]}
 */
export function parseEventsExtract(extract, o = {}) {
  const tz = extract?.tz || "America/Toronto";
  const nowMs =
    o.now instanceof Date
      ? o.now.getTime()
      : Number.isFinite(Number(o.now))
        ? Number(o.now)
        : Date.parse(String(o.now)) || Date.now();
  const nowIso = o.nowIso || new Date(nowMs).toISOString();
  const guildId = String(o.guildId ?? extract?.location?.guildId ?? "");
  const team = o.team ?? extract?.guildName;
  const rsvps = new Set([...(o.rsvps || [])].map(String));

  /** @type {any[]} */
  const segments = [];
  for (const card of extract?.cards || []) {
    segments.push(...parseCard(card, nowMs, tz, extract?.guildName));
  }

  /** @type {Item[]} */
  const items = [];
  for (const ev of segments) {
    const eventId = ev.eventRef ? String(ev.eventRef).split("/").pop() : null;
    // The REST RSVP list outranks the (unreliable) button heuristic.
    const interested =
      ev.interested === true || (eventId ? rsvps.has(eventId) : false)
        ? true
        : ev.interested === false
          ? false
          : null;

    const startIso = zonedIso(ev.start.y, ev.start.m, ev.start.d, ev.start.h, ev.start.mi, tz);
    const repeatWd = ev.repeat
      ? weekdayOf(REPEAT_WEEKDAY_RE.exec(ev.repeat)?.[1])
      : null;
    const isSeries = Boolean(ev.repeat) || ev.occurrences.length > 0;

    // End: a repeating event's >24h range end is Discord's series-end date
    // bug — collapse it to a same-day end time.
    let endIso;
    if (ev.end) {
      endIso = zonedIso(ev.end.y, ev.end.m, ev.end.d, ev.end.h, ev.end.mi, tz);
      if (isSeries && Date.parse(endIso) - Date.parse(startIso) > DAY_MS) {
        const sameDay = zonedIso(ev.start.y, ev.start.m, ev.start.d, ev.end.h, ev.end.mi, tz);
        endIso =
          Date.parse(sameDay) > Date.parse(startIso)
            ? sameDay
            : new Date(Date.parse(startIso) + HOUR_MS).toISOString();
      }
    } else {
      endIso = new Date(Date.parse(startIso) + HOUR_MS).toISOString();
    }
    const durationMs = Math.max(Date.parse(endIso) - Date.parse(startIso), 30 * 60 * 1000);

    const seriesSlug = slug(ev.title);
    const url = ev.eventRef
      ? `https://discord.com/${String(ev.eventRef).replace(/^\/+/, "")}`
      : `https://discord.com/channels/${guildId}`;
    const dow = new Date(Date.UTC(ev.start.y, ev.start.m - 1, ev.start.d)).getUTCDay();
    const recurrence = isSeries
      ? {
          freq: "WEEKLY",
          byDay: BYDAY[repeatWd ?? dow],
          time: `${String(ev.start.h).padStart(2, "0")}:${String(ev.start.mi).padStart(2, "0")}`,
          tz: "America/Toronto",
          occurrences: [
            startIso,
            ...ev.occurrences.map((oc) =>
              zonedIso(oc.y, oc.m, oc.d, oc.h, oc.mi, tz)
            ),
          ]
            .filter((v, i, a) => a.indexOf(v) === i)
            .slice(0, 10),
        }
      : undefined;

    const base = {
      source: SOURCE,
      type: "meeting",
      category: "scheduled-event",
      title: ev.title,
      org: team || undefined,
      url,
      location: ev.location || undefined,
      status: "open",
      details: ev.description || undefined,
      evidence: {
        snippet: (ev.description || ev.title || "").slice(0, 300),
        url,
        method: "html",
      },
      meta: {
        guildId: guildId || undefined,
        series: seriesSlug,
        repeat: ev.repeat || undefined,
        interested: interested ?? undefined,
        eventRef: ev.eventRef || undefined,
        recurrence,
      },
    };

    const makeItem = (occIso, generated) => {
      const key = isSeries
        ? `event:${guildId}:${seriesSlug}:${localDay(occIso, tz)}`
        : `event:${guildId}:${seriesSlug}`;
      return {
        ...base,
        id: itemId(SOURCE, key),
        startAt: occIso,
        endAt: new Date(Date.parse(occIso) + durationMs).toISOString(),
        confidence: generated ? "tentative" : "exact",
        review: interested === true ? "auto" : "pending",
        seenIn: [{ source: SOURCE, key, scope: SCOPE, at: nowIso }],
        meta: {
          ...base.meta,
          generated: generated || undefined,
          pendingSeries:
            isSeries && interested !== true ? true : undefined,
        },
      };
    };

    if (!isSeries) {
      items.push(makeItem(startIso, false));
      continue;
    }

    if (interested === true) {
      // Listed occurrences (exact) + generated weekly continuations
      // (tentative) up to 6 weeks past now.
      const listed = [
        startIso,
        ...ev.occurrences.map((oc) => zonedIso(oc.y, oc.m, oc.d, oc.h, oc.mi, tz)),
      ]
        .filter((v, i, a) => a.indexOf(v) === i)
        .sort();
      for (const iso of listed) items.push(makeItem(iso, false));
      // Weekly continuations step in WALL time (a DST switch must not move
      // the local clock time): last listed day + 7, rendered at the
      // anchor's wall time.
      const lp = zonedParts(new Date(Date.parse(listed[listed.length - 1])), tz);
      for (
        let dayMs = Date.UTC(lp.y, lp.m - 1, lp.d) + 7 * DAY_MS;
        ;
        dayMs += 7 * DAY_MS
      ) {
        const dt = new Date(dayMs);
        const iso = zonedIso(
          dt.getUTCFullYear(),
          dt.getUTCMonth() + 1,
          dt.getUTCDate(),
          ev.start.h,
          ev.start.mi,
          tz
        );
        if (Date.parse(iso) > nowMs + SIX_WEEKS_MS) break;
        items.push(makeItem(iso, true));
      }
    } else {
      // Not interested (or unknown): ONE pending item — the next upcoming
      // occurrence — so Review isn't flooded by a series.
      const all = [
        startIso,
        ...ev.occurrences.map((oc) => zonedIso(oc.y, oc.m, oc.d, oc.h, oc.mi, tz)),
      ].sort();
      const next = all.find((iso) => Date.parse(iso) >= nowMs) || all[all.length - 1];
      items.push(makeItem(next, false));
    }
  }
  return items;
}
