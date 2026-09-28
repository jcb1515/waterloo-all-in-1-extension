// @ts-check
/*
  Store health check (pure). auditStore() reads a full chrome.storage.local
  snapshot and reports malformed data, duplicates the publish guard would
  still collapse, stale references, oversized keys and secrets hygiene.
  applySafeFixes() turns the fixable issues into {key: value} patches the
  background applies inside the store queue, then recomputes.

  Output:
    auditStore -> {summary, issues[]}
    issue      -> {id, severity: "error"|"warn"|"info", area, message,
                   count, fixable, sample?: string[] (ids only)}
*/

import { SOURCE_IDS, ITEM_TYPES } from "./contract.js";
import {
  typesCompatible,
  titleSimilarity,
  orgsCompatible,
  sameLocalDay,
} from "./merge.js";
import { DEFAULT_SETTINGS, MAX_UPDATES, SETTINGS_KEY } from "./store.js";

const DAY = 86400000;
const MIN = 60000;
/** Anchors farther than this from now are almost certainly parse errors. */
const FAR_ANCHOR_MS = 2 * 365 * DAY;
/** userState rows with no known item and no activity this old are orphans. */
const ORPHAN_USERSTATE_MS = 60 * DAY;
/** Reminder bookkeeping older than this is useless. */
const REMINDER_MAX_AGE_MS = 30 * DAY;
const MAX_LOG = 100;
/** sourceState[<s>].state above this warns (chrome.storage.local per-key fit). */
const STATE_WARN_BYTES = 1.5 * 1024 * 1024;
/** Total imported-outline size above this warns. */
const OUTLINE_WARN_BYTES = 8 * 1024 * 1024;
/** uidMap tombstones kept past the live entries. */
const UIDMAP_KEEP = 5000;
const SAMPLE_MAX = 5;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const bytes = (v) => {
  try {
    return JSON.stringify(v === undefined ? null : v).length;
  } catch {
    return 0;
  }
};
const parseMs = (v) => {
  const ms = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isNaN(ms) ? null : ms;
};
const anchorMsOf = (i) => parseMs(i && (i.dueAt || i.startAt));

/** The latest parseable timestamp anywhere in a userState entry, or null. */
function userStateActivity(us) {
  /** @type {number | null} */
  let best = null;
  const walk = (v) => {
    if (typeof v === "string") {
      const ms = parseMs(v);
      if (ms != null && (best == null || ms > best)) best = ms;
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x);
    } else if (isObj(v)) {
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(us);
  return best;
}

const SOURCE_SET = new Set(SOURCE_IDS);
const TYPE_SET = new Set(ITEM_TYPES);

/**
 * @param {Record<string, any>} snapshot  the whole of chrome.storage.local
 * @param {Date} [now]
 * @returns {{summary: {keys: number, bytes: number, items: number,
 *   rawItems: number, todos: number, projects: number}, issues: any[]}}
 */
export function auditStore(snapshot = {}, now = new Date()) {
  const t = now.getTime();
  /** @type {any[]} */
  const issues = [];
  const issue = (/** @type {string} */ id, /** @type {string} */ severity, /** @type {string} */ area, /** @type {string} */ message, /** @type {{count?: number, fixable?: boolean, sample?: string[]}} */ opts = {}) =>
    issues.push({
      id,
      severity,
      area,
      message,
      count: opts.count != null ? opts.count : 1,
      fixable: !!opts.fixable,
      ...(opts.sample && opts.sample.length ? { sample: opts.sample.slice(0, SAMPLE_MAX) } : {}),
    });

  const items = isObj(snapshot.items) ? snapshot.items : {};
  const todos = isObj(snapshot.todos) ? snapshot.todos : {};
  const projects = Array.isArray(snapshot.projects) ? snapshot.projects : [];
  const userState = isObj(snapshot.userState) ? snapshot.userState : {};
  const uidMap = isObj(snapshot.uidMap) ? snapshot.uidMap : {};
  const updates = Array.isArray(snapshot.updates) ? snapshot.updates : [];
  const sourceState = isObj(snapshot.sourceState) ? snapshot.sourceState : {};
  const outlineFiles = Array.isArray(snapshot.outlineFiles) ? snapshot.outlineFiles : [];

  const rawKeys = Object.keys(snapshot).filter((k) => k.startsWith("raw:"));
  /** @type {Record<string, any>} */
  const raws = {};
  let rawItems = 0;
  for (const k of rawKeys) raws[k] = snapshot[k];
  const manualIds = new Set(
    ((raws["raw:manual"] && raws["raw:manual"].items) || [])
      .map((i) => i && i.id)
      .filter(Boolean)
  );
  const liveIds = new Set([...Object.keys(items), ...Object.keys(todos), ...manualIds]);

  /* -------------------------------- summary ------------------------------- */

  const summary = {
    keys: Object.keys(snapshot).length,
    bytes: bytes(snapshot),
    items: Object.keys(items).length,
    rawItems: 0,
    todos: Object.keys(todos).length,
    projects: projects.length,
  };

  /* --------------------------------- items --------------------------------- */

  /** @type {string[]} */
  const malformed = [];
  /** @type {string[]} */
  const farAnchors = [];
  /** @type {string[]} */
  const staleSeenIn = [];

  for (const it of [...Object.values(items), ...Object.values(todos)]) {
    if (!it) continue;
    let bad = false;
    if (!it.id) bad = true;
    if (!TYPE_SET.has(it.type)) bad = true;
    if (!SOURCE_SET.has(it.source)) bad = true;
    const start = parseMs(it.startAt);
    const end = parseMs(it.endAt);
    if (
      (it.dueAt != null && parseMs(it.dueAt) == null) ||
      (it.startAt != null && start == null) ||
      (it.endAt != null && end == null) ||
      (start != null && end != null && end < start)
    ) {
      bad = true;
    }
    if (bad) {
      malformed.push(String(it.id || "?"));
      continue;
    }
    const a = anchorMsOf(it);
    if (a != null && Math.abs(a - t) > FAR_ANCHOR_MS) farAnchors.push(it.id);
    if (Array.isArray(it.seenIn)) {
      for (const s of it.seenIn) {
        const src = s && s.source;
        if (src && SOURCE_SET.has(src) && !(raws[`raw:${src}`] && raws[`raw:${src}`].items)) {
          staleSeenIn.push(it.id);
          break;
        }
      }
    }
  }
  if (malformed.length) {
    issue("items-malformed", "error", "items",
      `${malformed.length} item(s) have a missing/unknown id, type, source, or an unparseable or inverted date`,
      { count: malformed.length, sample: malformed });
  }
  if (farAnchors.length) {
    issue("items-far-anchor", "warn", "items",
      `${farAnchors.length} item(s) are anchored more than 2 years from now`,
      { count: farAnchors.length, sample: farAnchors });
  }
  if (staleSeenIn.length) {
    issue("items-stale-seenin", "warn", "items",
      `${staleSeenIn.length} item(s) reference a source raw that no longer exists`,
      { count: staleSeenIn.length, sample: staleSeenIn });
  }

  /* ------------------------------- duplicates ------------------------------ */

  // The publish-guard rule: compatible types, same start (timed ±5 min;
  // all-day same Toronto date), title similarity >= 0.6, compatible orgs.
  /** @type {string[]} */
  const dupSamples = [];
  let dupCount = 0;
  const dated = Object.values(items)
    .filter((i) => i && i.id && anchorMsOf(i) != null)
    .sort((a, b) => /** @type {number} */ (anchorMsOf(a)) - /** @type {number} */ (anchorMsOf(b)));
  for (let i = 0; i < dated.length; i++) {
    const a = dated[i];
    const aMs = /** @type {number} */ (anchorMsOf(a));
    for (let j = i + 1; j < dated.length; j++) {
      const b = dated[j];
      const bMs = /** @type {number} */ (anchorMsOf(b));
      // Sorted sweep: stop once anchors are more than a day apart (covers the
      // all-day same-day case without a zone library).
      if (bMs - aMs > DAY) break;
      if (!typesCompatible(a.type, b.type)) continue;
      if (titleSimilarity(a.title, a.org, b.title, b.org) < 0.6) continue;
      if (!orgsCompatible(a.org, b.org)) continue;
      const bothAllDay = a.allDay || b.allDay || (!a.startAt && !b.startAt);
      const sameAnchor = bothAllDay
        ? sameLocalDay(a.dueAt || a.startAt, b.dueAt || b.startAt)
        : Math.abs(aMs - bMs) <= 5 * MIN;
      if (!sameAnchor) continue;
      dupCount++;
      if (dupSamples.length < SAMPLE_MAX) dupSamples.push(`${a.id} ~ ${b.id}`);
    }
  }
  if (dupCount) {
    issue("duplicates", "warn", "items",
      `${dupCount} pair(s) look like the same event to the publish guard — check them in the Agenda`,
      { count: dupCount, sample: dupSamples });
  }

  /* ---------------------------------- raws ---------------------------------- */

  /** @type {string[]} */
  const badRaws = [];
  /** @type {string[]} */
  const unknownRaws = [];
  for (const [key, raw] of Object.entries(raws)) {
    const src = key.slice(4);
    if (!SOURCE_SET.has(/** @type {any} */ (src))) {
      unknownRaws.push(key);
      continue;
    }
    rawItems += raw && Array.isArray(raw.items) ? raw.items.length : 0;
    let bad = !isObj(raw) || !Array.isArray(raw.items);
    if (!bad) {
      for (const i of raw.items) {
        if (!i || !i.id || !TYPE_SET.has(i.type)) {
          bad = true;
          break;
        }
      }
    }
    if (bad) badRaws.push(key);
  }
  if (unknownRaws.length) {
    issue("raw-unknown", "warn", "raws",
      `Unknown raw key(s): ${unknownRaws.join(", ")}`,
      { count: unknownRaws.length, sample: unknownRaws });
  }
  if (badRaws.length) {
    issue("raw-malformed", "error", "raws",
      `${badRaws.length} raw source record(s) are not {items: [], updatedAt} or hold invalid items`,
      { count: badRaws.length, sample: badRaws });
  }

  /* --------------------------------- orphans -------------------------------- */

  /** @type {string[]} */
  const usOrphans = [];
  for (const [id, us] of Object.entries(userState)) {
    if (liveIds.has(id)) continue;
    const at = userStateActivity(us);
    if (at == null || at < t - ORPHAN_USERSTATE_MS) usOrphans.push(id);
  }
  if (usOrphans.length) {
    issue("userstate-orphans", "warn", "orphans",
      `${usOrphans.length} userState row(s) point at items that no longer exist and have had no activity for 60 days`,
      { count: usOrphans.length, fixable: true, sample: usOrphans });
  }

  /** @type {string[]} */
  const uidOrphans = Object.keys(uidMap).filter((id) => !liveIds.has(id));
  if (uidOrphans.length) {
    issue("uidmap-orphans", "warn", "orphans",
      `${uidOrphans.length} uidMap tombstone(s) point at items long gone (kept so a reappearing item reuses its calendar uid); prune keeps the newest ${UIDMAP_KEEP}`,
      { count: uidOrphans.length, fixable: true, sample: uidOrphans });
  }

  /** @type {string[]} */
  const staleReminders = [];
  for (const key of ["remindersSent", "reminderSnooze"]) {
    const map = isObj(snapshot[key]) ? snapshot[key] : {};
    for (const [k, at] of Object.entries(map)) {
      const ms = parseMs(at);
      if (ms == null || ms < t - REMINDER_MAX_AGE_MS) staleReminders.push(k);
    }
  }
  if (staleReminders.length) {
    issue("reminders-stale", "info", "orphans",
      `${staleReminders.length} reminder record(s) are older than 30 days`,
      { count: staleReminders.length, fixable: true, sample: staleReminders });
  }

  const projectIds = new Set(projects.map((p) => p && p.id));
  /** @type {string[]} */
  const projOrphans = [];
  for (const it of Object.values(items)) {
    const pid = it && it.meta && it.meta.projectId;
    if (pid && !projectIds.has(pid)) projOrphans.push(it.id);
  }
  if (projOrphans.length) {
    issue("projectitem-orphans", "warn", "orphans",
      `${projOrphans.length} item(s) belong to a project that no longer exists — fix clears their project link`,
      { count: projOrphans.length, fixable: true, sample: projOrphans });
  }

  /* ---------------------------------- caps ---------------------------------- */

  if (updates.length > MAX_UPDATES) {
    issue("updates-cap", "warn", "caps",
      `updates holds ${updates.length} entries (cap ${MAX_UPDATES})`,
      { count: updates.length - MAX_UPDATES, fixable: true });
  }
  /** @type {string[]} */
  const fatLogs = [];
  for (const key of Object.keys(snapshot)) {
    if (!key.startsWith("log:")) continue;
    const lines = snapshot[key];
    if (Array.isArray(lines) && lines.length > MAX_LOG) fatLogs.push(key);
  }
  if (fatLogs.length) {
    issue("log-cap", "warn", "caps",
      `${fatLogs.length} log key(s) hold more than ${MAX_LOG} lines`,
      { count: fatLogs.length, fixable: true, sample: fatLogs });
  }
  for (const [src, st] of Object.entries(sourceState)) {
    const n = bytes(st && st.state);
    if (n > STATE_WARN_BYTES) {
      issue(`sourcestate-big`, "warn", "caps",
        `sourceState.${src}.state is ${Math.round(n / 1024)} KiB — near the per-key limit`,
        { count: n });
    }
  }
  const outlineBytes = outlineFiles.reduce((n, f) => n + (typeof (f && f.size) === "number" ? f.size : bytes(f)), 0);
  if (outlineBytes > OUTLINE_WARN_BYTES) {
    issue("outlinefiles-big", "warn", "caps",
      `Imported outlines total ${Math.round(outlineBytes / 1024 / 1024)} MB`,
      { count: outlineFiles.length });
  }
  issue("storage-total", "info", "caps",
    `Storage holds ${Math.round(summary.bytes / 1024)} KiB across ${summary.keys} keys (unlimitedStorage is enabled)`,
    { count: summary.keys });

  /* -------------------------------- settings -------------------------------- */

  const saved = snapshot[SETTINGS_KEY];
  if (saved != null && !isObj(saved)) {
    issue("settings-malformed", "error", "settings",
      `${SETTINGS_KEY} is not an object`, {});
  } else if (isObj(saved)) {
    const unknown = Object.keys(saved).filter((k) => !(k in DEFAULT_SETTINGS));
    if (unknown.length) {
      issue("settings-unknown-keys", "info", "settings",
        `Unknown settings key(s): ${unknown.join(", ")}`,
        { count: unknown.length, sample: unknown });
    }
  }

  /* ------------------------------ secrets hygiene ----------------------------- */

  // calendarFeed.updateToken and Bearer strings must never leave calendarFeed.
  const SECRET_RE = /updateToken|Bearer\s+[A-Za-z0-9._~+/=-]{8,}/i;
  /** @type {string[]} */
  const leaks = [];
  for (const [key, value] of Object.entries(snapshot)) {
    if (key === "calendarFeed") continue;
    let text = "";
    try {
      text = JSON.stringify(value);
    } catch {
      continue;
    }
    if (typeof text === "string" && SECRET_RE.test(text)) leaks.push(key);
  }
  // A dev profile must live in the bundle, not in storage.
  if (Object.keys(snapshot).some((k) => /dev[-_]?profile/i.test(k))) {
    leaks.push("developer profile key");
  }
  if (leaks.length) {
    issue("secrets-leak", "error", "secrets",
      `Token-like data found outside calendarFeed: ${leaks.join(", ")}`,
      { count: leaks.length, sample: leaks });
  }

  summary.rawItems = rawItems;
  return { summary, issues };
}

/* ----------------------------------- fixes ----------------------------------- */

/**
 * Patches for the fixable issues. Pure: returns `{key: nextValue}` — the
 * background writes them inside the store queue, then recomputes. Issues the
 * caller passes that aren't fixable are ignored; `issueIds` omitted means
 * "every fixable issue the snapshot currently has".
 * @param {Record<string, any>} snapshot
 * @param {string[]} [issueIds]
 * @param {Date} [now]
 * @returns {Record<string, any>}
 */
export function applySafeFixes(snapshot = {}, issueIds, now = new Date()) {
  const { issues } = auditStore(snapshot, now);
  const wanted = new Set(
    (issueIds || issues.filter((i) => i.fixable).map((i) => i.id))
  );
  /** @type {Record<string, any>} */
  const patches = {};
  const t = now.getTime();
  const has = (id) => wanted.has(id) && issues.some((i) => i.id === id && i.fixable);

  if (has("userstate-orphans")) {
    const items = isObj(snapshot.items) ? snapshot.items : {};
    const todos = isObj(snapshot.todos) ? snapshot.todos : {};
    const manual = (snapshot["raw:manual"] && snapshot["raw:manual"].items) || [];
    const live = new Set([...Object.keys(items), ...Object.keys(todos), ...manual.map((i) => i && i.id)]);
    const us = { ...(isObj(snapshot.userState) ? snapshot.userState : {}) };
    for (const id of Object.keys(us)) {
      if (live.has(id)) continue;
      const at = userStateActivity(us[id]);
      if (at == null || at < t - ORPHAN_USERSTATE_MS) delete us[id];
    }
    patches.userState = us;
  }

  if (has("uidmap-orphans")) {
    const items = isObj(snapshot.items) ? snapshot.items : {};
    const todos = isObj(snapshot.todos) ? snapshot.todos : {};
    const manual = (snapshot["raw:manual"] && snapshot["raw:manual"].items) || [];
    const live = new Set([...Object.keys(items), ...Object.keys(todos), ...manual.map((i) => i && i.id)]);
    const entries = Object.entries(isObj(snapshot.uidMap) ? snapshot.uidMap : {});
    // Drop tombstones whose item is long gone; keep the newest UIDMAP_KEEP
    // of what's left so a reappearing item can still reuse its calendar uid.
    const keep = entries.filter(([id]) => live.has(id));
    patches.uidMap = Object.fromEntries(keep.slice(-UIDMAP_KEEP));
  }

  if (has("reminders-stale")) {
    for (const key of ["remindersSent", "reminderSnooze"]) {
      const map = isObj(snapshot[key]) ? snapshot[key] : null;
      if (!map) continue;
      const next = {};
      for (const [k, at] of Object.entries(map)) {
        const ms = parseMs(at);
        if (ms != null && ms >= t - REMINDER_MAX_AGE_MS) next[k] = at;
      }
      patches[key] = next;
    }
  }

  if (has("projectitem-orphans")) {
    const projects = Array.isArray(snapshot.projects) ? snapshot.projects : [];
    const pids = new Set(projects.map((p) => p && p.id));
    const items = isObj(snapshot.items) ? snapshot.items : {};
    const orphanIds = new Set(
      Object.values(items)
        .filter((i) => i && i.meta && i.meta.projectId && !pids.has(i.meta.projectId))
        .map((i) => i.id)
    );
    if (orphanIds.size) {
      const raw = snapshot["raw:manual"];
      if (raw && Array.isArray(raw.items)) {
        patches["raw:manual"] = {
          ...raw,
          items: raw.items.map((i) =>
            i && orphanIds.has(i.id) && i.meta
              ? { ...i, meta: { ...i.meta, projectId: undefined } }
              : i
          ),
        };
      }
    }
  }

  if (has("updates-cap") && Array.isArray(snapshot.updates)) {
    patches.updates = snapshot.updates.slice(0, MAX_UPDATES);
  }

  if (has("log-cap")) {
    for (const key of Object.keys(snapshot)) {
      if (!key.startsWith("log:")) continue;
      const lines = snapshot[key];
      if (Array.isArray(lines) && lines.length > MAX_LOG) {
        patches[key] = lines.slice(-MAX_LOG);
      }
    }
  }

  return patches;
}
