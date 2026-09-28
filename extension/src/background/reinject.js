// @ts-check
/*
  Content-script re-injection. MV3 does NOT re-run content scripts in tabs
  that were open before an install/update (and an extension reload orphans
  the injected copies). On install, update and startup we re-execute every
  manifest content script and every dynamically registered (optional) one
  in matching live tabs — the guard handshake in capture/guard.js keeps a
  live copy from running twice.

  chrome.* is injected (`deps`) so this is unit-testable.
*/

import { SITE_BY_HOST } from "../core/contract.js";

/** A normalised script entry: manifest entries use all_frames, registered
 *  ones use allFrames. */
function normEntry(e) {
  if (!e || !Array.isArray(e.matches) || !e.matches.length) return null;
  const js = Array.isArray(e.js) ? e.js : [];
  if (!js.length) return null;
  return {
    matches: e.matches,
    js,
    allFrames: !!(e.all_frames ?? e.allFrames),
    world: e.world === "MAIN" ? "MAIN" : "ISOLATED",
  };
}

/**
 * Every declared + registered content-script entry, normalised.
 * @param {{manifest?: any, scripting?: any}} deps
 */
async function scriptEntries(deps) {
  const manifest = (((deps.manifest || {}).content_scripts) || [])
    .map(normEntry)
    .filter(Boolean);
  let registered = [];
  try {
    if (deps.scripting && deps.scripting.getRegisteredContentScripts) {
      registered = ((await deps.scripting.getRegisteredContentScripts()) || [])
        .map(normEntry)
        .filter(Boolean);
    }
  } catch {
    /* scripting unavailable — manifest entries still run */
  }
  return [...manifest, ...registered];
}

/** Host part of a match pattern ("https://*.x.com/*" → "*.x.com"), or null. */
function matchHost(pattern) {
  const m = /^[a-z]+:\/\/([^/]+)\//.exec(String(pattern || ""));
  return m ? m[1] : null;
}

/**
 * Does a match-pattern host belong to `sourceId`? Exact hosts go through
 * SITE_BY_HOST; "*.<host>" patterns compare by suffix; a bare "*" applies
 * to every source.
 */
function hostForSource(host, sourceId) {
  if (!host) return false;
  if (host === "*") return true;
  if (host.startsWith("*.")) {
    const suffix = host.slice(1); // ".x.com"
    return Object.entries(SITE_BY_HOST).some(
      ([h, s]) => s === sourceId && (h === host.slice(2) || h.endsWith(suffix)),
    );
  }
  return /** @type {Record<string, string>} */ (SITE_BY_HOST)[host] === sourceId;
}

/**
 * Re-run `entry`'s scripts in one tab.
 * @param {any} deps {scripting}
 */
async function injectInto(tabId, entry, deps) {
  await deps.scripting.executeScript({
    target: { tabId, allFrames: !!entry.allFrames },
    files: entry.js,
    world: entry.world === "MAIN" ? "MAIN" : "ISOLATED",
  });
}

/**
 * Re-execute every manifest + registered content script in open tabs whose
 * URL matches. Skips discarded and "unloaded" tabs; one failing tab never
 * stops the rest.
 * @param {any} deps {tabs: {query}, scripting: {executeScript,
 *   getRegisteredContentScripts?}, manifest?: any}
 * @returns {Promise<number[]>} tab ids that got a script
 */
export async function reinjectAll(deps) {
  const entries = await scriptEntries(deps);
  /** @type {Set<number>} */
  const done = new Set();
  for (const entry of entries) {
    let tabs = [];
    try {
      tabs = await deps.tabs.query({ url: entry.matches });
    } catch {
      continue;
    }
    for (const tab of tabs || []) {
      if (!tab || tab.id == null || tab.discarded || tab.status === "unloaded") continue;
      try {
        await injectInto(tab.id, entry, deps);
        done.add(tab.id);
      } catch {
        /* tab raced away, or a page scripting can't touch — skip it */
      }
    }
  }
  return [...done];
}

/**
 * Re-inject one tab's scripts — only the entries whose match hosts belong
 * to `sourceId`. Used by check-now when a long-open tab has no live
 * content script (its copy was orphaned by an extension reload).
 * @param {number} tabId @param {string} sourceId @param {any} deps
 *   {tabs: {get}, scripting, manifest?}
 * @returns {Promise<number>} how many entries were injected
 */
export async function reinjectTab(tabId, sourceId, deps) {
  /** @type {any} */
  let tab = null;
  try {
    tab = await deps.tabs.get(tabId);
  } catch {
    return 0;
  }
  if (!tab || tab.discarded || tab.status === "unloaded") return 0;
  let host = "";
  try {
    host = new URL(String(tab.url || "")).hostname;
  } catch {
    return 0;
  }
  const entries = await scriptEntries(deps);
  let injected = 0;
  for (const entry of entries) {
    const forSource = entry.matches.some((m) => {
      const h = matchHost(m);
      return h ? hostForSource(h, sourceId) && hostMatches(m, host) : false;
    });
    if (!forSource) continue;
    try {
      await injectInto(tabId, entry, deps);
      injected++;
    } catch {
      /* keep going — partial injection still beats none */
    }
  }
  return injected;
}

/** Does the pattern cover this tab host (path is always "/*" for us)? */
function hostMatches(pattern, host) {
  const p = matchHost(pattern);
  if (p === "*") return true;
  if (!p) return false;
  if (p === host) return true;
  if (p.startsWith("*.")) return host === p.slice(2) || host.endsWith(p.slice(1));
  return false;
}
