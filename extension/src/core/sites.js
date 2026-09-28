// @ts-check
/*
  The canonical site URL per SourceId, shared by the panel's Open buttons,
  the check-now tab picker and the live tool. siteUrlFor prefers the first
  https `url` on the source's checklist rows (Gmail lands on the inbox, not
  the bare origin; Outlook on /mail/inbox), then the adapter's first origin.
*/

import { SITE_BY_HOST } from "./contract.js";
import { adapterForSource } from "./registry.js";
import { CHECK_SOURCES } from "../sources/probes.js";

/**
 * The page to open when a source needs a visit: first https checklist-row
 * url, else `${adapter.origins[0]}/`, else null.
 * @param {string} sourceId SourceId, e.g. "gmail" (not the shared adapter id)
 * @returns {string | null}
 */
export function siteUrlFor(sourceId) {
  try {
    const entry = CHECK_SOURCES[sourceId];
    const hit = ((entry && entry.checklist) || []).find(
      (r) => r && typeof r.url === "string" && r.url.startsWith("https://"),
    );
    if (hit && hit.url) return hit.url;
  } catch {
    /* fall through to origins */
  }
  const adapter = adapterForSource(sourceId);
  const origin = adapter && adapter.origins && adapter.origins[0];
  return origin ? `${String(origin).replace(/\/+$/, "")}/` : null;
}

/**
 * The SourceId a tab URL belongs to, via SITE_BY_HOST — null for anything
 * else. Hostname only; a gmail tab never reads as "outlook".
 * @param {string} url
 * @returns {string | null}
 */
export function sourceForTabUrl(url) {
  try {
    return /** @type {Record<string, string>} */ (SITE_BY_HOST)[new URL(url).hostname] || null;
  } catch {
    return null;
  }
}
