// @ts-check
/*
  Pure helpers for the item detail sheet: snooze presets resolved on the
  Toronto wall clock (DST-safe via textdates' zonedIso), estimate sums for the
  agenda group headers, the source-link fallback order, and the
  hidden/snoozed listing that Settings -> General renders. No DOM, no chrome.*.
*/

import { zonedParts, zonedIso } from "../../lib/textdates/index.js";
import { effectiveItem } from "../../core/effective.js";
import { feedExclusion, excludedProjectIds } from "../../calendar/payload.js";
import { todoRowGate } from "./todo.js";

const TZ = "America/Toronto";
const HOUR = 3600000;

export const SOURCE_LABELS = {
  learn: "Learn",
  outline: "Course outline",
  portal: "Portal",
  waterlooworks: "WaterlooWorks",
  discord: "Discord",
  outlook: "Outlook",
  gmail: "Gmail",
  manual: "Manual",
};

/** @param {string} [id] */
export function sourceLabel(id) {
  return (id && SOURCE_LABELS[id]) || id || "the source";
}

/** Snooze preset keys -> labels, in button order. */
export const SNOOZE_PRESETS = [
  ["hour", "1 hour"],
  ["evening", "Tonight 8 PM"],
  ["morning", "Tomorrow 8 AM"],
  ["monday", "Monday 8 AM"],
];

/**
 * Resolve a snooze preset to an ISO instant. Evenings/mornings are Toronto
 * wall-clock targets built with zonedIso, so a preset stays at 8 PM / 8 AM
 * across DST transitions.
 * @param {string} key  hour | evening | morning | monday
 * @param {Date} now
 * @returns {string|null} ISO instant, or null for an unknown key
 */
export function snoozeUntil(key, now = new Date()) {
  const p = zonedParts(now, TZ);
  switch (key) {
    case "hour":
      return new Date(now.getTime() + HOUR).toISOString();
    case "evening": {
      let t = Date.parse(zonedIso(p.y, p.m, p.d, 20, 0, TZ));
      if (t <= now.getTime()) t = Date.parse(zonedIso(p.y, p.m, p.d + 1, 20, 0, TZ));
      return new Date(t).toISOString();
    }
    case "morning":
      return zonedIso(p.y, p.m, p.d + 1, 8, 0, TZ);
    case "monday": {
      // Strictly the next Monday — on a Monday it means a week out.
      const delta = ((1 - p.weekday + 7) % 7) || 7;
      return zonedIso(p.y, p.m, p.d + delta, 8, 0, TZ);
    }
    default:
      return null;
  }
}

/**
 * Minutes -> "1h 30m" / "45m" / "2h".
 * @param {number} min
 */
export function fmtEstimate(min) {
  const m = Math.round(min);
  if (m <= 0) return "0m";
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${r}m`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

/**
 * Total the user's estimateMin over the open rows of a list (done/submitted
 * rows don't count toward the remaining work).
 * @param {any[]} rows        effective items
 * @param {Record<string, any>} userState
 * @returns {number} minutes; 0 when nothing is estimated
 */
export function estimateSumMin(rows, userState = {}) {
  let total = 0;
  for (const it of rows || []) {
    if (!it || it.status === "done" || it.status === "submitted") continue;
    const e = (userState[it.id] || {}).estimateMin;
    if (typeof e === "number" && e > 0) total += e;
  }
  return total;
}

/**
 * The item's primary outbound link: its own url, else the list page it came
 * from, else the evidence link.
 * @param {any} item
 * @returns {{url: string|null, label: string}}
 */
export function primaryLink(item) {
  const url =
    (item && item.url) ||
    (item && item.meta && item.meta.listUrl) ||
    (item && item.evidence && item.evidence.url) ||
    null;
  return { url, label: sourceLabel(item && item.source) };
}

/**
 * The outbound link for one seenIn entry: the item's own URL when this is the
 * source that produced it, else that source's home page from the adapter
 * registry. Null when neither exists.
 * @param {any} item
 * @param {{source?: string}} seen   one item.seenIn entry
 * @param {{id: string, origins?: string[]}[]} adapters
 * @returns {string | null}
 */
export function sourceOpenLink(item, seen, adapters) {
  if (!item || !seen || !seen.source) return null;
  if (seen.source === item.source) {
    return (
      item.url ||
      (item.meta && item.meta.listUrl) ||
      (item.evidence && item.evidence.url) ||
      homeFor(seen.source, adapters)
    );
  }
  return homeFor(seen.source, adapters);
}

/** @param {string} id @param {{id: string, origins?: string[]}[]} adapters */
function homeFor(id, adapters) {
  const a = (adapters || []).find((x) => x && x.id === id);
  return a && a.origins && a.origins[0] ? `${a.origins[0]}/` : null;
}

/**
 * Items the user hid or snoozed into the future, for the Settings -> General
 * list. Sorted by title for a stable scan.
 * @param {Record<string, any>} items
 * @param {Record<string, any>} userState
 * @param {Date} now
 * @returns {{item: any, hidden: boolean, snoozedUntil: string|null}[]}
 */
export function hiddenSnoozed(items, userState = {}, now = new Date()) {
  const nowMs = now.getTime();
  /** @type {any[]} */
  const out = [];
  for (const it of Object.values(items || {})) {
    if (!it || !it.id) continue;
    const us = userState[it.id] || {};
    const snoozed = us.snoozedUntil && Date.parse(us.snoozedUntil) > nowMs ? us.snoozedUntil : null;
    if (!us.hidden && !snoozed) continue;
    out.push({ item: it, hidden: !!us.hidden, snoozedUntil: snoozed });
  }
  out.sort((a, b) => String(a.item.title || "").localeCompare(String(b.item.title || "")));
  return out;
}

/* ---------------------- calendar / to-do state ---------------------- */

const ms = (/** @type {any} */ now) =>
  now instanceof Date ? now.getTime() : Number(now);

/**
 * The item sheet's Calendar row: whether this item reaches the calendar
 * feed, and which Add/Remove affordance applies. Uses the same
 * feedExclusion the publisher runs, so the row can never disagree with the
 * feed. acceptPending follows the review.showPending setting — a pending
 * item counts as addable either way.
 * @param {any} raw    merged item (or derived to-do row)
 * @param {any} us     userState[raw.id]
 * @param {any} state  merged panel state ({settings, projects})
 * @param {Date|number} now
 * @returns {{kind: "google"|"on"|"off", reason: string|null,
 *   canAdd: boolean, canRemove: boolean}}
 */
export function calendarState(raw, us, state, now) {
  const settings = (state && state.settings) || {};
  const acceptPending = !!(settings.review && settings.review.showPending);
  const eff = effectiveItem(raw, us, { acceptPending });
  const reason = eff
    ? feedExclusion(
        eff,
        us,
        settings.calendar,
        ms(now),
        excludedProjectIds(state && state.projects),
      )
    : "no-date";
  if (reason === "on-google") {
    return { kind: "google", reason, canAdd: false, canRemove: false };
  }
  if (reason === null) {
    return { kind: "on", reason: null, canAdd: false, canRemove: true };
  }
  const canAdd = reason === "pending" || reason === "dismissed" || reason === "removed";
  return { kind: "off", reason, canAdd, canRemove: false };
}

/**
 * The userState patch for the sheet's "Remove from calendar". A
 * user-accepted item (us.review === "accepted" — source reviews are only
 * ever "auto"/"pending") was added *by* the user, so remove undoes both:
 * clearing review sends it back to "Found, not added yet". Anything else
 * is a source/auto item where remove is just the feed opt-out — it stays
 * in Upcoming like any accepted find.
 * @param {any} us  userState[item.id] (may be undefined)
 * @returns {Record<string, any>}
 */
export function removeCalendarPatch(us) {
  if (us && us.review === "accepted") return { review: null, calendar: null };
  return { calendar: false };
}

/**
 * One-line explanation for an off-calendar item the user can't add from
 * here (the "Calendar" dd when there is no button).
 * @param {string|null} reason  feedExclusion reason
 * @param {any} [item]
 */
export function calendarReasonText(reason, item) {
  switch (reason) {
    case "hidden":
      return "Hidden — unhide it to add it";
    case "cancelled":
      return "Cancelled — it stays off the calendar";
    case "opted-out":
      return item && item.meta && item.meta.projectId
        ? "Its project keeps it off the calendar"
        : "Excluded from the calendar feed";
    case "completed-off":
      return "Done items are turned off in Calendar settings";
    case "classes-off":
      return "Classes are turned off in Calendar settings";
    case "tentative-off":
      return "Tentative dates are turned off in Calendar settings";
    case "term-dates-off":
      return "Term dates are turned off in Calendar settings";
    case "todo-only":
      return "Listed as a to-do — calendar to-dos are off in Calendar settings";
    case "undated":
      return "No real date — the date shown is a guess";
    case "no-date":
      return "No date to put on a calendar";
    case "past":
      return "Too far in the past to add";
    case "window":
      return "Classes reach the feed inside a rolling window around today";
    default:
      return "Not on the calendar feed";
  }
}

/**
 * The item sheet's To-do row: is this item on the to-do list, and does it
 * get there by rule or by pin? Uses the same todoRowGate as buildTodos —
 * the listed flag can never disagree with the tab.
 * @param {any} raw    merged item (or a derived to-do row)
 * @param {any} us     userState[raw.id]
 * @param {any} state  merged panel state ({items, todos, userState,
 *   settings, projects})
 * @param {Date|number} now
 * @returns {{listed: boolean, auto: boolean, canAdd: boolean,
 *   canRemove: boolean}}
 */
export function todoState(raw, us, state, now) {
  const none = { listed: false, auto: false, canAdd: false, canRemove: false };
  if (!raw || !raw.id) return none;
  const settings = (state && state.settings) || {};
  const acceptPending = !!(settings.review && settings.review.showPending);
  const gate = todoRowGate({
    items: (state && state.items) || {},
    todos: (state && state.todos) || {},
    userState: (state && state.userState) || {},
    settings,
    projects: (state && state.projects) || [],
    now: now instanceof Date ? now : new Date(now),
  });
  const isDerived = !!(state && state.todos && state.todos[raw.id]);
  const r = gate.check(raw, isDerived, us);
  const listed = !!(r && !r.soon);
  const pinned = !!(us && us.todo === true);
  // Only dated items can be pinned; hidden, cancelled and not-yet-open
  // study to-dos never can.
  const eff = effectiveItem(raw, us, { acceptPending });
  const dated = !!(eff.dueAt || eff.startAt);
  const canAdd =
    !listed && !(r && r.soon) && dated && !eff.hidden && eff.status !== "cancelled";
  return { listed, auto: listed && !pinned, canAdd, canRemove: listed };
}
