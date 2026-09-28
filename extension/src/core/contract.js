// @ts-check
/*
  Waterloo All-in-1: shared contract. FROZEN after Phase 0.
  Only Window 1 (lead) edits this file. Other windows request changes in
  <root>/coordination/w2.md or w3.md under "Requests to W1".

  Every source adapter returns data in these shapes. The core merges items
  across sources, assigns permanent calendar uids, detects changes and
  publishes the feed. Adapters never write chrome.storage themselves.
*/

/** @typedef {"learn"|"outline"|"portal"|"waterlooworks"|"discord"|"outlook"|"gmail"|"gcal"|"manual"} SourceId */

/**
 * @typedef {"deadline"|"quiz"|"exam"|"presentation"|"class"|"tutorial"|"lab"|"meeting"|"interview"
 *   |"application-deadline"|"offer-deadline"|"cycle-date"|"task"|"event"|"term-date"} ItemType
 */

/** @typedef {"open"|"submitted"|"done"|"cancelled"} ItemStatus */
/** @typedef {"exact"|"tentative"} Confidence */
/** @typedef {"auto"|"pending"|"accepted"|"dismissed"} ReviewState */

/**
 * Where an item was seen. One entry per source that reported it.
 * @typedef {Object} SeenIn
 * @property {SourceId} source
 * @property {string} key          The source's own stable key for this item
 * @property {string} [scope]      Sub-source, e.g. "dropbox", "quizzes", "interviews", "channel:<id>"
 * @property {string} at           ISO time the source last reported it
 */

/**
 * @typedef {Object} Evidence
 * @property {string} [snippet]    Matched text only (never whole message bodies), max 300 chars
 * @property {string} [url]        Link back to where it was found (Learn page, Discord message, email)
 * @property {"api"|"html"|"text"|"invite"|"manual"} method
 */

/**
 * Anything with a date. Every item has dueAt or startAt (or both).
 * @typedef {Object} Item
 * @property {string} id           `${source}:${stableKey}`; stable across reads of the same source
 * @property {SourceId} source     The adapter that produced this item
 * @property {ItemType} type
 * @property {string} [category]   Free sub-type: "assignment", "lab", "midterm", "final", "make-up", "standup"...
 * @property {string} title
 * @property {string} [org]        Course code "ECE 105", employer, or team "WATonomous"
 * @property {string} [dueAt]      ISO; deadlines
 * @property {string} [startAt]    ISO; timed events (class, exam, meeting, interview)
 * @property {string} [endAt]      ISO
 * @property {boolean} [allDay]
 * @property {string} [opensAt]    ISO; when the work unlocks
 * @property {string} [location]   Room, address, or meeting link
 * @property {string} [url]        The item's own page
 * @property {ItemStatus} status
 * @property {Confidence} confidence
 * @property {number} [weight]     Percent of final grade
 * @property {string} [section]    "LEC 002", "TUT 104"
 * @property {string} [group]      "1-20" (the group range this item applies to)
 * @property {SeenIn[]} [seenIn]   Filled by adapters with their own entry; the core merges entries
 * @property {Evidence} [evidence]
 * @property {ReviewState} review  "auto" for structured dates; "pending" for text-extracted ones
 * @property {{from: string, at: string}|null} [moved]   Set by the core
 * @property {{uid: string, seq: number, hash: string}} [calendar]  Set by the core only
 * @property {string} [details]
 * @property {Record<string, unknown>} [meta]  Source-specific, JSON-serialisable
 */

/**
 * @typedef {"applied"|"not-selected"|"selected-for-interview"|"interview-scheduled"|"alternate"|"offer"
 *   |"ranked"|"matched"|"declined"|"withdrawn"|"unknown"} ApplicationStatus
 */

/**
 * @typedef {Object} Application
 * @property {string} id           `waterlooworks:${jobId}`
 * @property {string} employer
 * @property {string} jobTitle
 * @property {string} [jobId]
 * @property {string} [cycle]      e.g. "Winter 2027 main round"
 * @property {ApplicationStatus} status
 * @property {{status: ApplicationStatus, at: string}[]} history   Filled by the core from status diffs
 * @property {string[]} itemIds    Linked interview / offer / deadline items
 * @property {string} [url]
 */

/**
 * @typedef {Object} Update
 * @property {string} id
 * @property {string} at
 * @property {SourceId} source
 * @property {"new"|"moved"|"cancelled"|"status"|"review"} kind
 * @property {string} text
 * @property {string} [refId]      Item or Application id
 */

/**
 * @typedef {Object} Course
 * @property {string} code         "ECE 105" (subject uppercase, one space, catalog)
 * @property {string} [name]
 * @property {number} term         UW term code, e.g. 1269 = Fall 2026
 * @property {string[]} [sections] ["LEC 002", "TUT 104"]
 * @property {string} [group]      e.g. "5"
 * @property {number} [learnOrgUnitId]
 * @property {string} [outlineUrl]
 * @property {{component: string, weight: number}[]} [weights]
 * @property {{component: string, category?: string, points?: number, max?: number,
 *   weight?: number, display?: string}[]} [grades]
 * @property {{title: string, url: string}[]} [syllabusUrls]
 * @property {{component: string, weight: number|null, dateText: string,
 *   itemId: string|null, from: "table"|"chart"}[]} [assessments]
 * @property {{name: string|null, rows: {component: string, dateText: string,
 *   location: string, weight: number}[]}[]} [gradingSchemes]
 * @property {string} [officeHours]  e.g. "Mon/Wed 3:30–4:20 PM · MC 5417"
 * @property {{name: string, email?: string, section?: string}[]} [instructors]
 */

/**
 * @typedef {Object} Team
 * @property {string} name         "WATonomous"
 * @property {string} [guildId]
 * @property {string[]} [watchedChannelIds]
 * @property {string[]} [focus]    e.g. ["electrical"]
 * @property {string[]} [keywords]
 */

/**
 * @typedef {Object} TermInfo
 * @property {number} termCode
 * @property {string} start        ISO date (first day of classes)
 * @property {string} end          ISO date (last day of classes)
 * @property {{start: string, end: string}} [readingWeek]
 * @property {{start: string, end: string}} [midtermWeek]
 * @property {{start: string, end: string}} [examPeriod]
 * @property {{n: number, start: string, end: string}[]} [weeks]
 */

/**
 * Shared text-date extraction (implemented by Window 2 in src/lib/textdates/).
 * @typedef {Object} DateHit
 * @property {string} startAt
 * @property {string} [endAt]
 * @property {boolean} allDay
 * @property {string} text         The matched text
 * @property {number} index        Offset in the input
 * @property {number} confidence   0..1
 * @property {boolean} [weekdayMismatch]   e.g. "Thursday, October 27" when Oct 27 is a Tuesday
 */
/** @typedef {(text: string, opts: {now: Date, termCode?: number, tz?: string}) => DateHit[]} ExtractDates */

/**
 * Result of one fetch (T1) or relay (T2).
 * @typedef {Object} FetchResult
 * @property {number} status       0 = network error / timeout
 * @property {string} [url]        Final URL after redirects
 * @property {string} [contentType]
 * @property {string} [text]       Body text (JSON or HTML) when status is 2xx
 * @property {string} [base64]     Body as base64 instead of text when the request's init.binary is true
 * @property {boolean} [loginRedirect]
 * @property {boolean} [noTab]     Relay only: no usable tab of that site is open
 * @property {string} [error]      e.g. "timeout", "not-allowed", "too-large" (binary body over 10 MB)
 */

/**
 * @typedef {Object} SyncContext
 * @property {Date} now
 * @property {Record<string, any>} settings     This source's settings slice
 * @property {Record<string, any>} state        This source's private state from the last run (read-only)
 * @property {Course[]} courses
 * @property {TermInfo[]} terms
 * @property {{id: string, employer?: string, jobTitle?: string, jobId?: string,
 *   status?: ApplicationStatus}[]} [applications]  known applications (slim view)
 * @property {(url: string, init?: {method?: string, headers?: Record<string,string>, body?: string, binary?: boolean}) => Promise<FetchResult>} fetch   T1, credentials included
 * @property {(origin: string, path: string, init?: {method?: string, headers?: Record<string,string>, body?: string, binary?: boolean}) => Promise<FetchResult>} relay   T2 through an open tab
 * @property {(html: string, parser: string, opts?: Record<string, any>) => Promise<any>} parseHtml   Runs a registered parser ("<source>/<name>") in the offscreen document
 * @property {ExtractDates} textDates
 * @property {(message: string, data?: unknown) => void} log
 */

/**
 * @typedef {Object} SyncResult
 * @property {Item[]} items
 * @property {Application[]} [applications]
 * @property {Course[]} [courses]
 * @property {TermInfo[]} [terms]
 * @property {boolean} complete     false if any part failed; the core then keeps items it didn't see
 * @property {string[]} [readOk]    Scopes that read completely this run (items from other scopes are kept)
 * @property {Update[]} [updates]   Feed entries the adapter detected itself (e.g. application status changes)
 * @property {Record<string, any>} [state]   New private state to persist
 * @property {"signed-in"|"signed-out"|"no-tab"|"unreachable"} [session]
 * @property {{code: string, message: string}} [error]
 */

/**
 * A payload seen by the main-world observer (T3) or a site content script.
 * @typedef {Object} ObservedPayload
 * @property {SourceId} source
 * @property {"net"|"dom"} kind
 * @property {string} url
 * @property {string} [method]
 * @property {number} [status]
 * @property {string} [contentType]
 * @property {string} body          JSON text, HTML, or serialised DOM extract
 * @property {string} at
 */

/**
 * Every source adapter default-exports one of these from src/sources/<id>/index.js.
 * HTML parsers are pure functions `(doc: Document, opts) => data`, exported by name from
 * src/sources/<id>/parsers.js and called through ctx.parseHtml("<id>/<name>", ...).
 * @typedef {Object} Adapter
 * @property {SourceId} id
 * @property {string} label
 * @property {string[]} origins               e.g. ["https://waterlooworks.uwaterloo.ca"]
 * @property {number} intervalMinutes         Background sync interval (0 = only on tab open / observe)
 * @property {boolean} syncOnTabOpen          Run sync when a tab of an origin finishes loading
 * @property {(ctx: SyncContext) => Promise<SyncResult>} [sync]                          T1/T2
 * @property {{urlPatterns: string[], parse: (p: ObservedPayload, ctx: SyncContext) => Promise<SyncResult & {scope: string}>}} [observe]   T3
 */

/** Runtime messages between content scripts, the page observer and the background. */
export const MSG = Object.freeze({
  /** content script -> background: { type, source, scope, items, applications?, complete } */
  CAPTURE: "wa1:capture",
  /** content script -> background: { type, payload: ObservedPayload } */
  OBSERVED: "wa1:observed",
  /** content script -> background: { type, site, entry } (discovery recorder) */
  DISCOVERY: "wa1:discovery",
  /** background -> content script: { type, path, init } ; reply FetchResult */
  RELAY_FETCH: "wa1:relay-fetch",
  /** content script -> background: { type, source, url } sent once per page load */
  TAB_READY: "wa1:tab-ready",
});

/** CustomEvent name the main-world observer dispatches on `document`; detail is a JSON string. */
export const PAGE_EVENT = "wa1:page-net";

export const SOURCE_IDS = /** @type {const} */ (["learn", "outline", "portal", "waterlooworks", "discord", "outlook", "gmail", "gcal", "manual"]);

export const ITEM_TYPES = /** @type {const} */ ([
  "deadline", "quiz", "exam", "presentation", "class", "tutorial", "lab", "meeting", "interview",
  "application-deadline", "offer-deadline", "cycle-date", "task", "event", "term-date",
]);

/** hostname -> SourceId, used by the observer, recorder and relay. */
export const SITE_BY_HOST = Object.freeze({
  "learn.uwaterloo.ca": "learn",
  "outline.uwaterloo.ca": "outline",
  "portal.uwaterloo.ca": "portal",
  "waterlooworks.uwaterloo.ca": "waterlooworks",
  // Public co-operative-education pages WaterlooWorks sync fetches; no
  // content script ever runs there, so this is fetch attribution only.
  "uwaterloo.ca": "waterlooworks",
  "discord.com": "discord",
  "outlook.office.com": "outlook",
  "outlook.cloud.microsoft": "outlook",
  "outlook.live.com": "outlook",
  "mail.google.com": "gmail",
  "calendar.google.com": "gcal",
});

/**
 * @param {SourceId} source
 * @param {string} key
 * @returns {string}
 */
export const itemId = (source, key) => `${source}:${key}`;

/**
 * "ece105" / "ECE 105" / "ECE105" -> "ECE 105"
 * @param {unknown} raw
 */
export function normCourseCode(raw) {
  const m = String(raw || "").match(/^\s*([A-Za-z]{2,8})\s*[_ -]?\s*(\d{3}[A-Z]{0,2})(?![A-Za-z0-9])/);
  return m ? `${m[1].toUpperCase()} ${m[2].toUpperCase()}` : String(raw || "").trim();
}
