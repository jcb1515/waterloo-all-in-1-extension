// @ts-check
// The source adapters the scheduler drives. "outlook"/"gmail" both map to
// the email adapter.

import learn from "../sources/learn/index.js";
import outline from "../sources/outline/index.js";
import portal from "../sources/portal/index.js";
import email from "../sources/email/index.js";
import waterlooworks from "../sources/waterlooworks/index.js";
import discord from "../sources/discord/index.js";

/** @type {import("./contract.js").Adapter[]} */
export const ADAPTERS = [learn, outline, portal, email, waterlooworks, discord];

/**
 * Whether a source is wired end-to-end. "live" adapters sync now; "soon" ones
 * show as "Coming soon" in the UI until their window lands the adapter.
 * Keyed by adapter id — the email adapter serves both "outlook" and "gmail".
 */
export const SOURCE_STAGE = Object.freeze({
  learn: "live",
  outline: "live",
  portal: "soon",
  outlook: "soon",
  waterlooworks: "live",
  discord: "soon",
});

/**
 * @param {string} adapterId
 * @returns {"live"|"soon"}
 */
export function stageForAdapter(adapterId) {
  return /** @type {any} */ (SOURCE_STAGE)[adapterId] || "soon";
}

/** SourceIds that share the email adapter. */
const EMAIL_SOURCES = new Set(["outlook", "gmail"]);

/**
 * The adapter responsible for a site/source id.
 * @param {string} sourceId e.g. "portal", "gmail"
 */
export function adapterForSource(sourceId) {
  const id = EMAIL_SOURCES.has(sourceId) ? "outlook" : sourceId;
  return ADAPTERS.find((a) => a.id === id) || null;
}

/**
 * The URL regexes a site's recorder should forward as wa1:observed payloads.
 * @param {string} site SITE_BY_HOST value
 * @returns {string[]}
 */
export function observePatternsFor(site) {
  const a = adapterForSource(site);
  return (a && a.observe && Array.isArray(a.observe.urlPatterns) && a.observe.urlPatterns) || [];
}
