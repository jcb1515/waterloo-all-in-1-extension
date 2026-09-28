// @ts-check
/*
  Everything the engine keeps lives in chrome.storage.local on this computer:

    wa1Settings   the student's choices (theme, profile, per-source settings)
    raw:<source>  latest data per source, pre-cross-source merge:
                  { items, applications, courses, terms, updatedAt }
    sourceState   { [source]: { state, lastRunAt, lastOkAt, session, error,
                    complete, failures, backoffUntil, itemCount } }
    items         Record<canonicalId, Item> — the merged view the UI reads
    todos         Record<id, Item> — derived auto to-dos (core/todos.js);
                  outside the merge engine's raws
    links         Record<rawItemId, canonicalId>
    uidMap        Record<canonicalId, {uid, seq, hash}> — calendar identity
    applications  Record<id, Application>
    courses       Record<code, Course>
    terms         Record<termCode, TermInfo>
    projects      Project[] — user projects (core/projects.js); their items
                  live in the manual raw with meta.projectId
    updates       Update[] ring buffer, newest first, max 300
    userState     Record<canonicalId, { done?, doneAt?, notes?, subtasks?,
                    estimateMin?, snoozedUntil?, hidden?, review? }>
    calendarFeed  runtime state for the feed publish client:
                  { serviceUrl, feedId, updateToken, feedUrl, groupFeeds,
                    expiresAt, lastPublishedAt, lastPayloadHash, eventCount,
                    accepted, skipped, status, error, needsResubscribe,
                    retryAt, failures }
                  The updateToken and feed URLs are secrets — never log them.
    outlineFiles  imported outline pages:
                  [{id, name, kind: "html"|"pdf", size, addedAt, html?|base64?}]
    log:<source>  the last 100 {at, message} lines per source

  Every write goes through one promise queue so writers can't interleave.
  The discovery recorder's keys (discovery:*, discoverySettings) live in
  capture/discovery-store.js and are untouched here.
*/

import { SOURCE_IDS } from "./contract.js";

export const SETTINGS_KEY = "wa1Settings";
export const rawKey = (/** @type {string} */ s) => `raw:${s}`;
export const logKey = (/** @type {string} */ s) => `log:${s}`;
export const MAX_UPDATES = 300;
const MAX_LOG = 100;

export const DEFAULT_SETTINGS = {
  version: 1,
  theme: "system",
  density: "comfortable",
  termCode: 1269,
  profile: {
    sections: {},
    groups: {},
  },
  sources: {
    outline: {
      enabled: true,
      urls: {},
    },
    discord: {
      enabled: true,
      watched: {},
    },
  },
  agenda: { showClasses: "today" },
  // Derived to-dos (core/todos.js): auto-created tasks that complete on their own.
  todos: {
    study: {
      enabled: true,
      leadDays: { quiz: 2, midterm: 5, final: 7, exam: 5, presentation: 3 },
    },
    coop: true,
    deadlines: true,
    replies: true,
    includeInCalendar: false,
  },
  panel: {
    tabs: null, // null = default order; [{id, visible}] when customised
  },
  // Review queue: showPending treats text-found dates as accepted without a
  // trip through the Review tab (dismissed items still hide).
  review: { showPending: false },
  reminders: {
    enabled: true,
    // Minutes before the item's anchor. [] = no reminders for that type.
    leads: {
      deadline: [1440, 120],
      quiz: [1440, 60],
      exam: [4320, 1440],
      presentation: [1440],
      interview: [1440, 60],
      "application-deadline": [1440, 180],
      "offer-deadline": [1440, 180],
      meeting: [30],
      task: [1440],
      lab: [120],
      class: [],
      tutorial: [],
      event: [60],
      "cycle-date": [1440],
    },
    quietHours: { enabled: true, start: "23:00", end: "08:00" },
    briefing: { enabled: true, time: "08:00" },
    digest: { enabled: true, day: "sun", time: "18:00" },
    includeTentative: false,
    // "Pause reminders until" — an ISO string or null. Deferred reminders
    // fire at pause end; ones whose event passed are dropped.
    pausedUntil: null,
  },
  calendar: {
    enabled: false,
    serviceUrl: "",
    split: false,
    include: { classes: true, tentative: true, completed: true, termDates: true, classWeeks: 8 },
    alarms: false,
  },
};

/*
  Local developer profile: when a dev-profile.json exists at the repo root,
  tools/build.mjs bakes it into the bundle as __WA1_DEV_PROFILE__. It sits
  between DEFAULT_SETTINGS and the stored wa1Settings, so personal defaults
  (sections, outline URLs, watched servers) stay out of the shipped source.
*/
const DEV_PROFILE =
  typeof __WA1_DEV_PROFILE__ === "undefined" ? null : __WA1_DEV_PROFILE__;

/*
  Build-time calendar service URL: a released build can ship a hosted feed
  server (set WA1_CALENDAR_SERVICE_URL in the environment when building), the
  same way gurshh's calendar-service-config.js worked. It overrides the dev
  profile's calendar.serviceUrl; the user's saved setting still wins.
*/
const BUILD_SERVICE_URL =
  typeof __WA1_CALENDAR_SERVICE_URL__ === "undefined" ? "" : __WA1_CALENDAR_SERVICE_URL__;

/** The compiled-in shared calendar server URL ("" when the build sets none). */
export const BUILT_IN_SERVICE_URL = BUILD_SERVICE_URL;

/**
 * `defaults` deep-merged with a developer profile: plain objects merge,
 * arrays and scalars replace. Pure — used by getSettings and the UI client.
 * @param {Record<string, any>} defaults
 * @param {Record<string, any> | null | undefined} profile
 */
export function withDevProfile(defaults, profile) {
  return deepMerge(defaults, isObj(profile) ? profile : {});
}

/* --------------------------- write queue --------------------------- */

let queue = Promise.resolve();
/**
 * Serialises every storage write.
 * @param {() => Promise<any>} fn
 */
export function enqueue(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Keys holding whole user-edited tables (course -> value maps): a stored
 * value replaces the inherited one outright, so deleting a row in the UI
 * doesn't resurrect the default/dev-profile row.
 */
const REPLACE_KEYS = new Set(["sections", "groups", "urls", "watched"]);

/** Recursive merge for plain-object values; arrays and scalars overwrite. */
export function deepMerge(base, patch) {
  const out = { ...(isObj(base) ? base : {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (REPLACE_KEYS.has(k) && isObj(v)) {
      out[k] = v;
    } else {
      out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
    }
  }
  return out;
}

/* --------------------------- settings --------------------------- */

/**
 * Effective settings for `saved`: DEFAULT_SETTINGS + the baked-in developer
 * profile (if any) + the user's stored settings, in that order.
 * @param {any} saved raw wa1Settings value
 */
export function resolveSettings(saved) {
  let base = withDevProfile(DEFAULT_SETTINGS, DEV_PROFILE);
  if (BUILD_SERVICE_URL) {
    base = deepMerge(base, { calendar: { serviceUrl: BUILD_SERVICE_URL } });
  }
  const s = isObj(saved) ? { ...saved } : {};
  // A saved "" means "use the built-in server", not "no server" — otherwise a
  // blank field would shadow the shared server the build ships with.
  if (BUILD_SERVICE_URL && isObj(s.calendar) && s.calendar.serviceUrl === "") {
    const { serviceUrl: _dropped, ...rest } = s.calendar;
    s.calendar = rest;
  }
  return deepMerge(base, s);
}

/** Settings deep-merged over DEFAULT_SETTINGS (+ dev profile). */
export async function getSettings() {
  const { [SETTINGS_KEY]: saved } = await chrome.storage.local.get(SETTINGS_KEY);
  return resolveSettings(saved);
}

/**
 * @param {Record<string, any> | ((s: any) => any)} patchOrFn an object is
 *   deep-merged; a function gets a clone of the current settings and returns
 *   the next settings (or mutates the clone).
 */
export async function setSettings(patchOrFn) {
  return enqueue(async () => {
    const current = await getSettings();
    const next =
      typeof patchOrFn === "function"
        ? patchOrFn(structuredClone(current)) || current
        : deepMerge(current, patchOrFn);
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  });
}

/* --------------------------- generic keys --------------------------- */

/**
 * @param {string} key
 * @returns {Promise<any>}
 */
export async function getLocal(key) {
  const all = await chrome.storage.local.get(key);
  return all[key];
}

/**
 * @param {string} key
 * @param {any} value
 */
export async function setLocal(key, value) {
  return enqueue(() => chrome.storage.local.set({ [key]: value }));
}

/**
 * Reads-modifies-writes one key inside the write queue.
 * @param {string} key
 * @param {(cur: any) => any} fn return the new value (or a promise of it)
 */
export async function mutateKey(key, fn) {
  return enqueue(async () => {
    const cur = (/** @type {Record<string, any>} */ (await chrome.storage.local.get(key)))[key];
    const next = await fn(cur);
    if (next === undefined) return cur;
    await chrome.storage.local.set({ [key]: next });
    return next;
  });
}

/** Everything recompute needs in one read. */
export async function getMergedView() {
  const keys = [
    "items", "todos", "links", "uidMap", "applications", "courses", "terms",
    "userState", "updates", "sourceState", "projects",
    ...SOURCE_IDS.map(rawKey),
  ];
  const all = /** @type {Record<string, any>} */ (await chrome.storage.local.get(keys));
  /** @type {Record<string, any>} */
  const raws = {};
  for (const id of SOURCE_IDS) if (all[rawKey(id)]) raws[id] = all[rawKey(id)];
  return {
    raws,
    items: isObj(all.items) ? all.items : {},
    todos: isObj(all.todos) ? all.todos : {},
    links: isObj(all.links) ? all.links : {},
    uidMap: isObj(all.uidMap) ? all.uidMap : {},
    applications: isObj(all.applications) ? all.applications : {},
    courses: isObj(all.courses) ? all.courses : {},
    terms: isObj(all.terms) ? all.terms : {},
    userState: isObj(all.userState) ? all.userState : {},
    updates: Array.isArray(all.updates) ? all.updates : [],
    sourceState: isObj(all.sourceState) ? all.sourceState : {},
    projects: Array.isArray(all.projects) ? all.projects : [],
  };
}

/**
 * Newest-first ring buffer of Update records.
 * @param {any[]} list new updates (newest first is fine)
 */
export async function pushUpdates(list) {
  if (!list || !list.length) return;
  return mutateKey("updates", (cur) => [...list, ...(Array.isArray(cur) ? cur : [])].slice(0, MAX_UPDATES));
}

/**
 * @param {string} source
 * @param {string} message
 */
export async function appendLog(source, message) {
  const line = { at: new Date().toISOString(), message: String(message).slice(0, 300) };
  return mutateKey(logKey(source), (cur) => [line, ...(Array.isArray(cur) ? cur : [])].slice(0, MAX_LOG));
}

/**
 * Merges a patch into one item's userState.
 * @param {string} id canonical item id
 * @param {Record<string, any>} patch
 */
export async function patchUserState(id, patch) {
  return mutateKey("userState", (cur) => {
    const all = isObj(cur) ? { ...cur } : {};
    all[id] = { ...(isObj(all[id]) ? all[id] : {}), ...(patch || {}) };
    return all;
  });
}

/* --------------------------- migration --------------------------- */

/**
 * On install/update: drop WATnow's keys. The discovery recorder's keys
 * (discovery:*, discoverySettings) and every wa1:* key are kept.
 */
export async function migrateStorage() {
  try {
    await chrome.storage.local.remove(["state", "settings", "catalog", "liveDebug"]);
    await chrome.storage.session.remove("filter");
  } catch (e) {
    console.warn("[wa1] storage migration", e);
  }
}
