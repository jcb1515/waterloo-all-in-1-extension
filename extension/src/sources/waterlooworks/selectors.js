// @ts-check
// Every WaterlooWorks-specific string lives here so a layout change means
// editing one file. Header matching is case-insensitive on the cleaned label
// (Material icon ligature text removed, trailing "(1)" sort index stripped).

/** Material icon ligature elements — their text must be stripped everywhere. */
export const ICON_SELECTOR = ".material-icons";

/**
 * Cleaned header label -> row field key, per table kind.
 * Column order is user-configurable: ALWAYS map by label, never position.
 */
export const HEADER_KEYS = Object.freeze({
  applications: Object.freeze({
    "job title": "jobTitle",
    "job id": "jobId",
    "term": "term",
    "organization": "employer",
    "app status": "appStatusText",
    "job status": "jobStatusText",
    "division": "division",
    "location": "location",
    "city": "city",
    "openings": "openings",
    "app deadline": "appDeadline",
    "app submitted on": "submittedOn",
    "app submitted by": "submittedBy",
  }),
  interviews: Object.freeze({
    "term": "term",
    "schedule status": "scheduleStatus",
    "confirmation status": "confirmationStatus",
    "interview date / time": "startAtText",
    "type": "type",
    "location": "location",
    "method": "method",
    "job id": "jobId",
    "job title": "jobTitle",
    "organization": "employer",
    "division": "division",
  }),
  events: Object.freeze({
    "module": "module",
    "event": "event",
    "event date": "startAtText",
    "location": "location",
    "date registered": "registeredAtText",
    "registration status": "registrationStatus",
    "advanced event": "advancedEvent",
    "paid event": "paidEvent",
    "payment status": "paymentStatus",
  }),
  messages: Object.freeze({
    "priority": "priority",
    "date received": "receivedAtText",
    "date responded": "respondedAtText",
    "from": "from",
    "to": "to",
    "subject": "subject",
  }),
});

/** A table is of a kind when its cleaned headers include ALL of these labels. */
export const TABLE_RULES = Object.freeze({
  applications: Object.freeze(["job id", "app status"]),
  interviews: Object.freeze(["interview date / time", "job id"]),
  events: Object.freeze(["event date", "registration status"]),
  messages: Object.freeze(["date received", "subject"]),
});

/** Posting h1: "488135 - Analog/Mixed-Signal Engineering Co-op". */
export const POSTING_H1_RE = /^(\d{4,})\s*-\s*(.+)$/;

/** Posting field label that carries the application deadline. */
export const POSTING_DEADLINE_RE = /application deadline|deadline/i;

/** Label/value pairs also appear as dt/dd or sibling divs, not just table rows. */
export const LABEL_SELECTOR = ".label, .control-label, .field-label, dt";
export const VALUE_SELECTOR = ".value, .field-value, dd";

/** Long-text posting fields excluded from `fields` to keep state small. */
export const POSTING_SKIP_LABELS = new Set([
  "job summary",
  "job responsibilities",
  "required skills",
  "compensation and benefits",
]);

/** Interview detail detection: this label or the "INTERVIEW DETAILS" heading. */
export const INTERVIEW_DETAIL_LABEL = "interviewing for job";
export const INTERVIEW_DETAIL_HEADING_RE = /^interview details$/i;

/** Message detail detection: "ADMINISTRATION INFORMATION" heading/label. */
export const MESSAGE_DETAIL_HEADING_RE = /administration information/i;

/** Rankings detection: "Ranking in 2027 - Winter" heading. */
export const RANKINGS_HEADING_RE = /^ranking in\s+(.+)$/i;
export const RANKINGS_CLOSED_RE = /rankings are not open at this time/i;

/** Logged-out: URL path or "Not Logged In" title/h1. */
export const LOGGED_OUT_PATH_RE = /\/notLoggedIn\.htm/i;
export const LOGGED_OUT_TEXT_RE = /not logged in/i;

/**
 * observe.urlPatterns (regex source strings). WW data loads are POSTs with
 * per-session encrypted action tokens, so every interesting response goes
 * through the recorder (T3) — T1/T2 cannot replay them.
 */
export const OBSERVE_PATTERNS = Object.freeze([
  "^https://waterlooworks\\.uwaterloo\\.ca/myAccount/co-op/full/(applications|interviews|jobs)\\.htm",
  "^https://waterlooworks\\.uwaterloo\\.ca/myAccount/dashboard\\.htm",
  // rankings tab, messages inbox/detail and other co-op sub-pages
  "^https://waterlooworks\\.uwaterloo\\.ca/myAccount/co-op/",
  "^https://waterlooworks\\.uwaterloo\\.ca/notLoggedIn\\.htm",
]);

/**
 * URL path -> scopes that page is expected to produce. Used only for
 * needsUpdate flags: a POST to interviews.htm that yields neither the list
 * table nor a detail view means the layout changed or the page wasn't loaded.
 * dashboard.htm is multi-module so it expects nothing in particular.
 */
export const EXPECTED_SCOPES = Object.freeze({
  "applications.htm": Object.freeze(["applications"]),
  "interviews.htm": Object.freeze(["interviews", "interviewDetail"]),
  "jobs.htm": Object.freeze(["posting"]),
});
