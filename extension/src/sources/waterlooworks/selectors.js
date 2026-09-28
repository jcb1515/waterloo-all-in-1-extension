// @ts-check
// Every WaterlooWorks-specific string lives here so a layout change means
// editing one file. Header matching is case-insensitive on the cleaned label
// (Material icon ligature text removed, trailing "(1)" sort index stripped).

/**
 * The single scope every WaterlooWorks item reports (`seenIn[].scope` and
 * `observe.parse`'s result scope). W1's scope-mode fold drops stored items
 * whose seenIn scope equals the result scope, so one unified scope makes the
 * adapter's lastGood union authoritative — partial section reads can't leave
 * stale items behind.
 */
export const SCOPE = "waterlooworks";

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
  // Dashboard "Your Upcoming Schedule" module: day-grouped rows where the
  // day lives in a <strong> above each table.
  schedule: Object.freeze({
    "time": "timeText",
    "type": "entryType",
    "name": "nameText",
    "status": "statusText",
    "conflicts": "conflictsText",
  }),
});

/** A table is of a kind when its cleaned headers include ALL of these labels. */
export const TABLE_RULES = Object.freeze({
  applications: Object.freeze(["job id", "app status"]),
  interviews: Object.freeze(["interview date / time", "job id"]),
  events: Object.freeze(["event date", "registration status"]),
  messages: Object.freeze(["date received", "subject"]),
  schedule: Object.freeze(["time", "type", "name", "status"]),
});

/** Dashboard URL: /myAccount root and dashboard.htm are the same page. */
export const DASHBOARD_PATH_RE = /^\/myAccount\/?$|^\/myAccount\/dashboard(?:\.htm)?\/?$/i;

/** Informational wrapper present only on the dashboard (full DOM, not snapshots). */
export const DASHBOARD_CONTAINER_SELECTOR = ".user-dashboard";

/** "Rank and Match" module on the dashboard (holds the rankings notice). */
export const DASH_ACTIONS_SELECTOR = ".orbis-posting-actions";
/** Its heading: "RANKING (2027 - Winter)" -> term "2027 - Winter". */
export const DASH_RANKINGS_HEADING_RE = /^rankings?\s*\(([^)]+)\)/i;

/** Schedule name cell: "Interview for Hardware Co-op (400001)". */
export const SCHEDULE_INTERVIEW_RE = /^interview\s+for\s+(.+?)\s*\((\d{4,})\)\s*$/i;

/** Count-table row labels on the dashboard (value lives in a .value cell). */
export const NEW_MESSAGES_LABEL_RE = /^new messages$/i;
export const WEBCAM_LABEL_RE = /webcam appointments/i;

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
  // The dashboard (its URL may or may not carry the .htm suffix) and the
  // /myAccount root, which renders the same page.
  "^https://waterlooworks\\.uwaterloo\\.ca/myAccount/dashboard(\\.htm)?(\\?|#|/|$)",
  "^https://waterlooworks\\.uwaterloo\\.ca/myAccount/?(\\?|#|$)",
  // rankings tab, messages inbox/detail and other co-op sub-pages
  "^https://waterlooworks\\.uwaterloo\\.ca/myAccount/co-op/",
  "^https://waterlooworks\\.uwaterloo\\.ca/notLoggedIn\\.htm",
]);

/* --- Public co-op important-dates page (uwaterloo.ca) --------------------- */

/** Default URL for the daily co-op cycle-dates fetch (public page). */
export const COOP_DATES_URL =
  "https://uwaterloo.ca/co-operative-education/important-dates";

/** Month-calendar blocks: <details><summary><h2>September 2026 calendar of dates</h2>. */
export const COOP_DETAILS_SELECTOR = "details";
export const COOP_SUMMARY_SELECTOR = "summary";
export const COOP_MONTH_HEADING_RE = /^([a-z]+)\s+(\d{4})\s+calendar of dates/i;
export const COOP_MONTHS = Object.freeze({
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
});

/** "Application limit: 50 apps" lines inside event paragraphs are skipped. */
export const COOP_APP_LIMIT_RE = /application\s+limit/i;
/** "Match results available by end of day" -> 23:59 Toronto. */
export const COOP_END_OF_DAY_RE = /\bby end of day\b/i;

/**
 * Lines naming their work term, e.g. "Fall 2026 co-op work term starts".
 * These override the recruiting-month -> work-term mapping.
 */
export const COOP_WORK_TERM_LINE_RE =
  /\b(fall|winter|spring)\s+(\d{4})\b[^]*?\bwork\s+term\b/i;
/** First time phrase: "9 a.m." | "2:30 p.m." | "12 p.m." | "noon" | "midnight". */
export const COOP_TIME_RE =
  /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?|\bnoon\b|\bmidnight\b/i;
/** Trailing zone noise "(ET)" / "ET" stripped when building titles.
 * Word boundaries matter: without them "requEST" loses its "est". */
export const COOP_ZONE_RE = /\s*\(?(?:\b(?:ET|EST|EDT)\b)\)?\s*/gi;

/** A calendar line is co-op content when its text or cycle label matches. */
export const COOP_KEEP_RE =
  /cycle|co-op work term|work term|direct offers|ranking|match/i;

/** First match wins: event text -> cycle-date category. */
export const COOP_CATEGORIES = Object.freeze([
  Object.freeze([/job\s+postings?\s+open|jobs posted/i, "postings-open"]),
  Object.freeze([/job\s+postings?\s+close|postings close/i, "postings-close"]),
  Object.freeze([/interviews?/i, "interviews"]),
  Object.freeze([/employer rankings?/i, "rankings-open"]),
  // "Student ranking consults" are advising sessions, not deadlines —
  // only rankings + due/close/deadline wording is a deadline.
  Object.freeze([/rankings?\s+(?:due|deadline|close[sd]?)\b/i, "rankings-due"]),
  Object.freeze([/match results/i, "match-results"]),
  Object.freeze([/direct offers/i, "direct-offers"]),
  Object.freeze([/work term/i, "work-term"]),
]);

/**
 * URL path -> scopes that page is expected to produce. Used only for
 * needsUpdate flags: a POST to interviews.htm that yields neither the list
 * table nor a detail view means the layout changed or the page wasn't loaded.
 * dashboard.htm is multi-module so it expects nothing in particular.
 */
export const EXPECTED_SCOPES = Object.freeze({
  "applications.htm": Object.freeze(["applications"]),
  "interviews.htm": Object.freeze(["interviews", "interview-detail"]),
});
