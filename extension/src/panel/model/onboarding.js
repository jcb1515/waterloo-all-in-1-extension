// @ts-check
/*
  Pure onboarding + nudge model (v2 additions). Drives two UI surfaces:
   - "Get set up" card: essential checklist rows of enabled sources that have
     never had a good read;
   - "Needs a visit" nudges: refreshDays rows whose last good read is stale.

  A row's "last good read" is the newest of:
   - probes[source][rowPage].ok's `at` (the DOM/structure probe), and
   - sourceState[source].scopeOkAt[row.stat.scope] (written by the ingest on
     every successful observe/sync with items; absent until W3's writer lands).

  No DOM, no chrome.* — tests drive it directly.
*/

import { CHECK_SOURCES, checkRowPage } from "../../sources/probes.js";

const DAY_MS = 86400000;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Is a source enabled? gcal is opt-in (enabled === true); every other source
 * defaults on unless explicitly disabled (enabled === false).
 * @param {any} settings @param {string} source
 */
export function sourceEnabled(settings, source) {
  const src = isObj(settings) && isObj(settings.sources) ? settings.sources[source] : null;
  const enabled = src && src.enabled;
  return source === "gcal" ? enabled === true : enabled !== false;
}

/**
 * One row's last-good-read evidence.
 * @param {any} state @param {string} source @param {any} row
 * @returns {{done: boolean, lastOkAt: string | null}}
 */
function rowRead(state, source, row) {
  const probes = isObj(state && state.probes) ? state.probes : {};
  const hit = isObj(probes[source]) ? probes[source][checkRowPage(source, row)] : null;
  const probeOk = !!(hit && hit.ok);
  const probeAt = probeOk && typeof hit.at === "string" ? hit.at : null;

  const scope = row && row.stat && row.stat.scope;
  const sourceSt = isObj(state && state.sourceState) ? state.sourceState[source] : null;
  const scopeOkAt =
    scope && isObj(sourceSt) && isObj(sourceSt.scopeOkAt) && typeof sourceSt.scopeOkAt[scope] === "string"
      ? sourceSt.scopeOkAt[scope]
      : null;

  const lastOkAt =
    probeAt && scopeOkAt ? (Date.parse(probeAt) >= Date.parse(scopeOkAt) ? probeAt : scopeOkAt)
    : probeAt || scopeOkAt;
  return { done: probeOk || !!scopeOkAt, lastOkAt };
}

/**
 * Essential rows of enabled sources — the first-run "Get set up" list.
 * @param {any} state  the panel/store state ({settings, probes, sourceState, userState})
 * @param {Date|number} [now]
 * @returns {Array<{source: string, row: any, done: boolean, lastOkAt: string | null}>}
 */
export function onboardingRows(state, now = new Date()) {
  /** @type {Array<{source: string, row: any, done: boolean, lastOkAt: string | null}>} */
  const out = [];
  const settings = state && state.settings;
  for (const [source, entry] of Object.entries(CHECK_SOURCES)) {
    if (!sourceEnabled(settings, source)) continue;
    for (const row of entry.checklist || []) {
      if (!row || row.essential !== true) continue;
      const { done, lastOkAt } = rowRead(state, source, row);
      out.push({ source, row, done, lastOkAt });
    }
  }
  return out;
}

/**
 * "Needs a visit" rows: enabled sources, refreshDays set, a good read exists
 * but is older than refreshDays. Never-read rows are onboarding's job.
 * Snoozed rows (userState.nudgeSnooze["<source>:<rowId>"] > now) drop out.
 * Sorted oldest first.
 * @param {any} state @param {Date|number} [now]
 * @returns {Array<{source: string, row: any, lastOkAt: string, ageDays: number}>}
 */
export function nudges(state, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const settings = state && state.settings;
  const snooze = isObj(state && state.userState) && isObj(state.userState.nudgeSnooze)
    ? state.userState.nudgeSnooze
    : {};
  /** @type {Array<{source: string, row: any, lastOkAt: string, ageDays: number}>} */
  const out = [];
  for (const [source, entry] of Object.entries(CHECK_SOURCES)) {
    if (!sourceEnabled(settings, source)) continue;
    for (const row of entry.checklist || []) {
      if (!row || typeof row.refreshDays !== "number" || row.refreshDays <= 0) continue;
      const { done, lastOkAt } = rowRead(state, source, row);
      if (!done || !lastOkAt) continue; // never read -> the onboarding card owns it
      const at = Date.parse(lastOkAt);
      if (Number.isNaN(at)) continue;
      const ageDays = (nowMs - at) / DAY_MS;
      if (ageDays <= row.refreshDays) continue;
      const snoozedUntil = snooze[`${source}:${row.id}`];
      if (snoozedUntil && Date.parse(snoozedUntil) > nowMs) continue;
      out.push({ source, row, lastOkAt, ageDays });
    }
  }
  out.sort((a, b) => Date.parse(a.lastOkAt) - Date.parse(b.lastOkAt));
  return out;
}
