// @ts-check
/*
  Google Calendar adapter — passive observe only (T3), for duplicate
  suppression. It produces no Items: observe.parse just maintains
  state.events, the rolling window of what is already on the user's
  calendar, which W1's core suppressAgainstCalendar reads (own events
  only). Everything arrives as a serialised DOM extract from content.js.
*/

import { dedupeEvents } from "./dom.js";

/** @typedef {import("../../core/contract.js").SyncContext} SyncContext */
/** @typedef {import("../../core/contract.js").SyncResult} SyncResult */

const KINDS = ["own", "subscribed", "unknown"];
const EVENT_CAP = 500;
const PAST_MS = 24 * 60 * 60 * 1000;
const FUTURE_MS = 60 * 24 * 60 * 60 * 1000;

const isoMs = (v) => (typeof v === "string" ? Date.parse(v) : NaN);

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

/** @type {import("../../core/contract.js").Adapter} */
const adapter = {
  // "gcal" enters the contract SourceId union on W1's side at merge.
  id: /** @type {any} */ ("gcal"),
  label: "Google Calendar (duplicate check)",
  origins: ["https://calendar.google.com"],
  intervalMinutes: 0,
  syncOnTabOpen: false,

  /**
   * No fetch tier — this reader is passive-only; the extract arrives via
   * observe.parse whenever the user has a calendar tab open.
   * @param {SyncContext} ctx
   */
  async sync(ctx) {
    return { items: [], complete: false, session: "no-tab", state: (ctx && ctx.state) || {} };
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

      // The freshly-read visible range: previous events inside it were
      // re-observed or deleted, so they are replaced wholesale. A null
      // range (schedule/other views) never deletes.
      const r = data.range;
      const range =
        r && !Number.isNaN(isoMs(r.start)) && !Number.isNaN(isoMs(r.end))
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

      // Rolling window: only [now − 1 day, now + 60 days] matters, deduped
      // by title+start (own wins), sorted by startAt, capped at 500 with
      // the events nearest to now kept.
      let events = dedupeEvents([...kept, ...fresh]).filter((e) => {
        const t = isoMs(e.startAt);
        return t >= nowMs - PAST_MS && t <= nowMs + FUTURE_MS;
      });
      events.sort((a, b) => (a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : 0));
      if (events.length > EVENT_CAP) {
        events = events
          .map((e) => ({ e, dist: Math.abs(isoMs(e.startAt) - nowMs) }))
          .sort((a, b) => a.dist - b.dist)
          .slice(0, EVENT_CAP)
          .map((x) => x.e)
          .sort((a, b) => (a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : 0));
      }

      const at =
        payload.at || (now instanceof Date ? now.toISOString() : new Date(now).toISOString());
      return {
        items: [],
        complete: true,
        readOk: ["gcal"],
        scope: "gcal",
        session: "signed-in",
        state: { events, lastSeenAt: at },
      };
    },
  },
};

export default adapter;
