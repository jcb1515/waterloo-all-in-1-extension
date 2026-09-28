// @ts-check
// Org colour assignment. An org (course code, team, employer) maps to one of
// the 8 --org-N palette slots by a stable string hash of its normalised code,
// so "ECE 105" is always the same colour across items, sessions and sessions.

import { normCourseCode } from "../core/contract.js";

export const ORG_COLOR_COUNT = 8;

/**
 * Stable org palette index in [0, 8). Pure: same org -> same index forever.
 * FNV-1a over normCourseCode(org), mod ORG_COLOR_COUNT.
 * @param {unknown} org
 * @returns {number}
 */
export function orgColorIndex(org) {
  const s = normCourseCode(org);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % ORG_COLOR_COUNT;
}

/**
 * Palette index for an org, honouring a user-chosen project colour: when the
 * org string is a project name (case-insensitive), that project's colour
 * wins; everything else keeps the stable hash.
 * @param {unknown} org
 * @param {any[]|null|undefined} projects
 * @returns {number}
 */
export function orgColorFor(org, projects) {
  if (org != null && org !== "" && Array.isArray(projects)) {
    const n = String(org).trim().toLowerCase();
    const p = projects.find(
      (p) => p && typeof p.name === "string" && p.name.trim().toLowerCase() === n
    );
    if (p && Number.isInteger(p.color)) return ((p.color % ORG_COLOR_COUNT) + ORG_COLOR_COUNT) % ORG_COLOR_COUNT;
  }
  return orgColorIndex(org);
}

/**
 * CSS custom-property style for an org chip/bar: {--org, --org-soft, --org-ink}.
 * @param {unknown} org
 * @param {any[]|null|undefined} [projects]  project names use their own colour
 * @returns {Record<string, string> | undefined}
 */
export function orgStyle(org, projects) {
  if (org == null || org === "") return undefined;
  const i = orgColorFor(org, projects);
  return {
    "--org": `var(--org-${i})`,
    "--org-soft": `var(--org-${i}-soft)`,
    "--org-ink": `var(--org-${i}-ink)`,
  };
}
