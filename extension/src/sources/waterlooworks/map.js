// @ts-check
// Parser rows/details -> contract objects (pure; no chrome APIs).

import { itemId } from "../../core/contract.js";
import { normalizeStatus } from "./status.js";

/** @typedef {import("../../core/contract.js").Item} Item */
/** @typedef {import("../../core/contract.js").Application} Application */

const SOURCE = "waterlooworks";
const DAY_MS = 24 * 60 * 60 * 1000;

const iso = (now) => (now instanceof Date ? now : new Date(now)).toISOString();

/** Small stable hash for event ids (FNV-1a 32-bit). */
function fnv(text) {
  let hash = 0x811c9dc5;
  for (const ch of text) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const cancelled = (text) => /cancel/i.test(text || "");

/**
 * @param {any[]} rows  parseApplications rows
 * @returns {Application[]}
 */
export function toApplications(rows) {
  return (rows || [])
    .filter((row) => row && row.jobId)
    .map((row) => ({
      id: `waterlooworks:${row.jobId}`,
      employer: row.employer || "",
      jobTitle: row.jobTitle || "",
      jobId: row.jobId,
      cycle: row.term,
      status: normalizeStatus(row.appStatusText),
      history: [],
      itemIds: [],
    }));
}

/**
 * @param {any[]} rows  parseInterviews rows
 * @param {Date} now
 * @returns {Item[]}
 */
export function interviewItems(rows, now) {
  const nowIso = iso(now);
  const used = new Set();
  const items = [];
  for (const row of rows || []) {
    if (!row?.startAt || !row.jobId) continue;
    let key = `interview:${row.jobId}`;
    let id = itemId(SOURCE, key);
    if (used.has(id)) {
      // Two interviews for one job: disambiguate by date (then a counter).
      const day = String(row.startAt).slice(0, 10);
      let n = 2;
      key = `interview:${row.jobId}:${day}`;
      id = itemId(SOURCE, key);
      while (used.has(id)) {
        key = `interview:${row.jobId}:${day}-${n++}`;
        id = itemId(SOURCE, key);
      }
    }
    used.add(id);
    const details = [
      row.type && `Type: ${row.type}`,
      row.method && `Method: ${row.method}`,
      row.scheduleStatus && `Schedule status: ${row.scheduleStatus}`,
      row.confirmationStatus && `Confirmation: ${row.confirmationStatus}`,
    ]
      .filter(Boolean)
      .join("\n");
    items.push({
      id,
      source: SOURCE,
      type: "interview",
      title: row.jobTitle ? `Interview: ${row.jobTitle}` : "Interview",
      org: row.employer || undefined,
      startAt: row.startAt,
      location: row.location || row.method || undefined,
      status: cancelled(row.scheduleStatus) || cancelled(row.confirmationStatus)
        ? "cancelled"
        : "open",
      confidence: "exact",
      review: "auto",
      seenIn: [{ source: SOURCE, key, scope: "interviews", at: nowIso }],
      details: details || undefined,
      meta: {
        jobId: row.jobId,
        division: row.division,
        term: row.term,
        type: row.type,
        method: row.method,
        scheduleStatus: row.scheduleStatus,
        confirmationStatus: row.confirmationStatus,
        prep: {
          jobId: row.jobId,
          format: row.type || row.method,
          location: row.location,
          postingTitle: row.jobTitle,
        },
      },
      evidence: { method: "html" },
    });
  }
  return items;
}

/**
 * Interview detail page -> interview item (booked, same id as the list row so
 * the adapter can merge) and/or a time-slot selection deadline (not booked).
 * @param {any} detail  parseInterviewDetail result
 * @param {Date} now
 * @returns {Item[]}
 */
export function interviewDetailItems(detail, now) {
  if (!detail?.ok || !detail.jobId) return [];
  const nowIso = iso(now);
  const items = [];
  const booked = detail.booked || Boolean(detail.startAt);
  const key = `interview:${detail.jobId}`;

  if (booked) {
    const details = [
      detail.interviewer && `Interviewer: ${detail.interviewer}`,
      detail.method && `Method: ${detail.method}`,
      detail.interviewType && `Interview type: ${detail.interviewType}`,
      detail.confirmedAt && `Booking confirmed: ${detail.confirmedAt}`,
      detail.instructions &&
        `Instructions: ${
          detail.instructions.length > 800
            ? detail.instructions.slice(0, 800)
            : detail.instructions
        }`,
    ]
      .filter(Boolean)
      .join("\n");
    items.push({
      id: itemId(SOURCE, key),
      source: SOURCE,
      type: "interview",
      title: detail.jobTitle ? `Interview: ${detail.jobTitle}` : "Interview",
      org: detail.employer || undefined,
      startAt: detail.startAt,
      endAt: detail.endAt,
      location: detail.where || undefined,
      status: cancelled(detail.status) ? "cancelled" : "open",
      confidence: "exact",
      review: "auto",
      seenIn: [{ source: SOURCE, key, scope: "interviewDetail", at: nowIso }],
      details: details || undefined,
      meta: {
        jobId: detail.jobId,
        division: detail.division,
        prep: {
          jobId: detail.jobId,
          jobTitle: detail.jobTitle,
          employer: detail.employer,
          format: detail.method,
          location: detail.where,
          interviewer: detail.interviewer,
          interviewType: detail.interviewType,
          bookingPermission: detail.bookingPermission,
          confirmedAt: detail.confirmedAt,
          instructions: detail.instructions,
        },
      },
      evidence: { method: "html" },
    });
    return items;
  }

  // WW: "You must choose a timeslot at least one day before your interview,
  // or the system will automatically choose one."
  const available = (detail.slots || []).filter((slot) =>
    /^available$/i.test(slot.state || "")
  );
  const firstStart = available
    .map((slot) => slot.startAt)
    .filter(Boolean)
    .sort()[0];
  if (firstStart) {
    items.push({
      id: itemId(SOURCE, `timeslot:${detail.jobId}`),
      source: SOURCE,
      type: "deadline",
      category: "interview-timeslot",
      title: `Book interview slot: ${detail.jobTitle || detail.jobId}`,
      org: detail.employer || undefined,
      dueAt: new Date(Date.parse(firstStart) - DAY_MS).toISOString(),
      status: "open",
      confidence: "tentative",
      review: "auto",
      seenIn: [
        {
          source: SOURCE,
          key: `timeslot:${detail.jobId}`,
          scope: "interviewDetail",
          at: nowIso,
        },
      ],
      meta: {
        jobId: detail.jobId,
        availableSlots: available.length,
        rule: "24h-before-first-slot",
      },
    });
  }
  return items;
}

/**
 * @param {any[]} rows  parseEventRegistrations rows
 * @param {Date} now
 * @returns {Item[]}
 */
export function eventItems(rows, now) {
  const nowIso = iso(now);
  const items = [];
  const used = new Set();
  for (const row of rows || []) {
    if (!row?.startAt) continue;
    const key = `event:${fnv(`${row.module || ""}|${row.event || ""}|${row.startAt}`)}`;
    let id = itemId(SOURCE, key);
    let n = 2;
    while (used.has(id)) id = itemId(SOURCE, `${key}-${n++}`);
    used.add(id);
    items.push({
      id,
      source: SOURCE,
      type: "event",
      title: row.event || "Event",
      org: row.module || undefined,
      startAt: row.startAt,
      location: row.location || undefined,
      status: cancelled(row.registrationStatus) ? "cancelled" : "open",
      confidence: "exact",
      review: "auto",
      seenIn: [{ source: SOURCE, key, scope: "events", at: nowIso }],
      meta: { registrationStatus: row.registrationStatus },
    });
  }
  return items;
}

/**
 * @param {any} posting  parsePosting result
 * @param {Date} now
 * @returns {Item[]}
 */
export function postingItems(posting, now) {
  if (!posting?.ok || !posting.jobId || !posting.deadline) return [];
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  if (!(Date.parse(posting.deadline) > nowMs)) return [];
  const key = `deadline:${posting.jobId}`;
  return [
    {
      id: itemId(SOURCE, key),
      source: SOURCE,
      type: "application-deadline",
      title: `Apply: ${posting.jobTitle || posting.jobId}`,
      org: posting.employer || undefined,
      dueAt: posting.deadline,
      status: "open",
      confidence: "exact",
      review: "auto",
      seenIn: [{ source: SOURCE, key, scope: "postings", at: iso(now) }],
      meta: { jobId: posting.jobId, division: posting.division },
    },
  ];
}

/**
 * Link applications to the items their jobId produced (interviews, timeslots,
 * posting deadlines). Pure: returns new Application objects — the diffed list
 * can share objects with persisted state, which must not be mutated.
 * @param {Application[]} applications
 * @param {Item[]} items
 * @returns {Application[]}
 */
export function linkItems(applications, items) {
  return (applications || []).map((app) => {
    if (!app?.jobId) return app;
    return {
      ...app,
      itemIds: (items || [])
        .filter((item) => item?.meta?.jobId === app.jobId)
        .map((item) => item.id),
    };
  });
}

/**
 * Merge the interviews-list and interview-detail scopes by item id: detail
 * fields win for startAt/endAt/location/meta.prep, list fields otherwise.
 * Detail-only items (e.g. the timeslot deadline) are appended.
 * @param {Item[]} listItems
 * @param {Item[]} detailItems
 * @returns {Item[]}
 */
export function mergeInterviewScopes(listItems, detailItems) {
  const detailById = new Map((detailItems || []).map((item) => [item.id, item]));
  const merged = (listItems || []).map((item) => {
    const detail = detailById.get(item.id);
    if (!detail) return item;
    detailById.delete(item.id);
    const listPrep = /** @type {Record<string, unknown>} */ (item.meta?.prep ?? {});
    const detailPrep = /** @type {Record<string, unknown>} */ (detail.meta?.prep ?? {});
    return {
      ...detail,
      ...item,
      startAt: detail.startAt ?? item.startAt,
      endAt: detail.endAt ?? item.endAt,
      location: detail.location ?? item.location,
      meta: {
        ...detail.meta,
        ...item.meta,
        prep: { ...listPrep, ...detailPrep },
      },
      seenIn: dedupeSeenIn(item.seenIn, detail.seenIn),
    };
  });
  return [...merged, ...detailById.values()];
}

function dedupeSeenIn(...lists) {
  const seen = new Set();
  const out = [];
  for (const entry of lists.flat().filter(Boolean)) {
    const key = `${entry.source}:${entry.scope || ""}:${entry.key}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out.length ? out : undefined;
}
