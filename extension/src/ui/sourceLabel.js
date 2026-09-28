// @ts-check
// Source identity for item badges — which source an item came from and how to
// label it ("Portal", "Discord · WATonomous", "Google Calendar", "Mine").
// Pure: no DOM, no chrome APIs; safe to test in Node.

const SOURCE_LABELS = /** @type {Record<string, string>} */ ({
  learn: "Learn",
  portal: "Portal",
  outline: "Outline",
  waterlooworks: "WaterlooWorks",
  discord: "Discord",
  gmail: "Gmail",
  outlook: "Outlook",
  gcal: "Google Calendar",
  manual: "Mine",
});

// When an item was seen in several sources, the badge shows one primary name.
// Order = which system is most authoritative for the merged item.
const PRIMARY_ORDER = /** @type {string[]} */ ([
  "waterlooworks",
  "portal",
  "learn",
  "outline",
  "discord",
  "gmail",
  "outlook",
  "gcal",
  "manual",
]);

const SOURCE_VARS = /** @type {Record<string, string>} */ ({
  learn: "var(--src-learn)",
  portal: "var(--src-portal)",
  outline: "var(--src-outline)",
  waterlooworks: "var(--src-ww)",
  discord: "var(--src-discord)",
  gmail: "var(--src-email)",
  outlook: "var(--src-email)",
  gcal: "var(--src-gcal)",
  manual: "var(--src-mine)",
});

const EMAIL_PROVIDERS = new Set(["gmail", "outlook"]);

// Monogram for the source icon tile (Sources view). "@" = the shared
// email adapter (Outlook + Gmail).
const SOURCE_GLYPHS = /** @type {Record<string, string>} */ ({
  learn: "L",
  portal: "P",
  outline: "O",
  waterlooworks: "W",
  discord: "D",
  gmail: "@",
  outlook: "@",
  gcal: "G",
  manual: "M",
});

/** The source colour as a CSS var reference ("var(--src-learn)"). @param {string} id */
export function sourceColorVar(id) {
  return SOURCE_VARS[id] || "var(--text-3)";
}

/** The monogram letter for a source icon tile. @param {string} id */
export function sourceGlyph(id) {
  return SOURCE_GLYPHS[id] || (SOURCE_LABELS[id] || id || "?").slice(0, 1).toUpperCase();
}

/**
 * All source ids for an item, deduped and sorted by primary-source precedence.
 * Reads seenIn[{source, scope}] first, then item.source, then meta.provider.
 * @param {any} item
 * @returns {string[]}
 */
export function itemSourceIds(item) {
  if (!item) return [];
  /** @type {string[]} */
  const seen = [];
  if (Array.isArray(item.seenIn)) {
    for (const e of item.seenIn) {
      const s = e && typeof e === "object" ? e.source : e;
      if (typeof s === "string") seen.push(s);
    }
  }
  if (item.source) seen.push(item.source);
  // An email item whose raw came from a provider we haven't already counted.
  const provider = item.meta && typeof item.meta.provider === "string" ? item.meta.provider : null;
  if (provider && EMAIL_PROVIDERS.has(provider)) seen.push(provider);
  if (item.meta && item.meta.projectId) seen.push("manual");
  const uniq = [...new Set(seen)];
  uniq.sort((a, b) => rank(a) - rank(b));
  return uniq;
}

/** @param {string} id */
function rank(id) {
  const i = PRIMARY_ORDER.indexOf(id);
  return i === -1 ? PRIMARY_ORDER.length : i;
}

/**
 * Display label for one source id. Discord shows the team/server (item.org);
 * email shows the provider; manual/project items read "Mine".
 * @param {string} id
 * @param {any} item
 * @returns {string}
 */
export function sourceLabel(id, item) {
  if (id === "manual" || id === "project") return "Mine";
  if (id === "discord") return item && item.org ? `Discord · ${item.org}` : "Discord";
  if (id === "email") {
    const p = item && item.meta && item.meta.provider;
    return p === "outlook" ? "Outlook" : "Gmail";
  }
  return SOURCE_LABELS[id] || id;
}

/**
 * Badge model for SourceBadge: the primary label, how many additional sources
 * were folded into "+N", a tooltip listing every source, and the colour var.
 * @param {any} item
 * @returns {{id: string, label: string, extra: number, title: string, color: string} | null}
 */
export function sourceBadge(item) {
  const ids = itemSourceIds(item);
  if (!ids.length) return null;
  const labels = ids.map((id) => sourceLabel(id, item));
  const uniqLabels = [...new Set(labels)];
  const primary = ids[0];
  return {
    id: primary,
    label: labels[0],
    extra: uniqLabels.length - 1,
    title: uniqLabels.join(" · "),
    color: sourceColorVar(primary),
  };
}
