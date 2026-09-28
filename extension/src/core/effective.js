// @ts-check
/*
  One effective view of a merged item. effectiveItem() folds the user's
  overrides (review verdict, done flag, field edits, hidden, snooze) into the
  stored item; every consumer — agenda, calendar feed, badge, reminders,
  clashes — works on the effective item so an edit or a verdict is honoured
  everywhere. Pure: no storage, no chrome.*.
*/

/** Fields a review edit may replace on the item. opensAt is the derived
 * to-do "start showing me" date (study lead-time override). */
export const OVERRIDE_FIELDS = ["title", "type", "dueAt", "startAt", "endAt", "allDay", "opensAt"];

/**
 * Apply the user's state to a stored item. Returns a shallow copy; the
 * stored item is never mutated.
 * @param {any} item  merged canonical item
 * @param {any} us    userState[item.id] (may be undefined)
 * @param {{acceptPending?: boolean}} [opts]
 *   acceptPending treats review "pending" as accepted (the General toggle
 *   "Show items found in text without review"); dismissed still hides.
 * @returns {any} the effective item
 */
export function effectiveItem(item, us, opts = {}) {
  if (!item) return item;
  const eff = { ...item };
  if (us) {
    if (us.review === "accepted" || us.review === "dismissed") eff.review = us.review;
    if (us.done) eff.status = "done";
    if (us.hidden) eff.hidden = true;
    if (us.snoozedUntil) eff.snoozedUntil = us.snoozedUntil;
    // An explicit To-do pin travels on the effective item so the to-do rules
    // can read it without another userState lookup. Not an override field.
    if (typeof us.todo === "boolean") eff.todoPin = us.todo;
    const o = us.override;
    if (o && typeof o === "object") {
      for (const k of OVERRIDE_FIELDS) {
        if (o[k] !== undefined) eff[k] = o[k];
      }
    }
  }
  if (opts.acceptPending && eff.review === "pending") eff.review = "accepted";
  return eff;
}

/**
 * Should the effective item appear in the agenda/feed/etc? Excludes pending
 * or dismissed review, hidden, and snoozed-until-later items.
 * @param {any} eff  an item already passed through effectiveItem
 * @param {Date|number} now
 */
export function isVisible(eff, now) {
  if (!eff) return false;
  if (eff.review === "pending" || eff.review === "dismissed") return false;
  if (eff.hidden) return false;
  const t = now instanceof Date ? now.getTime() : Number(now);
  if (eff.snoozedUntil && Date.parse(eff.snoozedUntil) > t) return false;
  return true;
}

/** The item's primary timestamp: dueAt for deadlines, startAt for events. */
export function anchorOf(eff) {
  return (eff && (eff.dueAt || eff.startAt)) || null;
}
