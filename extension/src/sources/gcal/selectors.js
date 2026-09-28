// @ts-check
// Every calendar.google.com selector/regex the passive reader uses, in one
// place. All best guesses from structural knowledge of the rendered DOM —
// see README "needs tuning".

export const GCAL = {
  // Event chips carry a base64 "<eventId> <calendarId>" in data-eventid.
  chip: "[data-eventid]",
  // The open event-detail popup.
  dialog: '[role="dialog"]',
  heading: 'h1, h2, h3, [role="heading"]',
};

// A chip label's first comma-segment: "1pm to 1:30pm" (times h(:mm)?(am|pm)).
export const TIME_RANGE =
  /^(\d{1,2})(?::(\d{2}))?\s*([ap])m\s+to\s+(\d{1,2})(?::(\d{2}))?\s*([ap])m$/i;

export const ALLDAY_PREFIX = /^all\s*day$/i;

// The "first descendant whose text starts with a time range or All day"
// check used when a chip has no aria-label.
export const LABEL_HINT = /^(?:\d{1,2}(?::\d{2})?\s*[ap]m\s+to\s+|all\s*day\b)/i;

export const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const MONTH_SRC =
  "(january|february|march|april|may|june|july|august|september|october|november|december)";

// Trailing "Month D[, – Month D2|, – D2], YYYY" at the END of a chip label,
// e.g. "September 29, 2026", "September 28 – October 2, 2026",
// "October 5 – 9, 2026".
export const DATE_TAIL = new RegExp(
  `${MONTH_SRC}\\s+(\\d{1,2})(?:\\s*[–—-]\\s*(?:${MONTH_SRC}\\s+)?(\\d{1,2}))?\\s*,\\s*(\\d{4})\\s*$`,
  "i",
);

// The detail popup's when-line separates date and time with "⋅" / "·" /
// "•" — normalised away before the textdates parse.
export const DIALOG_SEP = /[⋅·•]/g;
