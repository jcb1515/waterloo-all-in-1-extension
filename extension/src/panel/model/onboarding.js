// @ts-check
/*
  Pure onboarding + nudge model (v2 additions). Drives two UI surfaces:
   - "Get set up" card: essential checklist rows of enabled sources that have
     never had a good read;
   - "Needs a visit" nudges: refreshDays rows whose last good read is stale.

  A row's "last good read" is the newest of:
   - probes[source][rowPage].ok's `at` (the DOM/structure probe),
   - sourceState[source].scopeOkAt[row.stat.scope] (written by the ingest on
     every successful observe/sync with items), and
   - sourceState[source].scopeReadAt[row.stat.scope] (written on every
     successful read — even a read that returned zero items).

  A row is also "done" once the user opened it via the card:
  userState.onboardingOpened["<source>:<rowId>"] = ISO timestamp.

  No DOM, no chrome.* — tests drive it directly.
*/

import { CHECK_SOURCES, checkRowPage } from "../../sources/probes.js";

const DAY_MS = 86400000;
const OPENED_WAIT_MS = 30 * 60000;

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
 * The scope keys a row can be evidenced under — mirrors the Check view's
 * fallback chain: stat.scope, then the row id, then "sync" for sync rows
 * (rows like learn-home have no stat.scope; a learn sync stamps "sync").
 * @param {any} row
 * @returns {string[]}
 */
export function rowScopes(row) {
  const stat = row && row.stat;
  /** @type {string[]} */
  const out = [];
  if (stat && typeof stat.scope === "string" && stat.scope) out.push(stat.scope);
  if (row && typeof row.id === "string" && row.id && !out.includes(row.id)) out.push(row.id);
  if (stat && stat.kind === "sync" && !out.includes("sync")) out.push("sync");
  return out;
}

/**
 * One row's last-good-read evidence: the newest of the probe's ok `at`,
 * scopeOkAt[scope] and scopeReadAt[scope] over the row's scope candidates.
 * Null when nothing read it yet.
 * @param {any} state @param {string} source @param {any} row
 * @returns {string | null}
 */
export function lastGoodRead(state, source, row) {
  const probes = isObj(state && state.probes) ? state.probes : {};
  const hit = isObj(probes[source]) ? probes[source][checkRowPage(source, row)] : null;
  const probeAt = !!(hit && hit.ok) && typeof hit.at === "string" ? hit.at : null;

  const sourceSt = isObj(state && state.sourceState) ? state.sourceState[source] : null;

  let best = probeAt || null;
  if (isObj(sourceSt)) {
    for (const scope of rowScopes(row)) {
      for (const map of [sourceSt.scopeOkAt, sourceSt.scopeReadAt]) {
        const at = isObj(map) && typeof map[scope] === "string" ? map[scope] : null;
        if (at && (!best || Date.parse(at) > Date.parse(best))) best = at;
      }
    }
  }
  return best;
}

/**
 * userState.onboardingOpened lookup for one row.
 * @param {any} state @param {string} source @param {string} rowId
 * @returns {string | null}
 */
function rowOpenedAt(state, source, rowId) {
  const opened =
    isObj(state && state.userState) && isObj(state.userState.onboardingOpened)
      ? state.userState.onboardingOpened
      : null;
  const at = opened && opened[`${source}:${rowId}`];
  return typeof at === "string" && !Number.isNaN(Date.parse(at)) ? at : null;
}

/**
 * Essential rows of enabled sources — the first-run "Get set up" list.
 * done = read || opened; status distinguishes the two for the row UI.
 * @param {any} state  the panel/store state ({settings, probes, sourceState, userState})
 * @param {Date|number} [now]
 * @returns {Array<{source: string, row: any, read: boolean,
 *   openedAt: string | null, done: boolean,
 *   status: "read" | "opened" | "todo", lastOkAt: string | null}>}
 */
export function onboardingRows(state, now = new Date()) {
  /** @type {Array<{source: string, row: any, read: boolean, openedAt: string|null,
   *   done: boolean, status: "read"|"opened"|"todo", lastOkAt: string|null}>} */
  const out = [];
  const settings = state && state.settings;
  for (const [source, entry] of Object.entries(CHECK_SOURCES)) {
    if (!sourceEnabled(settings, source)) continue;
    for (const row of entry.checklist || []) {
      if (!row || row.essential !== true) continue;
      const lastOkAt = lastGoodRead(state, source, row);
      const openedAt = rowOpenedAt(state, source, row.id);
      const read = lastOkAt != null;
      out.push({
        source,
        row,
        read,
        openedAt,
        done: read || !!openedAt,
        status: read ? "read" : openedAt ? "opened" : "todo",
        lastOkAt,
      });
    }
  }
  return out;
}

/**
 * "Needs a visit" rows: enabled sources, refreshDays set, a good read exists
 * but is older than refreshDays. Never-read rows are onboarding's job.
 * `ignoreSnooze` drops the snooze check — the internal version sourceFreshness
 * uses so tiles and nudges share exactly the same staleness computation.
 * Sorted oldest first.
 * @param {any} state @param {Date|number} [now]
 * @param {{ignoreSnooze?: boolean}} [opts]
 * @returns {Array<{source: string, row: any, lastOkAt: string, ageDays: number}>}
 */
function nudgeRows(state, now = new Date(), opts = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const settings = state && state.settings;
  const snooze =
    !opts.ignoreSnooze && isObj(state && state.userState) && isObj(state.userState.nudgeSnooze)
      ? state.userState.nudgeSnooze
      : {};
  /** @type {Array<{source: string, row: any, lastOkAt: string, ageDays: number}>} */
  const out = [];
  for (const [source, entry] of Object.entries(CHECK_SOURCES)) {
    if (!sourceEnabled(settings, source)) continue;
    for (const row of entry.checklist || []) {
      if (!row || typeof row.refreshDays !== "number" || row.refreshDays <= 0) continue;
      const lastOkAt = lastGoodRead(state, source, row);
      if (!lastOkAt) continue; // never read -> the onboarding card owns it
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

/**
 * "Needs a visit" nudges — snoozed rows (userState.nudgeSnooze
 * ["<source>:<rowId>"] > now) drop out.
 * @param {any} state @param {Date|number} [now]
 */
export function nudges(state, now = new Date()) {
  return nudgeRows(state, now);
}

/**
 * One source's freshness — the single derivation the Sources tile badge and
 * the onboarding nudges share, so a tile can't disagree with the cards.
 * @param {any} state @param {string} source @param {Date|number} [now]
 * @returns {{key: "fresh"|"needs-visit"|"opened-nothing"|"opened-waiting"|"never",
 *   lastReadAt: string | null}}
 */
export function sourceFreshness(state, source, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const entry = CHECK_SOURCES[source] || { checklist: [] };

  // lastReadAt = newest lastGoodRead over this source's checklist rows, plus
  // the adapter-level lastOkAt.
  /** @type {string | null} */
  let lastReadAt = null;
  for (const row of entry.checklist || []) {
    const at = lastGoodRead(state, source, row);
    if (at && (!lastReadAt || Date.parse(at) > Date.parse(lastReadAt))) lastReadAt = at;
  }
  const srcSt = isObj(state && state.sourceState) ? state.sourceState[source] : null;
  const srcOk = srcSt && typeof srcSt.lastOkAt === "string" ? srcSt.lastOkAt : null;
  if (srcOk && (!lastReadAt || Date.parse(srcOk) > Date.parse(lastReadAt))) lastReadAt = srcOk;

  // Staleness uses the same computation the nudge list uses — a source is
  // "needs-visit" exactly when its un-snoozed refreshDays rows are stale.
  const stale = nudgeRows(state, now, { ignoreSnooze: true }).some((n) => n.source === source);
  if (stale) return { key: "needs-visit", lastReadAt };
  if (lastReadAt) return { key: "fresh", lastReadAt };

  // Never read: bucket by how long ago the user last opened a row.
  let newestOpened = -Infinity;
  for (const row of entry.checklist || []) {
    const at = rowOpenedAt(state, source, row.id);
    if (at) newestOpened = Math.max(newestOpened, Date.parse(at));
  }
  if (Number.isFinite(newestOpened)) {
    return {
      key: nowMs - newestOpened > OPENED_WAIT_MS ? "opened-nothing" : "opened-waiting",
      lastReadAt,
    };
  }
  return { key: "never", lastReadAt };
}
