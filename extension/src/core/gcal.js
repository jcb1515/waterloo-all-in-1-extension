// @ts-check
/*
  Google Calendar duplicate suppression. The passive gcal reader keeps a
  rolling `sourceState.gcal.state.events` of what is already on the user's
  calendar; suppressAgainstCalendar marks canonical items matching an own
  event with meta.onCalendar = "google" so the feed payload skips them and
  the panel shows the "On your Google Calendar" badge.

  Only calendarKind === "own" events ever suppress: the user's subscription
  to OUR OWN feed shows up as "subscribed" (or an unclassified id as
  "unknown"), and matching on those would let the feed suppress the very
  items it came from.

  The mark is recomputed on every recompute pass from fresh canonical
  items — a gcal event deleted since the last read un-suppresses the item
  on its own; nothing here is sticky.
*/

import { titleSimilarity } from "./merge.js";
import { zonedParts } from "../lib/textdates/index.js";

const TIMED_WINDOW_MS = 5 * 60 * 1000;
const SIM_MIN = 0.6;
const TZ = "America/Toronto";

/**
 * The own-calendar events stored by the gcal adapter — the only inputs
 * suppression is allowed to see.
 * @param {Record<string, any>} sourceState  the stored sourceState map
 */
export function gcalOwnEvents(sourceState) {
  const st =
    sourceState &&
    sourceState.gcal &&
    sourceState.gcal.state &&
    sourceState.gcal.state.events;
  if (!Array.isArray(st)) return [];
  return st.filter((e) => e && e.calendarKind === "own");
}

/**
 * User-created things never suppress: derived to-dos (meta.auto), project
 * items (meta.projectId) and manual items — the user put those there on
 * purpose. Only adapter-produced source items are eligible.
 * @param {any} it canonical item
 */
function eligible(it) {
  if (!it || typeof it !== "object") return false;
  if (it.source === "manual") return false;
  const meta = it.meta || {};
  if (meta.auto || meta.projectId) return false;
  return true;
}

const torontoDay = (ms) => {
  const z = zonedParts(new Date(ms), TZ);
  return `${z.y}-${z.m}-${z.d}`;
};

/**
 * One item vs one own event. Timed-vs-timed: starts within 5 minutes.
 * Either side all-day: the same Toronto calendar date.
 * Title similarity >= 0.6 against the bare item title or "<org> <title>"
 * (the published form a gcal copy of it would carry).
 * @param {any} it @param {any} ev
 */
function eventMatches(it, ev) {
  const anchor = it.dueAt || it.startAt;
  const iMs = anchor ? Date.parse(anchor) : NaN;
  const eMs = ev && ev.startAt ? Date.parse(ev.startAt) : NaN;
  if (Number.isNaN(iMs) || Number.isNaN(eMs)) return false;
  if (it.allDay || ev.allDay) {
    if (torontoDay(iMs) !== torontoDay(eMs)) return false;
  } else if (Math.abs(iMs - eMs) > TIMED_WINDOW_MS) {
    return false;
  }
  if (titleSimilarity(ev.title, "", it.title, "") >= SIM_MIN) return true;
  const withOrg = it.org ? `${it.org} ${it.title}` : "";
  return !!withOrg && titleSimilarity(ev.title, "", withOrg, "") >= SIM_MIN;
}

/**
 * Mark items already on the user's own Google Calendar. Returns a new map
 * only when something matched; otherwise the input map unchanged.
 * @param {Record<string, any>} items canonical items (id -> item)
 * @param {any[]} gcalEvents sourceState.gcal.state.events (kinds filtered here)
 * @param {Date} [_now] kept for symmetry with the caller; matching is
 *   anchor-vs-anchor so now is unused.
 */
export function suppressAgainstCalendar(items, gcalEvents, _now = new Date()) {
  const own = (gcalEvents || []).filter((e) => e && e.calendarKind === "own");
  if (!own.length || !items || typeof items !== "object") return items;
  let changed = false;
  /** @type {Record<string, any>} */
  const out = {};
  for (const [id, it] of Object.entries(items)) {
    const meta = (it && it.meta) || {};
    if (!eligible(it) || meta.onCalendar || !own.some((ev) => eventMatches(it, ev))) {
      out[id] = it;
      continue;
    }
    changed = true;
    out[id] = { ...it, meta: { ...meta, onCalendar: "google" } };
  }
  return changed ? out : items;
}
