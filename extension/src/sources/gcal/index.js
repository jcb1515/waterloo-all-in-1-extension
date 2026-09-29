// @ts-check
/*
  Google Calendar adapter — duplicate suppression only (no Items). T1 reads
  the account's exporticalzip (a zip of the user's OWN calendars) through
  ctx.fetch in the service worker — falling back to the same read relayed
  through an open Calendar tab (T2, same-origin cookies) when the profile
  blocks the worker fetch — expands its VEVENTs/RRULEs into the rolling
  event window, and merges the
  passive DOM extract (content.js → observe.parse), which is where
  subscribed calendars live. Secret iCal fallback URLs are used only when
  the export fails, are validated before fetch and never logged or stored.
  suppressAgainstCalendar reads state.events: own + subscribed events
  suppress, "wa1" (our own feed) and "unknown" never do.
*/

import { dedupeEvents, WA1_TITLE_RE } from "./dom.js";
import { readZip } from "./zip.js";
import { parseIcs } from "./ics.js";
import { hasSourceAccess } from "../../core/permissions.js";

/** @typedef {import("../../core/contract.js").SyncContext} SyncContext */
/** @typedef {import("../../core/contract.js").SyncResult} SyncResult */

const KINDS = ["own", "wa1", "subscribed", "unknown"];
const EVENT_CAP = 3000;
const PAST_MS = 7 * 24 * 60 * 60 * 1000;
const FUTURE_MS = 120 * 24 * 60 * 60 * 1000;
const GCAL_ORIGIN = "https://calendar.google.com";
const EXPORT_PATH = (account) => `/calendar/u/${account}/exporticalzip`;
const EXPORT_URL = (account) => `${GCAL_ORIGIN}${EXPORT_PATH(account)}`;
const ICAL_URL_RE = /^https:\/\/calendar\.google\.com\/calendar\/ical\//;
const SKIP_ENTRY_RE = /@import\.calendar\.google\.com|@group\.v\.calendar\.google\.com/i;
// Our own feed's host (the build-time calendar service URL): an iCal
// address pointing at it is our own subscription, never an "own" calendar.
const FEED_HOST = (() => {
  try {
    const u =
      typeof __WA1_CALENDAR_SERVICE_URL__ === "undefined" ? "" : __WA1_CALENDAR_SERVICE_URL__;
    return u ? new URL(String(u)).host.toLowerCase() : "";
  } catch {
    return "";
  }
})();
const MAX_ICAL_URLS = 5;

const isoMs = (v) => (typeof v === "string" ? Date.parse(v) : NaN);

/** The URL points at this extension's own feed server. */
const isFeedUrl = (u) => {
  try {
    return !!FEED_HOST && new URL(String(u)).host.toLowerCase() === FEED_HOST;
  } catch {
    return false;
  }
};

/** @param {string} b64 */
const b64Bytes = (b64) => {
  const s = atob(String(b64 || ""));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

/**
 * A zip FetchResult -> parsed calendars, or null when the read didn't yield
 * the export zip (blocked, login redirect, html page, non-zip, corrupt).
 * Shared by the direct worker read and the open-tab relay read.
 * @param {any} res @param {Date} now
 * @returns {Promise<any[] | null>}
 */
async function exportCalendars(res, now) {
  const raw = res && res.base64 ? b64Bytes(res.base64) : null;
  const isZip =
    !!raw && raw.length >= 4 && raw[0] === 0x50 && raw[1] === 0x4b && raw[2] === 3 && raw[3] === 4;
  if (!res || res.loginRedirect || /html/i.test(String(res.contentType || "")) || !isZip) {
    return null;
  }
  try {
    const dec = new TextDecoder();
    /** @type {any[]} */
    const cals = [];
    for (const e of await readZip(raw)) {
      if (SKIP_ENTRY_RE.test(e.name)) continue;
      const cal = parseIcs(dec.decode(e.bytes), { now });
      if (cal && !cal.wa1) cals.push(cal);
    }
    return cals.length ? cals : null;
  } catch {
    return null;
  }
}

/** Strict per-event validation; invalid events are dropped silently. */
function validEvent(e) {
  if (!e || typeof e !== "object") return null;
  if (typeof e.title !== "string" || !e.title.trim() || e.title.length > 200) return null;
  const startMs = isoMs(e.startAt);
  if (Number.isNaN(startMs)) return null;
  if (e.endAt != null && Number.isNaN(isoMs(e.endAt))) return null;
  if (typeof e.allDay !== "boolean") return null;
  if (!KINDS.includes(e.calendarKind)) return null;
  // Migration: events stored before the "wa1" kind existed carry our own
  // feed as "subscribed" — a "<CODE> · <Label>" title reclassifies them so
  // the feed never suppresses its own source items.
  const calendarKind =
    e.calendarKind === "subscribed" && WA1_TITLE_RE.test(e.title)
      ? "wa1"
      : e.calendarKind;
  /** @type {any} */
  const ev = {
    title: e.title,
    startAt: new Date(startMs).toISOString(),
    allDay: e.allDay,
    calendarKind,
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
    /** @type {"unreachable"|"signed-out"|"no-permission"|null} */
    let fail = null;
    /** Direct read produced no HTTP answer while the host permission is
        granted — the relay's noTab answer then means "open a Calendar tab",
        not "sign in". */
    let directBlocked = false;
    /** @type {any} the export relay answer, when one was tried */
    let relayRes = null;
    const exportCals = await exportCalendars(res, now);
    if (exportCals) {
      calendars.push(...exportCals);
    } else {
      if (!res || res.status === 0) {
        if (res && res.error === "timeout") {
          fail = "unreachable";
        } else {
          // status 0 = the fetch threw: the redirect to Google's sign-in
          // page, blocked cookies, the host permission never granted, or a
          // profile where the worker's CORS bypass doesn't reach Calendar.
          if (await hasSourceAccess("gcal")) {
            fail = "signed-out";
            directBlocked = true;
          } else {
            fail = "no-permission";
          }
        }
      } else {
        fail = "signed-out"; // answered, but not a zip we can use
      }
      // The same read inside an open Calendar tab: same-origin session
      // cookies, no worker CORS bypass involved.
      if (typeof ctx.relay === "function") {
        try {
          relayRes = await ctx.relay(GCAL_ORIGIN, EXPORT_PATH(account), { binary: true });
        } catch {
          relayRes = null;
        }
        const relayCals = await exportCalendars(relayRes, now);
        if (relayCals) calendars.push(...relayCals);
      }
    }

    // Fallback: the user's own secret iCal addresses — only when the
    // export failed, only validated Google iCal URLs, never logged.
    if (!calendars.length) {
      const urls = (Array.isArray(settings.icalUrls) ? settings.icalUrls : [])
        .filter((u) => typeof u === "string" && ICAL_URL_RE.test(u) && !isFeedUrl(u))
        .slice(0, MAX_ICAL_URLS);
      for (const u of urls) {
        try {
          let r = await ctx.fetch(u);
          if ((!r || r.status === 0) && typeof ctx.relay === "function") {
            try {
              r = await ctx.relay(GCAL_ORIGIN, new URL(u).pathname);
            } catch {
              /* keep the failed direct result */
            }
          }
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
          error: {
            code: "unreachable",
            message: "Google Calendar didn't answer in time — try again",
          },
          state: prev,
        };
      }
      if (fail === "no-permission") {
        return {
          items: [],
          complete: false,
          error: {
            code: "no-permission",
            message: "Allow calendar.google.com: Sources → Setup → Google Calendar",
          },
          state: prev,
        };
      }
      // fail === "signed-out". The relay's answer sharpens the advice: no
      // Calendar tab at all -> open one; a tab that answered with a login
      // bounce, html or 403 -> sign in.
      const message =
        directBlocked && relayRes && relayRes.noTab
          ? "Open Google Calendar in a tab (calendar.google.com), then Check now"
          : "Sign in to Google Calendar in this browser (open calendar.google.com), then Check now";
      return {
        items: [],
        complete: false,
        session: /** @type {const} */ ("signed-out"),
        error: { code: "signed-out", message },
        state: prev,
      };
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
