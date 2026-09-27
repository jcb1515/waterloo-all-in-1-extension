// @ts-check
/*
  Everything the engine keeps lives in chrome.storage.local on this computer:

    wa1Settings   the student's choices (theme, profile, per-source settings)
    raw:<source>  latest data per source, pre-cross-source merge:
                  { items, applications, courses, terms, updatedAt }
    sourceState   { [source]: { state, lastRunAt, lastOkAt, session, error,
                    complete, failures, backoffUntil, itemCount } }
    items         Record<canonicalId, Item> — the merged view the UI reads
    links         Record<rawItemId, canonicalId>
    uidMap        Record<canonicalId, {uid, seq, hash}> — calendar identity
    applications  Record<id, Application>
    courses       Record<code, Course>
    terms         Record<termCode, TermInfo>
    updates       Update[] ring buffer, newest first, max 300
    userState     Record<canonicalId, { done?, doneAt?, notes?, subtasks?,
                    estimateMin?, snoozedUntil?, hidden?, review? }>
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
};

/*
  Local developer profile: when a dev-profile.json exists at the repo root,
  tools/build.mjs bakes it into the bundle as __WA1_DEV_PROFILE__. It sits
  between DEFAULT_SETTINGS and the stored wa1Settings, so personal defaults
  (sections, outline URLs, watched servers) stay out of the shipped source.
*/
const DEV_PROFILE =
  typeof __WA1_DEV_PROFILE__ === "undefined" ? null : __WA1_DEV_PROFILE__;

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
function deepMerge(base, patch) {
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
  return deepMerge(withDevProfile(DEFAULT_SETTINGS, DEV_PROFILE), isObj(saved) ? saved : {});
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
    "items", "links", "uidMap", "applications", "courses", "terms",
    "userState", "updates", "sourceState",
    ...SOURCE_IDS.map(rawKey),
  ];
  const all = /** @type {Record<string, any>} */ (await chrome.storage.local.get(keys));
  /** @type {Record<string, any>} */
  const raws = {};
  for (const id of SOURCE_IDS) if (all[rawKey(id)]) raws[id] = all[rawKey(id)];
  return {
    raws,
    items: isObj(all.items) ? all.items : {},
    links: isObj(all.links) ? all.links : {},
    uidMap: isObj(all.uidMap) ? all.uidMap : {},
    applications: isObj(all.applications) ? all.applications : {},
    courses: isObj(all.courses) ? all.courses : {},
    terms: isObj(all.terms) ? all.terms : {},
    userState: isObj(all.userState) ? all.userState : {},
    updates: Array.isArray(all.updates) ? all.updates : [],
    sourceState: isObj(all.sourceState) ? all.sourceState : {},
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
