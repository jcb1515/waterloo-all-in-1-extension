// @ts-check
/*
  Clash detection over effective items: overlapping timed events and
  "crunch" windows of weighted deliverables. Pure.
*/

import { effectiveItem, isVisible } from "./effective.js";

const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const DEFAULT_END_MS = HOUR; // a timed item with no endAt lasts 60 min

/** Deliverables that count toward a crunch day. */
const CRUNCH_TYPES = new Set(["deadline", "quiz", "presentation"]);
const CRUNCH_MIN_WEIGHT = 5;
const CRUNCH_MIN_ITEMS = 3;
const CRUNCH_WINDOW = 24 * HOUR;

const SEVERE_TYPES = new Set(["exam", "interview"]);

/**
 * @param {Record<string, any>} items  merged items map
 * @param {Record<string, any>} userState
 * @param {Date} now
 * @param {{horizonDays?: number, acceptPending?: boolean}} [opts]
 * @returns {{kind: "overlap"|"crunch", severity: "severe"|"warn",
 *   itemIds: string[], start: string, end: string}[]}
 */
export function findClashes(items, userState = {}, now = new Date(), opts = {}) {
  const horizon = (opts.horizonDays ?? 14) * DAY;
  const nowMs = now.getTime();
  const acceptPending = !!opts.acceptPending;

  /** @type {any[]} */
  const timed = [];
  /** @type {any[]} */
  const weighted = [];
  for (const raw of Object.values(items || {})) {
    const eff = effectiveItem(raw, userState[raw && raw.id], { acceptPending });
    if (!isVisible(eff, nowMs)) continue;
    if (eff.status !== "open") continue;
    if (eff.startAt) {
      const s = Date.parse(eff.startAt);
      const e = eff.endAt ? Date.parse(eff.endAt) : s + DEFAULT_END_MS;
      if (!Number.isNaN(s) && s < nowMs + horizon && e > nowMs) {
        timed.push({ id: eff.id, title: eff.title, type: eff.type, s, e });
      }
    }
    const due = eff.dueAt ? Date.parse(eff.dueAt) : NaN;
    const isDeliverable =
      (CRUNCH_TYPES.has(eff.type) || (eff.type === "lab" && eff.dueAt)) &&
      typeof eff.weight === "number" && eff.weight >= CRUNCH_MIN_WEIGHT;
    if (isDeliverable && !Number.isNaN(due) && due >= nowMs && due < nowMs + horizon) {
      weighted.push({ id: eff.id, due });
    }
  }

  /** @type {any[]} */
  const out = [];

  // Overlaps: O(n²) over the horizon's timed items — small in practice.
  timed.sort((a, b) => a.s - b.s);
  const seenPairs = new Set();
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const a = timed[i];
      const b = timed[j];
      if (b.s >= a.e) break; // sorted by start; no later start can overlap
      // Touching endpoints (end == start) is not a clash.
      if (b.s < a.e && b.e > a.s) {
        const key = `${a.id}|${b.id}`;
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        out.push({
          kind: "overlap",
          severity: SEVERE_TYPES.has(a.type) || SEVERE_TYPES.has(b.type) ? "severe" : "warn",
          itemIds: [a.id, b.id],
          start: new Date(Math.max(a.s, b.s)).toISOString(),
          end: new Date(Math.min(a.e, b.e)).toISOString(),
        });
      }
    }
  }

  // Crunch: the densest 24 h window of weighted deliverables — slide a window
  // over sorted due dates; report each maximal run of >= 3 once.
  weighted.sort((a, b) => a.due - b.due);
  /** @type {Set<string>} */
  const claimed = new Set();
  for (let i = 0; i < weighted.length; i++) {
    const windowEnd = weighted[i].due + CRUNCH_WINDOW;
    const cluster = [];
    for (let j = i; j < weighted.length && weighted[j].due < windowEnd; j++) {
      cluster.push(weighted[j]);
    }
    const fresh = cluster.filter((c) => !claimed.has(c.id));
    if (fresh.length >= CRUNCH_MIN_ITEMS) {
      for (const c of cluster) claimed.add(c.id);
      out.push({
        kind: "crunch",
        severity: "warn",
        itemIds: cluster.map((c) => c.id),
        start: new Date(weighted[i].due).toISOString(),
        end: new Date(Math.min(windowEnd, nowMs + horizon)).toISOString(),
      });
    }
  }

  return out;
}
