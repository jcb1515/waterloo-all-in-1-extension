// @ts-check
// The source adapters the scheduler drives. "learn" is the legacy WATnow
// bridge until Window 2's adapter lands; the rest are stubs the other
// windows fill in. "outlook"/"gmail" both map to the email adapter.

import learn from "./legacy-learn.js";
import outline from "../sources/outline/index.js";
import portal from "../sources/portal/index.js";
import email from "../sources/email/index.js";
import waterlooworks from "../sources/waterlooworks/index.js";
import discord from "../sources/discord/index.js";

/** @type {import("./contract.js").Adapter[]} */
export const ADAPTERS = [learn, outline, portal, email, waterlooworks, discord];

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
