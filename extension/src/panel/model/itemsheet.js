// @ts-check
/*
  Pure helpers for the item detail sheet: snooze presets resolved on the
  Toronto wall clock (DST-safe via textdates' zonedIso), estimate sums for the
  agenda group headers, the source-link fallback order, and the
  hidden/snoozed listing that Settings -> General renders. No DOM, no chrome.*.
*/

import { zonedParts, zonedIso } from "../../lib/textdates/index.js";

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
