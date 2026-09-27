// @ts-check
/*
  Optional host permissions and their dynamic content-script registrations.

  Discord and the email hosts live under `optional_host_permissions` so a
  fresh install only asks for Waterloo sites. When a user enables Discord or
  Email, the UI requests that group's origins; the background then registers
  the observer + recorder + source content scripts via chrome.scripting so
  the captures mirror today's static entries exactly.

  `scriptsForGrants` is pure and unit-tested; the chrome.* helpers below it
  are thin wrappers used by the panel, options page and service worker.
*/

const OBSERVER = "src/capture/observer.main.js";
const RECORDER = "src/capture/recorder.content.js";

/**
 * Optional host groups, keyed by grant — granting Outlook and Gmail are
 * separate browser prompts; both feed the email adapter (id "outlook").
 */
export const OPTIONAL_PERMISSION_GROUPS = Object.freeze({
  discord: ["https://discord.com/*"],
  outlook: [
    "https://outlook.office.com/*",
    "https://outlook.cloud.microsoft/*",
    "https://outlook.live.com/*",
  ],
  gmail: ["https://mail.google.com/*"],
});

/** Button label per group. */
export const GROUP_LABELS = Object.freeze({
  discord: "Discord",
  outlook: "Outlook",
  gmail: "Gmail",
});

/** The source content script bundled with the recorder per group. */
const GROUP_SOURCE_SCRIPT = {
  discord: "src/sources/discord/content.js",
  outlook: "src/sources/email/content.js",
  gmail: "src/sources/email/content.js",
};

/** Script ids we manage; anything else registered is left alone. */
const ID_PREFIX = "wa1:";

/**
 * chrome.scripting.registerContentScripts descriptors for the granted
 * origins — one MAIN-world observer + one ISOLATED recorder/source entry
 * per group, matching the old static content_scripts entries. A group is
 * included for whatever subset of its origins is actually granted.
 * @param {Iterable<string>} grantedOrigins
 */
export function scriptsForGrants(grantedOrigins) {
  const granted = new Set(grantedOrigins || []);
  /** @type {any[]} */
  const out = [];
  for (const [group, origins] of Object.entries(OPTIONAL_PERMISSION_GROUPS)) {
    const matches = origins.filter((o) => granted.has(o));
    if (!matches.length) continue;
    out.push(
      {
        id: `${ID_PREFIX}obs:${group}`,
        js: [OBSERVER],
        matches,
        runAt: "document_start",
        world: "MAIN",
        persistAcrossSessions: true,
      },
      {
        id: `${ID_PREFIX}rec:${group}`,
        js: [RECORDER, GROUP_SOURCE_SCRIPT[group]],
        matches,
        runAt: "document_start",
        persistAcrossSessions: true,
      },
    );
  }
  return out;
}

/** The group keys whose sources sit behind optional permissions. */
export function optionalSourceIds() {
  return Object.keys(OPTIONAL_PERMISSION_GROUPS);
}

/**
 * Every permission group an adapter may need, regardless of settings.
 * @param {string} adapterId
 * @returns {string[]}
 */
export function adapterGroups(adapterId) {
  if (adapterId === "discord") return ["discord"];
  if (adapterId === "outlook") return ["outlook", "gmail"];
  return [];
}

/**
 * The permission groups an adapter needs given its settings slice: the
 * master `enabled` flag gates everything, then each group is gated by the
 * same-named flag in the source's settings (`sources.outlook.gmail` turns
 * off just Gmail). Unset flags count as on.
 * @param {string} adapterId
 * @param {any} sourceSettings `settings.sources[adapterId]`
 * @returns {string[]} group keys, e.g. ["outlook", "gmail"]
 */
export function neededGroups(adapterId, sourceSettings) {
  const s = sourceSettings || {};
  if (s.enabled === false) return [];
  return adapterGroups(adapterId).filter((g) => s[g] !== false);
}

/**
 * Does the extension hold every origin this source needs? True for sources
 * without an optional group.
 * @param {string} sourceId adapter id, e.g. "discord"
 */
export async function hasSourceAccess(sourceId) {
  const origins = /** @type {Record<string, string[]>} */ (OPTIONAL_PERMISSION_GROUPS)[sourceId];
  if (!origins) return true;
  try {
    return await chrome.permissions.contains({ origins });
  } catch {
    return true; // no permissions API (previews) — don't block the UI
  }
}

/**
 * chrome.permissions.request for a source's origins — must be called from a
 * user gesture. Resolves true when granted.
 * @param {string} sourceId
 */
export async function requestSourceAccess(sourceId) {
  const origins = /** @type {Record<string, string[]>} */ (OPTIONAL_PERMISSION_GROUPS)[sourceId];
  if (!origins) return true;
  try {
    return await chrome.permissions.request({ origins });
  } catch {
    return false;
  }
}

/**
 * Reconcile dynamic content scripts with the granted origins: unregister
 * any stale `wa1:*` ids, register whatever is currently granted. Called on
 * install, browser startup and permission changes.
 */
export async function syncOptionalContentScripts() {
  try {
    const all = await chrome.permissions.getAll();
    const wanted = scriptsForGrants((all && all.origins) || []);
    const have = await chrome.scripting.getRegisteredContentScripts();
    const stale = (have || [])
      .map((s) => s && s.id)
      .filter((id) => typeof id === "string" && id.startsWith(ID_PREFIX));
    if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
    if (wanted.length) await chrome.scripting.registerContentScripts(wanted);
  } catch (e) {
    console.warn("[wa1] optional content scripts", e && /** @type {any} */ (e).message);
  }
}
