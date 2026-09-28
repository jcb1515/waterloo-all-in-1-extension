// @ts-check
// Every calendar.google.com selector/regex the passive reader uses, in one
// place. Field-checked against a live Week-view render (see README
// "needs tuning" for what is still a guess).

export const GCAL = {
  // Event chips carry a base64 "<eventId> <calendarId>" in data-eventid.
  chip: "[data-eventid]",
  // The open event-detail popup.
  dialog: '[role="dialog"]',
  heading: 'h1, h2, h3, [role="heading"]',
  // The rendered view code sits on a top-level element in ALL-CAPS
  // ("WEEK"); the view-switcher menuitems carry the same attr in
  // lowercase ("week") and must not be read.
  viewKey: "[data-viewkey]",
  // Visible-day column headers ("Sun27"…) of the rendered grid.
  columnHeader: '[role="columnheader"]',
  // Container marking the rendered column view (carries opaque
  // data-start/end-date-key stamps; day-cell [data-date] stamps inside it
  // belong to the visible grid, not the sidebar month picker).
  columnView: "[data-is-column-view-context]",
  // Day-cell date stamp "YYYYMMDD" — only trusted inside the column view.
  dayStamp: "[data-date]",
};

// A chip label's first comma-segment: "1pm to 1:30pm" (times h(:mm)?(am|pm)).
export const TIME_RANGE =
  /^(\d{1,2})(?::(\d{2}))?\s*([ap])m\s+to\s+(\d{1,2})(?::(\d{2}))?\s*([ap])m$/i;

export const ALLDAY_PREFIX = /^all\s*day$/i;

// The "first descendant whose text looks like the description leaf" check
// used when a chip has no aria-label: a bare time range, "All day", or a
// "September 8"-style month-date head.
export const LABEL_HINT =
  /^(?:\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?\s+to\s+|all\s*day\b|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}\b)/i;

export const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const MONTH_SRC =
  "(january|february|march|april|may|june|july|august|september|october|november|december)";

// "<Month> <D>, <YYYY> at <h>(:mm)?(am|pm)" — one leg of a datetime head.
const DT_PART = `${MONTH_SRC}\\s+(\\d{1,2})\\s*,\\s*(\\d{4})\\s+at\\s+(\\d{1,2})(?::(\\d{2}))?\\s*([ap])\\.?m\\.?`;

// "September 8, 2026 at 8am to December 23, 2026 at 11:59pm, <title>, …" —
// the long-span label head. The second leg may drop the date ("to 11pm").
export const SPAN_HEAD = new RegExp(
  `^${DT_PART}\\s+to\\s+(${DT_PART}|\\d{1,2}(?::\\d{2})?\\s*[ap]\\.?m\\.?)\\b`,
  "i",
);

// "September 27, 2026 at 12:59am, <title>, …" — a single-date head.
export const POINT_HEAD = new RegExp(`^${DT_PART}\\b`, "i");

// A "Calendar: <name>" middle segment names the calendar the chip sits on.
export const CALENDAR_SEG = /^calendar\s*:/i;

// Trailing "Month D[, – Month D2|, – D2], YYYY" at the END of a chip label,
// e.g. "September 29, 2026", "September 28 – October 2, 2026",
// "October 5 – 9, 2026".
export const DATE_TAIL = new RegExp(
  `${MONTH_SRC}\\s+(\\d{1,2})(?:\\s*[–—-]\\s*(?:${MONTH_SRC}\\s+)?(\\d{1,2}))?\\s*,\\s*(\\d{4})\\s*$`,
  "i",
);

// Column-header text "Sun27" / "Sun 27": weekday prefix + day-of-month.
export const COLUMN_HEADER_RE = /^([a-z]{3})\w*\.?\s*(\d{1,2})\b/i;

// document.title anchors: "… Week of September 27, 2026", a bare
// "September 27, 2026" (day view) or "September 2026" (month view).
export const TITLE_WEEK = /week of\s+(\w+)\s+(\d{1,2}),?\s*(\d{4})/i;
export const TITLE_DAY = /(\w+)\s+(\d{1,2}),?\s*(\d{4})/;
export const TITLE_MONTH = /(\w+)\s+(\d{4})\s*$/;

// The detail popup's when-line separates date and time with "⋅" / "·" /
// "•" — normalised away before the textdates parse.
export const DIALOG_SEP = /[⋅·•]/g;
