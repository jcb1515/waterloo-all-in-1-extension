// @ts-check
/*
  ICS (RFC 5545) calendar reader for the Google Calendar export and the
  user's pasted iCal fallbacks. Line unfolding, then VEVENT only: SUMMARY,
  DTSTART/DTEND/DURATION, RRULE, EXDATE, RECURRENCE-ID, STATUS, UID — no
  DESCRIPTION/LOCATION/ATTENDEE/ORGANIZER is read or kept. RRULEs expand
  in the event's own wall-clock zone so DST keeps the local time, and only
  occurrences overlapping the rolling window are emitted.
*/

import { weekdayOf, zonedIso } from "../../lib/textdates/index.js";

const TORONTO = "America/Toronto";
/** Windows TZIDs seen in real exports; anything unknown falls back too. */
const TZ_ALIASES = {
  "eastern standard time": TORONTO,
  "central standard time": "America/Chicago",
  "mountain standard time": "America/Denver",
  "pacific standard time": "America/Los_Angeles",
};
const DAY2 = /** @type {Record<string, number>} */ ({ SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 });
/** Occurrence-generation bound per event (defensive). */
const MAX_OCCURRENCES = 1000;
const FEED_RE = /waterloo all-in-1/i;

const tzCache = new Map();
/** TZID (IANA or a Windows alias) -> an IANA name; unknown/floating -> Toronto. */
export function tzOf(tzid) {
  const key = String(tzid || "");
  if (!key) return TORONTO;
  const hit = tzCache.get(key);
  if (hit) return hit;
  let tz = TZ_ALIASES[key.toLowerCase()];
  if (!tz) {
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: key });
      tz = key;
    } catch {
      tz = TORONTO;
    }
  }
  tzCache.set(key, tz);
  return tz;
}

/** Continuation lines (leading space/tab) join the previous line. */
function unfold(text) {
  /** @type {string[]} */
  const out = [];
  for (const raw of String(text || "").split(/\r\n|\r|\n/)) {
    if (!raw) continue;
    if ((raw[0] === " " || raw[0] === "\t") && out.length) out[out.length - 1] += raw.slice(1);
    else out.push(raw);
  }
  return out;
}

/** "NAME(;K=V)*:value" — parameter values may repeat (kept comma-joined). */
function propOf(line) {
  const i = line.indexOf(":");
  if (i < 0) return null;
  const segs = line.slice(0, i).split(";");
  const name = segs[0].toUpperCase();
  /** @type {Record<string, string>} */
  const params = {};
  for (const s of segs.slice(1)) {
    const eq = s.indexOf("=");
    if (eq < 0) continue;
    const k = s.slice(0, eq).toUpperCase();
    params[k] = params[k] ? `${params[k]},${s.slice(eq + 1)}` : s.slice(eq + 1);
  }
  return { name, params, value: line.slice(i + 1) };
}

/** ICS text escapes: \n \N -> newline, \, \, \; -> literal, \\ -> backslash. */
const unescapeText = (s) =>
  String(s || "").replace(/\\(.)/g, (_m, c) =>
    c === "n" || c === "N" ? "\n" : c === "\\" ? "\\" : c === ";" ? ";" : c === "," ? "," : c,
  );

/**
 * "20261123" / "20261123T153000" / "…Z" -> parts.
 * @returns {{y:number,m:number,d:number,h:number,mi:number,s:number,utc:boolean,dateOnly:boolean}|null}
 */
function parseDateValue(v) {
  const m = String(v || "").match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  return {
    y: +m[1],
    m: +m[2],
    d: +m[3],
    h: +(m[4] || 0),
    mi: +(m[5] || 0),
    s: +(m[6] || 0),
    utc: !!m[7],
    dateOnly: !m[4],
  };
}

const DUR_RE = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i;
/** @returns {number|null} duration in ms */
function parseDuration(v) {
  const m = String(v || "").match(DUR_RE);
  if (!m) return null;
  const ms =
    ((+m[2] || 0) * 7 * 86400 + (+m[3] || 0) * 86400 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) *
    1000;
  return (m[1] === "-" ? -1 : 1) * ms;
}

/** A parsed DTSTART/DTEND/EXDATE/RECURRENCE-ID property. */
const dtProp = (p) => {
  const dt = parseDateValue(p.value.trim());
  return dt ? { dt, tzid: p.params.TZID, valueType: p.params.VALUE } : null;
};

/**
 * The instant a date property denotes: `Z` -> UTC, VALUE=DATE/bare date ->
 * an all-day Toronto midnight, TZID -> that zone, floating -> Toronto.
 * @returns {{iso: string, tz: string, allDay: boolean}}
 */
function startInfo(dp) {
  const dt = dp.dt;
  if (dt.utc) {
    return {
      iso: new Date(Date.UTC(dt.y, dt.m - 1, dt.d, dt.h, dt.mi, dt.s)).toISOString(),
      tz: "UTC",
      allDay: false,
    };
  }
  if (String(dp.valueType || "").toUpperCase() === "DATE" || dt.dateOnly) {
    return { iso: zonedIso(dt.y, dt.m, dt.d, 0, 0, TORONTO), tz: TORONTO, allDay: true };
  }
  const tz = tzOf(dp.tzid);
  return { iso: zonedIso(dt.y, dt.m, dt.d, dt.h, dt.mi, tz), tz, allDay: false };
}

const dim = (/** @type {number} */ y, /** @type {number} */ m) =>
  new Date(Date.UTC(y, m, 0)).getUTCDate();
const addUtc = (/** @type {any} */ date, /** @type {number} */ n) => {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const cmpDate = (/** @type {any} */ a, /** @type {any} */ b) =>
  Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d);
const mondayOf = (/** @type {any} */ date) =>
  addUtc(date, -((weekdayOf(date.y, date.m, date.d) + 6) % 7));

/** "2TU" / "-1FR" / "MO" -> {ord, dow} list. */
function parseByday(v) {
  /** @type {{ord: number|null, dow: number}[]} */
  const out = [];
  for (const tok of String(v || "").split(",")) {
    const m = tok.trim().match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/i);
    if (!m) continue;
    out.push({ ord: m[1] ? +m[1] : null, dow: DAY2[m[2].toUpperCase()] });
  }
  return out;
}

/** Sorted day-of-month list for each weekday in (y, m). */
function monthDows(/** @type {number} */ y, /** @type {number} */ m) {
  /** @type {Record<number, number[]>} */
  const map = {};
  for (let d = 1; d <= dim(y, m); d++) {
    const w = weekdayOf(y, m, d);
    (map[w] = map[w] || []).push(d);
  }
  return map;
}

/**
 * A month's candidate days for MONTHLY/YEARLY rules: BYMONTHDAY (negative =
 * from the end), else BYDAY (ordinal or every), else the start's day when
 * the month has one.
 */
function monthDays(/** @type {any} */ rule, /** @type {number} */ y, /** @type {number} */ m, /** @type {number} */ fallbackD) {
  const out = new Set();
  if (rule.BYMONTHDAY) {
    for (const tok of String(rule.BYMONTHDAY).split(",")) {
      let dd = Number(tok.trim());
      if (!dd) continue;
      if (dd < 0) dd = dim(y, m) + 1 + dd;
      if (dd >= 1 && dd <= dim(y, m)) out.add(dd);
    }
  } else if (rule.BYDAY) {
    const dows = monthDows(y, m);
    for (const ent of parseByday(rule.BYDAY)) {
      const list = dows[ent.dow] || [];
      if (ent.ord == null) for (const dd of list) out.add(dd);
      else {
        const dd = ent.ord > 0 ? list[ent.ord - 1] : list[list.length + ent.ord];
        if (dd != null) out.add(dd);
      }
    }
  } else if (fallbackD <= dim(y, m)) {
    out.add(fallbackD);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Candidate occurrence days of an RRULE, chronological, starting at
 * `start`. WKST defaults to Monday (weekly) and INTERVAL to 1.
 * @param {Record<string, string>} rule
 * @param {{y:number,m:number,d:number}} start
 */
function* rruleDays(rule, start) {
  const interval = Math.max(1, Number(rule.INTERVAL) || 1);
  const freq = String(rule.FREQ || "").toUpperCase();
  if (freq === "DAILY") {
    for (let i = 0; ; i += interval) yield addUtc(start, i);
  } else if (freq === "WEEKLY") {
    const dows = (rule.BYDAY
      ? parseByday(rule.BYDAY).map((e) => e.dow)
      : [weekdayOf(start.y, start.m, start.d)]
    ).sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    const wk0 = mondayOf(start);
    for (let w = 0; ; w += interval) {
      const wk = addUtc(wk0, w * 7);
      for (const dow of dows) {
        const day = addUtc(wk, (dow + 6) % 7);
        if (cmpDate(day, start) >= 0) yield day;
      }
    }
  } else if (freq === "MONTHLY") {
    for (let k = 0; ; k += interval) {
      const t = new Date(Date.UTC(start.y, start.m - 1 + k, 1));
      const y = t.getUTCFullYear();
      const m = t.getUTCMonth() + 1;
      for (const d of monthDays(rule, y, m, start.d)) {
        const day = { y, m, d };
        if (cmpDate(day, start) >= 0) yield day;
      }
    }
  } else if (freq === "YEARLY") {
    const months = rule.BYMONTH
      ? String(rule.BYMONTH).split(",").map(Number).sort((a, b) => a - b)
      : [start.m];
    for (let k = 0; ; k += interval) {
      const y = start.y + k;
      for (const m of months) {
        if (m < 1 || m > 12) continue;
        for (const d of monthDays(rule, y, m, start.d)) {
          const day = { y, m, d };
          if (cmpDate(day, start) >= 0) yield day;
        }
      }
    }
  }
}

/** UNTIL value -> the last ms an occurrence may start at. */
function untilOf(v, tz) {
  const dt = parseDateValue(String(v || "").trim());
  if (!dt) return null;
  if (dt.dateOnly) return Date.UTC(dt.y, dt.m - 1, dt.d) + 86400e3 - 1;
  if (dt.utc) return Date.UTC(dt.y, dt.m - 1, dt.d, dt.h, dt.mi, dt.s);
  return Date.parse(zonedIso(dt.y, dt.m, dt.d, dt.h, dt.mi, tz)) + dt.s * 1000;
}

/** One VEVENT's kept fields. */
function buildEvent(props) {
  const ev = /** @type {any} */ ({
    uid: "",
    summary: "",
    dtstart: null,
    dtend: null,
    durationMs: null,
    rrule: null,
    /** @type {any[]} */
    exdates: [],
    status: null,
    recurrenceId: null,
  });
  for (const p of props) {
    switch (p.name) {
      case "UID":
        ev.uid = p.value.trim();
        break;
      case "SUMMARY":
        ev.summary = unescapeText(p.value).replace(/\s+/g, " ").trim().slice(0, 200);
        break;
      case "STATUS":
        ev.status = p.value.trim().toUpperCase();
        break;
      case "DTSTART":
        ev.dtstart = dtProp(p);
        break;
      case "DTEND":
        ev.dtend = dtProp(p);
        break;
      case "DURATION":
        ev.durationMs = parseDuration(p.value);
        break;
      case "RRULE": {
        /** @type {Record<string, string>} */
        const r = {};
        for (const kv of p.value.split(";")) {
          const eq = kv.indexOf("=");
          if (eq > 0) r[kv.slice(0, eq).toUpperCase()] = kv.slice(eq + 1);
        }
        ev.rrule = r;
        break;
      }
      case "EXDATE":
        for (const v of p.value.split(",")) {
          const dt = parseDateValue(v.trim());
          if (dt) ev.exdates.push({ dt, tzid: p.params.TZID, valueType: p.params.VALUE });
        }
        break;
      case "RECURRENCE-ID":
        ev.recurrenceId = dtProp(p);
        break;
    }
  }
  return ev;
}

/** An occurrence replaced/cancelled by a RECURRENCE-ID event. */
function overrideOccurrence(ovr, master, masterInfo) {
  const s = ovr.dtstart ? startInfo(ovr.dtstart) : null;
  if (!s) return null;
  const ms = Date.parse(s.iso);
  const endMs = ovr.dtend ? Date.parse(startInfo(ovr.dtend).iso) : NaN;
  const durMs =
    Number.isFinite(endMs) && endMs > ms ? endMs - ms : (ovr.durationMs ?? master.durationMs) || null;
  return {
    title: ovr.summary || master.summary,
    startAt: s.iso,
    endAt: durMs ? new Date(ms + durMs).toISOString() : undefined,
    allDay: s.allDay,
    _ms: ms,
    _endMs: durMs ? ms + durMs : s.allDay ? ms + 86400e3 : ms,
  };
}

/**
 * Parse one VCALENDAR. `wa1` flags the Waterloo All-in-1 feed itself so the
 * caller can drop it (our own events must never suppress our own items).
 * @param {string} text
 * @param {{now?: Date, pastMs?: number, futureMs?: number}} [opts]
 */
export function parseIcs(text, opts = {}) {
  const now = opts.now || new Date();
  const w0 = now.getTime() - (opts.pastMs != null ? opts.pastMs : 7 * 86400e3);
  const w1 = now.getTime() + (opts.futureMs != null ? opts.futureMs : 120 * 86400e3);

  /** @type {string|null} */
  let name = null;
  /** @type {string|null} */
  let prodid = null;
  /** @type {any[][]} */
  const vevents = [];
  /** @type {any[]|null} */
  let cur = null;
  for (const line of unfold(text)) {
    const p = propOf(line);
    if (!p) continue;
    if (p.name === "BEGIN") {
      if (/^VEVENT$/i.test(p.value.trim())) cur = [];
      continue;
    }
    if (p.name === "END") {
      if (/^VEVENT$/i.test(p.value.trim()) && cur) {
        vevents.push(cur);
        cur = null;
      }
      continue;
    }
    if (cur) {
      cur.push(p);
      continue;
    }
    if (p.name === "X-WR-CALNAME") name = unescapeText(p.value).trim();
    else if (p.name === "PRODID") prodid = p.value.trim();
  }

  /** @type {any[]} */
  const masters = [];
  /** uid -> recurrence-slot ms -> override event */
  const overrides = new Map();
  for (const props of vevents) {
    const ev = buildEvent(props);
    if (!ev.dtstart || !ev.summary) continue;
    if (ev.recurrenceId) {
      const slot = Date.parse(startInfo(ev.recurrenceId).iso);
      let byUid = overrides.get(ev.uid);
      if (!byUid) overrides.set(ev.uid, (byUid = new Map()));
      byUid.set(slot, ev);
    } else {
      masters.push(ev);
    }
  }

  /** @type {any[]} */
  const events = [];
  for (const m of masters) {
    if (m.status === "CANCELLED") continue;
    const s = startInfo(m.dtstart);
    const startMs = Date.parse(s.iso);
    const endMs = m.dtend ? Date.parse(startInfo(m.dtend).iso) : NaN;
    const durMs = Number.isFinite(endMs) && endMs > startMs ? endMs - startMs : m.durationMs;
    const sd = m.dtstart.dt;
    const inst = (/** @type {any} */ day) =>
      s.allDay
        ? zonedIso(day.y, day.m, day.d, 0, 0, TORONTO)
        : s.tz === "UTC"
          ? new Date(Date.UTC(day.y, day.m - 1, day.d, sd.h, sd.mi, sd.s)).toISOString()
          : zonedIso(day.y, day.m, day.d, sd.h, sd.mi, s.tz);

    // Occurrence slots (instants), chronological, bounded.
    /** @type {{ms: number, iso: string}[]} */
    let slots = [{ ms: startMs, iso: s.iso }];
    if (m.rrule) {
      slots = [];
      const untilMs = m.rrule.UNTIL ? untilOf(m.rrule.UNTIL, s.tz) : null;
      const count = Math.min(Number(m.rrule.COUNT) || MAX_OCCURRENCES, MAX_OCCURRENCES);
      const seen = new Set();
      for (const day of rruleDays(m.rrule, { y: sd.y, m: sd.m, d: sd.d })) {
        if (slots.length >= count) break;
        const iso = inst(day);
        const ms = Date.parse(iso);
        if (untilMs != null && ms > untilMs) break;
        if (ms > w1) break; // chronological — later slots can't overlap either
        if (seen.has(ms)) continue;
        seen.add(ms);
        slots.push({ ms, iso });
      }
    }

    const exset = new Set(m.exdates.map((x) => Date.parse(startInfo(x).iso)));
    const ovMap = overrides.get(m.uid);
    const matched = new Set();
    /** @type {any[]} */
    const occs = [];
    for (const o of slots) {
      if (exset.has(o.ms)) continue;
      const ovr = ovMap && ovMap.get(o.ms);
      if (ovr) {
        matched.add(o.ms);
        if (ovr.status === "CANCELLED") continue;
        occs.push(overrideOccurrence(ovr, m, s));
      } else {
        occs.push({
          title: m.summary,
          startAt: o.iso,
          endAt: durMs ? new Date(o.ms + durMs).toISOString() : undefined,
          allDay: s.allDay,
          _ms: o.ms,
          _endMs: durMs ? o.ms + durMs : s.allDay ? o.ms + 86400e3 : o.ms,
        });
      }
    }
    // A RECURRENCE-ID whose slot wasn't generated (out of window, past the
    // cap) still counts when its own start lands in the window.
    for (const [slot, ovr] of ovMap || []) {
      if (matched.has(slot) || ovr.status === "CANCELLED") continue;
      occs.push(overrideOccurrence(ovr, m, s));
    }
    for (const o of occs) {
      if (!o || !(o._ms < w1 && o._endMs >= w0)) continue;
      const ev = { title: o.title, startAt: o.startAt, allDay: o.allDay, calendarKind: "own" };
      if (o.endAt) ev.endAt = o.endAt;
      events.push(ev);
    }
  }

  return { name, prodid, wa1: FEED_RE.test(`${name || ""} ${prodid || ""}`), events };
}
