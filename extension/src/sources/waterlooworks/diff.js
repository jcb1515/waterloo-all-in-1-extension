// @ts-check
// WaterlooWorks application diffing (pure; no chrome APIs). Compares the
// applications seen on the previous read with the current read and produces
// merged applications plus feed updates for what changed.

import { STATUS_LABEL } from "./status.js";

/** @typedef {import("../../core/contract.js").Application} Application */
/** @typedef {import("../../core/contract.js").ApplicationStatus} ApplicationStatus */
/** @typedef {import("../../core/contract.js").Update} Update */

/**
 * @param {Application[]|undefined} prev   Applications from the last read
 * @param {Application[]} next             Applications from this read
 * @param {Date} now
 * @returns {{applications: Application[], updates: Update[]}}
 */
export function diffApplications(prev, next, now) {
  const nowIso = (now instanceof Date ? now : new Date(now)).toISOString();
  const prevList = Array.isArray(prev) ? prev : [];
  const prevById = new Map(prevList.map((app) => [app.id, app]));
  const hadPrev = prevList.length > 0;
  const seen = new Set();
  const applications = [];
  const updates = [];

  for (const app of Array.isArray(next) ? next : []) {
    if (!app || seen.has(app.id)) continue;
    seen.add(app.id);
    const before = prevById.get(app.id);
    const status = knownStatus(app.status);
    const itemIds = mergeIds(before?.itemIds, app.itemIds);

    if (before && status === "unknown" && knownStatus(before.status) !== "unknown") {
      // Fail-soft: an unreadable status must not wipe the stored one.
      applications.push({ ...app, status: before.status, history: before.history ?? [], itemIds });
      continue;
    }
    if (!before) {
      const history = status === "unknown" ? [] : [{ status, at: nowIso }];
      if (hadPrev && status !== "unknown") updates.push(makeUpdate(app, status, "new", nowIso));
      applications.push({ ...app, status, history, itemIds });
      continue;
    }
    if (status !== knownStatus(before.status)) {
      const history = [...(before.history ?? []), { status, at: nowIso }];
      updates.push(makeUpdate(app, status, "status", nowIso));
      applications.push({ ...app, status, history, itemIds });
      continue;
    }
    applications.push({ ...app, status, history: before.history ?? [], itemIds });
  }

  // WaterlooWorks lists paginate and filter: absence is not removal.
  for (const app of prevList) {
    if (!seen.has(app.id)) applications.push(app);
  }
  return { applications, updates };
}

/**
 * Ids are replay-stable (no timestamp): re-reading the same transition emits
 * the same id, and the core's mergeUpdates dedupes by it.
 * @param {Application} app
 * @param {ApplicationStatus} status
 * @param {"new"|"status"} kind
 * @param {string} nowIso
 * @returns {Update}
 */
function makeUpdate(app, status, kind, nowIso) {
  return {
    id: kind === "new" ? `${app.id}:new` : `${app.id}:${status}`,
    at: nowIso,
    source: "waterlooworks",
    kind,
    text: `${STATUS_LABEL[status]}: ${app.employer ?? ""} · ${app.jobTitle ?? ""}`,
    refId: app.id,
  };
}

/**
 * @param {unknown} status
 * @returns {ApplicationStatus}
 */
function knownStatus(status) {
  return typeof status === "string" && Object.hasOwn(STATUS_LABEL, status)
    ? /** @type {ApplicationStatus} */ (status)
    : "unknown";
}

/**
 * @param {string[]|undefined} a
 * @param {string[]|undefined} b
 * @returns {string[]}
 */
function mergeIds(a, b) {
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}
