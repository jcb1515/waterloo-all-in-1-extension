// @ts-check
// Grouping for the Sources > Picked up segment: every item a source
// contributed — its `source`, or any `seenIn[].source` — grouped by type
// and split into upcoming vs earlier by the row's anchor (dueAt || startAt,
// same as the agenda's countdown anchor).

/**
 * Group order. `types` match the item's `type` — deadline-like covers the
 * contract's deadline family (application/offer deadlines included), the
 * class group the scheduled teaching slots, term the term/cycle dates;
 * everything else lands in "other".
 */
const GROUPS = [
  { key: "exam", label: "Exams", types: ["exam"] },
  { key: "interview", label: "Interviews", types: ["interview"] },
  {
    key: "deadline",
    label: "Deadlines",
    types: [
      "deadline",
      "assignment",
      "quiz",
      "task",
      "application-deadline",
      "offer-deadline",
    ],
  },
  { key: "event", label: "Events", types: ["event", "meeting"] },
  { key: "class", label: "Classes", types: ["class", "tutorial", "lab"], collapsed: true },
  { key: "term", label: "Term dates", types: ["term-date", "cycle-date"] },
  { key: "other", label: "Other", types: [] },
];

/** @type {Map<string, string>} item type -> group key */
const TYPE_GROUP = new Map();
for (const g of GROUPS) for (const t of g.types) TYPE_GROUP.set(t, g.key);

/**
 * Source ids the segment counts as its own. `outlook` covers both
 * mailboxes — items carry the concrete source ("gmail"/"outlook").
 * @param {string} sourceId
 */
const sourceIdsFor = (sourceId) =>
  sourceId === "outlook" ? ["outlook", "gmail", "email"] : [sourceId];

/**
 * @param {any} item @param {string[]} ids
 */
const matches = (item, ids) => {
  if (!item || !ids.includes) return false;
  if (ids.includes(item.source)) return true;
  const seen = Array.isArray(item.seenIn) ? item.seenIn : [];
  return seen.some((s) => s && ids.includes(s.source || s));
};

/** @param {any} item */
const anchor = (item) => (item && (item.dueAt || item.startAt)) || null;

/** @param {any} item @returns {number|null} */
const anchorMs = (item) => {
  const ms = Date.parse(anchor(item) || "");
  return Number.isNaN(ms) ? null : ms;
};

/**
 * The source's picked-up items grouped for display. Upcoming = anchor at or
 * after local start-of-day, ascending; earlier (and anchorless) items
 * descending. Empty groups are dropped.
 * @param {Record<string, any>} items  state.items
 * @param {string} sourceId
 * @param {Date|number} now
 * @returns {{key: string, label: string, collapsed: boolean, count: number,
 *   upcoming: any[], earlier: any[]}[]}
 */
export function pickedUpGroups(items, sourceId, now) {
  const ids = sourceIdsFor(sourceId);
  const nowDate = now instanceof Date ? now : new Date(now);
  const todayMs = new Date(
    nowDate.getFullYear(),
    nowDate.getMonth(),
    nowDate.getDate()
  ).getTime();

  const buckets = GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    collapsed: !!g.collapsed,
    count: 0,
    upcoming: /** @type {any[]} */ ([]),
    earlier: /** @type {any[]} */ ([]),
  }));
  const byKey = new Map(buckets.map((b) => [b.key, b]));

  for (const it of Object.values(items || {})) {
    if (!matches(it, ids)) continue;
    const g = byKey.get(TYPE_GROUP.get(it.type) || "other");
    if (!g) continue;
    const ms = anchorMs(it);
    (ms != null && ms >= todayMs ? g.upcoming : g.earlier).push(it);
  }

  const out = [];
  for (const g of buckets) {
    g.count = g.upcoming.length + g.earlier.length;
    if (!g.count) continue;
    g.upcoming.sort(
      (a, b) => (anchorMs(a) ?? Number.POSITIVE_INFINITY) - (anchorMs(b) ?? Number.POSITIVE_INFINITY)
    );
    g.earlier.sort(
      (a, b) => (anchorMs(b) ?? Number.NEGATIVE_INFINITY) - (anchorMs(a) ?? Number.NEGATIVE_INFINITY)
    );
    out.push(g);
  }
  return out;
}
