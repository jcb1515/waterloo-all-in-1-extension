// @ts-check
/*
  Pure review-queue model: which items are still pending a verdict, sorted by
  anchor and split into upcoming vs. the collapsed "Past" group.
*/

/** The item's proposed date: dueAt for deadlines, startAt for timed events. */
const anchor = (/** @type {any} */ it) => {
  const a = it && (it.dueAt || it.startAt);
  return a ? Date.parse(a) : Infinity;
};

/**
 * Pending-review items, sorted by anchor; past-dated ones go last.
 * @param {Record<string, any>} items
 * @param {Record<string, any>} userState
 * @param {Date} now
 * @returns {{upcoming: any[], past: any[]}}
 */
export function pendingReviewItems(items, userState, now) {
  const nowMs = now.getTime();
  const list = Object.values(items || {}).filter((it) => {
    if (!it || it.review !== "pending") return false;
    const v = ((userState || {})[it.id] || {}).review;
    return v !== "accepted" && v !== "dismissed";
  });
  list.sort((a, b) => anchor(a) - anchor(b));
  return {
    upcoming: list.filter((it) => anchor(it) >= nowMs),
    past: list.filter((it) => anchor(it) < nowMs),
  };
}
