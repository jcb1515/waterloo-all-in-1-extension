// @ts-check
// WaterlooWorks application status normalization (pure; no chrome APIs).

/** @typedef {import("../../core/contract.js").ApplicationStatus} ApplicationStatus */

/** Short English label per ApplicationStatus, used in update text and the UI. */
export const STATUS_LABEL = /** @type {Record<ApplicationStatus, string>} */ (Object.freeze({
  applied: "Applied",
  "not-selected": "Not selected",
  "selected-for-interview": "Interview invite",
  "interview-scheduled": "Interview booked",
  alternate: "Alternate",
  offer: "Offer",
  ranked: "Ranked",
  matched: "Matched",
  declined: "Declined",
  withdrawn: "Withdrawn",
  unknown: "Unknown",
}));

/**
 * Ordered substring rules; first match wins. Order matters: "Not Selected for
 * Interview" must land on not-selected before "selected for interview" does.
 * @type {[string[], ApplicationStatus][]}
 */
const STATUS_RULES = [
  [["not selected", "unsuccessful", "rejected", "not offered", "no longer under consideration"], "not-selected"],
  [["withdrawn", "withdrew", "cancelled by student"], "withdrawn"],
  [["declined"], "declined"],
  [["interview scheduled", "interview booked", "interview confirmed"], "interview-scheduled"],
  [["selected for interview", "interview selected", "granted interview", "selected to interview"], "selected-for-interview"],
  [["alternate"], "alternate"],
  [["matched", "employed", "hired"], "matched"],
  [["ranked"], "ranked"],
  [["offer"], "offer"],
  [["applied", "submitted", "application submitted", "under review", "in progress"], "applied"],
];

const EDGE_PUNCTUATION = /^[\s.,;:!?'"()[\]*_~\-–—]+|[\s.,;:!?'"()[\]*_~\-–—]+$/g;

/**
 * Map a WaterlooWorks status cell's text to a contract ApplicationStatus.
 * Unknown or unreadable values return "unknown" — callers treat that as
 * "don't touch the stored status", not as a real status.
 * @param {unknown} raw
 * @returns {ApplicationStatus}
 */
export function normalizeStatus(raw) {
  const text = String(raw ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(EDGE_PUNCTUATION, "")
    .trim();
  if (!text) return "unknown";
  for (const [needles, status] of STATUS_RULES) {
    if (needles.some((needle) => text.includes(needle))) return status;
  }
  return "unknown";
}
