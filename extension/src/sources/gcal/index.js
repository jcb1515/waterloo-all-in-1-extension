// @ts-check
/*
  Google Calendar adapter — duplicate suppression only (no Items). T1 reads
  the account's exporticalzip (a zip of the user's OWN calendars) through
  ctx.fetch in the service worker — the same URL is 403 from a page tab —
  expands its VEVENTs/RRULEs into the rolling event window, and merges the
  passive DOM extract (content.js → observe.parse), which is where
  subscribed calendars live. Secret iCal fallback URLs are used only when
  the export fails, are validated before fetch and never logged or stored.
  W1's suppressAgainstCalendar reads state.events (own events only).
*/

import { dedupeEvents } from "./dom.js";
import { readZip } from "./zip.js";
import { parseIcs } from "./ics.js";

/** @typedef {import("../../core/contract.js").SyncContext} SyncContext */
/** @typedef {import("../../core/contract.js").SyncResult} SyncResult */

const KINDS = ["own", "subscribed", "unknown"];
const EVENT_CAP = 3000;
const PAST_MS = 7 * 24 * 60 * 60 * 1000;
const FUTURE_MS = 120 * 24 * 60 * 60 * 1000;
const EXPORT_URL = (account) => `https://calendar.google.com/calendar/u/${account}/exporticalzip`;
const ICAL_URL_RE = /^https:\/\/calendar\.google\.com\/calendar\/ical\//;
const SKIP_ENTRY_RE = /@import\.calendar\.google\.com|@group\.v\.calendar\.google\.com/i;
const MAX_ICAL_URLS = 5;

const isoMs = (v) => (typeof v === "string" ? Date.parse(v) : NaN);

/** @param {string} b64 */
const b64Bytes = (b64) => {
  const s = atob(String(b64 || ""));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

/** Strict per-event validation; invalid events are dropped silently. */
function validEvent(e) {
  if (!e || typeof e !== "object") return null;
  if (typeof e.title !== "string" || !e.title.trim() || e.title.length > 200) return null;
  const startMs = isoMs(e.startAt);
  if (Number.isNaN(startMs)) return null;
  if (e.endAt != null && Number.isNaN(isoMs(e.endAt))) return null;
  if (typeof e.allDay !== "boolean") return null;
  if (!KINDS.includes(e.calendarKind)) return null;
  /** @type {any} */
  const ev = {
    title: e.title,
    startAt: new Date(startMs).toISOString(),
    allDay: e.allDay,
    calendarKind: e.calendarKind,
  };
  if (e.endAt != null) ev.endAt = new Date(isoMs(e.endAt)).toISOString();
  return ev;
}

/**
 * The rolling window [now − 7 d, now + 120 d] shared by the export read
 * and the DOM observe path: events overlapping it survive, deduped
 * (own wins), sorted, capped at 3000 nearest to now.
 */
function reduceEvents(events, nowMs) {
  const kept = dedupeEvents(events).filter((e) => {
    const s = isoMs(e.startAt);
    const en = e.endAt ? isoMs(e.endAt) : s + (e.allDay ? 86400e3 : 0);
    return s <= nowMs + FUTURE_MS && en >= nowMs - PAST_MS;
  });
  kept.sort((a, b) => (a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : 0));
  if (kept.length <= EVENT_CAP) return kept;
  return kept
    .map((e) => ({ e, dist: Math.abs(isoMs(e.startAt) - nowMs) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, EVENT_CAP)
    .map((x) => x.e)
    .sort((a, b) => (a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : 0));
}

/** @type {import("../../core/contract.js").Adapter} */
const adapter = {
  // "gcal" enters the contract SourceId union on W1's side at merge.
  id: /** @type {any} */ ("gcal"),
  label: "Google Calendar (duplicate check)",
  origins: ["https://calendar.google.com"],
  intervalMinutes: 360,
  syncOnTabOpen: false,

  /**
   * T1 fetch: the account export zip (own calendars only — subscribed
   * feeds are not in the export; the DOM read keeps covering them).
   * @param {SyncContext} ctx
   */
  async sync(ctx) {
    const prev = ctx && ctx.state && typeof ctx.state === "object" ? ctx.state : {};
    const settings = ctx && ctx.settings && typeof ctx.settings === "object" ? ctx.settings : {};
    if (settings.enabled !== true) {
      return { items: [], complete: false, session: /** @type {const} */ ("no-tab"), state: prev };
    }
    const now = (ctx && ctx.now) || new Date();
    const nowMs = now.getTime();
    const at = now.toISOString();

    const account = Number.isInteger(settings.account) ? settings.account : 0;
    const res = await ctx.fetch(EXPORT_URL(account), { binary: true });

    /** @type {any[]} parsed calendars kept */
    const calendars = [];
    /** @type {"unreachable"|"signed-out"|null} */
    let fail = null;
    if (!res || res.status === 0) {
      fail = "unreachable";
    } else {
      const raw = res.base64 ? b64Bytes(res.base64) : null;
      const isZip =
        !!raw && raw.length >= 4 && raw[0] === 0x50 && raw[1] === 0x4b && raw[2] === 3 && raw[3] === 4;
      if (res.loginRedirect || /html/i.test(String(res.contentType || "")) || !isZip) {
        fail = "signed-out";
      } else {
        try {
          const dec = new TextDecoder();
          for (const e of await readZip(raw)) {
            if (SKIP_ENTRY_RE.test(e.name)) continue;
            const cal = parseIcs(dec.decode(e.bytes), { now });
            if (cal && !cal.wa1) calendars.push(cal);
          }
        } catch {
          fail = "signed-out";
        }
        if (!calendars.length && !fail) fail = "signed-out";
      }
    }

    // Fallback: the user's own secret iCal addresses — only when the
    // export failed, only validated Google iCal URLs, never logged.
    if (!calendars.length) {
      const urls = (Array.isArray(settings.icalUrls) ? settings.icalUrls : [])
        .filter((u) => typeof u === "string" && ICAL_URL_RE.test(u))
        .slice(0, MAX_ICAL_URLS);
      for (const u of urls) {
        try {
          const r = await ctx.fetch(u);
          if (!r || r.status < 200 || r.status >= 300 || !r.text) continue;
          const cal = parseIcs(r.text, { now });
          if (cal && !cal.wa1) calendars.push(cal);
        } catch {
          /* try the next address */
        }
      }
    }

    if (!calendars.length) {
      if (fail === "unreachable") {
        return {
          items: [],
          complete: false,
          error: { code: "unreachable", message: "calendar export unreachable" },
          state: prev,
        };
      }
      return { items: [], complete: false, session: /** @type {const} */ ("signed-out"), state: prev };
    }

    const own = calendars.flatMap((c) => c.events).map(validEvent).filter(Boolean);
    // Own events come fresh from the export; DOM-read events of other
    // kinds (the subscribed calendars the export doesn't contain) keep.
    const domKept = (Array.isArray(prev.events) ? prev.events : [])
      .map(validEvent)
      .filter(Boolean)
      .filter((e) => e.calendarKind !== "own");
    const events = reduceEvents([...domKept, ...own], nowMs);
    return {
      items: [],
      complete: true,
      readOk: ["gcal"],
      scope: "gcal",
      state: {
        events,
        lastSeenAt: at,
        ics: { at, calendars: calendars.length, events: own.length },
      },
    };
  },

  observe: {
    urlPatterns: [],
    /**
     * @param {import("../../core/contract.js").ObservedPayload} payload
     * @param {SyncContext} ctx
     * @returns {Promise<SyncResult & {scope: string}>}
     */
    async parse(payload, ctx) {
      const prev = ctx.state && typeof ctx.state === "object" ? ctx.state : {};
      const now = ctx.now || new Date();
      const nowMs = now.getTime();

      /** @type {any} */
      let data;
      try {
        data = JSON.parse(String(payload.body || ""));
      } catch {
        return { items: [], complete: false, scope: "gcal", state: prev };
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return { items: [], complete: false, scope: "gcal", state: prev };
      }

      // Visible-range deletion is only safe once the reader reports a
      // settled view — while the grid is still rendering, a half-read
      // range would wipe events that are simply not drawn yet.
      const settled = data.settled === true;
      const r = data.range;
      const range =
        settled && r && !Number.isNaN(isoMs(r.start)) && !Number.isNaN(isoMs(r.end))
          ? { start: isoMs(r.start), end: isoMs(r.end) }
          : null;

      /** @type {any[]} */
      const prevEvents = Array.isArray(prev.events)
        ? prev.events.map(validEvent).filter(Boolean)
        : [];
      const kept = range
        ? prevEvents.filter((e) => {
            const t = isoMs(e.startAt);
            return !(t >= range.start && t < range.end);
          })
        : prevEvents;

      const fresh = (Array.isArray(data.events) ? data.events : [])
        .map(validEvent)
        .filter(Boolean);

      const events = reduceEvents([...kept, ...fresh], nowMs);
      const at =
        payload.at || (now instanceof Date ? now.toISOString() : new Date(now).toISOString());
      return {
        items: [],
        complete: true,
        readOk: ["gcal"],
        scope: "gcal",
        // No session on a successful read: the scheduler only refreshes
        // lastOkAt/itemCount/complete when `session` is absent.
        state: { ...prev, events, lastSeenAt: at },
      };
    },
  },
};

export default adapter;
