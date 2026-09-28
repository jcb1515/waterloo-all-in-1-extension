// @ts-check
// Parser rows/details -> contract objects (pure; no chrome APIs).

import { itemId } from "../../core/contract.js";
import { termKey } from "../../core/todos.js";
import { hashString } from "../../capture/redact.js";
import { termCodeFor, zonedIso, zonedParts } from "../../lib/textdates/index.js";
import { normalizeStatus } from "./status.js";
import {
  SCOPE,
  COOP_KEEP_RE,
  COOP_CATEGORIES,
  COOP_ZONE_RE,
  COOP_END_OF_DAY_RE,
  COOP_TIME_RE,
  COOP_WORK_TERM_LINE_RE,
} from "./selectors.js";

/** @typedef {import("../../core/contract.js").Item} Item */
/** @typedef {import("../../core/contract.js").Application} Application */
/**
 * WW's stored application carries the Job Status column text on top of the
 * frozen contract — WaterlooWorks reports both "App Status" (the student's
 * state) and "Job Status" (the posting's stage), and the latter is useful
 * context the contract has no field for.
 * @typedef {Application & {jobStatus?: string, submittedOn?: string}} WWApplication
 */

const SOURCE = "waterlooworks";
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Employer display name as WaterlooWorks shows it: whitespace collapsed,
 * trimmed; undefined when absent.
 * @param {any} value
 */
function normEmployer(value) {
  const s = String(value || "").replace(/\s+/g, " ").trim();
  return s || undefined;
}

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

/** meta.facts builder: keeps only non-empty values, in order. */
function factsOf(pairs) {
  const out = [];
  for (const pair of pairs) {
    if (!pair) continue;
    const [label, value] = pair;
    const v = value == null ? "" : String(value).trim();
    if (v) out.push({ label, value: v });
  }
  return out.length ? out : undefined;
}

/** "Thu Oct 8, 4:00 PM" — Toronto wall-clock rendering of an ISO instant. */
const WW_LOCAL_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Toronto",
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});
const wwLocalText = (value) => {
  const ms = Date.parse(String(value || ""));
  if (!Number.isFinite(ms)) return undefined;
  return WW_LOCAL_FMT.format(new Date(ms)).replace(/^(\w+),\s*/, "$1 ");
};

/**
 * @param {any[]} rows  parseApplications rows
 * @returns {Application[]}
 */
/** Non-array input (garbage state) reads as empty. */
const arr = (v) => (Array.isArray(v) ? v : []);

export function toApplications(rows) {
  return arr(rows)
    .filter((row) => row && row.jobId)
    .map((row) => /** @type {WWApplication} */ ({
      id: `waterlooworks:${row.jobId}`,
      employer: row.employer || "",
      jobTitle: row.jobTitle || "",
      jobId: row.jobId,
      cycle: row.term,
      jobStatus: row.jobStatusText || undefined,
      submittedOn: row.submittedOn || undefined,
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
  for (const row of arr(rows)) {
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
      seenIn: [{ source: SOURCE, key, scope: SCOPE, at: nowIso }],
      details: details || undefined,
      meta: {
        jobId: row.jobId,
        division: row.division,
        term: row.term,
        type: row.type,
        method: row.method,
        scheduleStatus: row.scheduleStatus,
        confirmationStatus: row.confirmationStatus,
        facts: factsOf([
          ["Employer", row.employer],
          ["Job", row.jobTitle ? `${row.jobId} - ${row.jobTitle}` : row.jobId],
          ["Method", row.method],
          ["Type", row.type],
          ["Where", row.location || row.method],
          /\bconfirm(ed)?\b/i.test(row.confirmationStatus || "")
            ? ["Booking", "Booked"]
            : null,
        ]),
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
 * @param {{apps?: any[]}} [opts]  apps = stored applications for the
 *   employer fallback on the timeslot task
 * @returns {Item[]}
 */
export function interviewDetailItems(detail, now, { apps } = {}) {
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
      seenIn: [{ source: SOURCE, key, scope: SCOPE, at: nowIso }],
      details: details || undefined,
      meta: {
        jobId: detail.jobId,
        division: detail.division,
        facts: factsOf([
          ["Employer", detail.employer],
          [
            "Job",
            detail.jobTitle
              ? `${detail.jobId} - ${detail.jobTitle}`
              : detail.jobId,
          ],
          ["Method", detail.method],
          ["Type", detail.interviewType],
          ["Where", detail.where],
          ["Interviewer", detail.interviewer],
          ["Booking", detail.booked ? "Booked" : detail.bookingPermission],
          [
            "Instructions",
            detail.instructions
              ? String(detail.instructions).slice(0, 300)
              : undefined,
          ],
        ]),
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
  const available = arr(detail.slots).filter((slot) =>
    /^available$/i.test(slot?.state || "")
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
          scope: SCOPE,
          at: nowIso,
        },
      ],
      meta: {
        jobId: detail.jobId,
        action: "book-interview",
        employer:
          detail.employer ||
          arr(apps).find((a) => a && a.jobId === detail.jobId)?.employer ||
          undefined,
        availableSlots: available.length,
        rule: "24h-before-first-slot",
        facts: factsOf([
          [
            "Job",
            detail.jobTitle
              ? `${detail.jobId} - ${detail.jobTitle}`
              : detail.jobId,
          ],
          ["Employer", detail.employer],
          ["Earliest slot", wwLocalText(firstStart)],
          [
            "Rule",
            "WaterlooWorks picks a slot for you if you haven't booked one day before",
          ],
        ]),
      },
    });
  }
  return items;
}

/**
 * Dashboard "Your Upcoming Schedule" rows -> Items. Interview rows reuse the
 * `interview:<jobId>` id so they collapse onto list/detail items for the
 * same job (cachedItems keeps the richer of the two); other entry types are
 * plain events.
 * @param {any[]} rows  parseDashboard schedule rows
 * @param {any[]} applications  state.applications, for employer enrichment
 * @param {Date} now
 * @returns {Item[]}
 */
export function scheduleItems(rows, applications, now) {
  const nowIso = iso(now);
  const apps = arr(applications);
  const used = new Set();
  const items = [];
  for (const row of arr(rows)) {
    if (!row?.startAt) continue;
    const employer = row.jobId
      ? apps.find((app) => app?.jobId === row.jobId)?.employer || undefined
      : undefined;
    const isInterview = /\binterview\b/i.test(row.entryType || "") ||
      /\binterview\b/i.test(row.name || "");
    /** @type {string} */
    let key;
    /** @type {string} */
    let type;
    /** @type {string} */
    let title;
    if (isInterview) {
      type = "interview";
      title = row.jobTitle ? `Interview: ${row.jobTitle}` : "Interview";
      key = row.jobId
        ? `interview:${row.jobId}`
        : `schedule-interview:${fnv(`${row.name || ""}|${row.startAt}`)}`;
    } else {
      type = "event";
      title = String(row.name || "").trim() || "Appointment";
      key = `schedule:${fnv(`${row.entryType || ""}|${row.name || ""}|${row.startAt}`)}`;
    }
    let id = itemId(SOURCE, key);
    let n = 2;
    while (used.has(id)) {
      key = `${key}-${n++}`;
      id = itemId(SOURCE, key);
    }
    used.add(id);
    items.push({
      id,
      source: SOURCE,
      type,
      title,
      org: employer,
      startAt: row.startAt,
      endAt: row.endAt || undefined,
      status: cancelled(row.status) ? "cancelled" : "open",
      confidence: "exact",
      review: "auto",
      seenIn: [{ source: SOURCE, key, scope: SCOPE, at: nowIso }],
      meta: {
        jobId: row.jobId,
        scheduleType: row.entryType,
        status: row.status,
        conflicts: row.conflicts,
        facts: factsOf([
          ["Employer", employer],
          ["Job", row.jobTitle ? `${row.jobId} - ${row.jobTitle}` : row.jobId],
          ["Type", row.entryType],
          ["Status", row.status],
        ]),
      },
      evidence: { method: "html" },
    });
  }
  return items;
}

/**
 * The dashboard's "Upcoming Events / Workshops" table is the Career Centre's
 * public listing — a row only belongs on the student's calendar when it
 * shows they're actually registered ("Registration Required" and
 * "Waitlist…" are invites, not plans). The student's own registrations also
 * arrive from the events grid page.
 * @param {any} text  the row's registration badge text
 */
const isRegistered = (text) => {
  const t = String(text || "");
  return /\bregistered\b/i.test(t) && !/required|not registered|waitlist/i.test(t);
};

/**
 * Host/employer display name from an event title: a "with X" / "hosted by
 * X" / "presented by X" clause on the last " — " segment, with trailing
 * modality words stripped. Titles without an em-dash segment yield nothing
 * (a bare "with" inside the event name is not a host). Never "WaterlooWorks".
 * @param {unknown} title
 */
const MODALITY_TAIL_RE =
  /(?:\s*[-–—(,]?\s*\b(?:in[-\s]?person|virtual|hybrid|online|remote|on[-\s]?site|information session|info session|session|workshop|webinar|networking|fair)\b)+[\s.,;)]*$/i;
export function eventOrg(title) {
  const segs = String(title || "").split(" — ");
  const last = segs[segs.length - 1];
  // "hosted by"/"presented by" are unambiguous on any title; a bare "with X"
  // only counts on an em-dash segment, else "…with AI" names a fake org.
  const m =
    /\bhosted\s+by\s+(.+)$/i.exec(last) ||
    /\bpresented\s+by\s+(.+)$/i.exec(last) ||
    (segs.length > 1 ? /\bwith\s+(.+)$/i.exec(last) : null);
  if (!m) return undefined;
  const org = m[1]
    .replace(MODALITY_TAIL_RE, "")
    .replace(/\s*[-–—(,]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!org || org.length > 80 || /^waterlooworks$/i.test(org)) return undefined;
  return org;
}

/**
 * Dashboard "Upcoming Events / Workshops" rows -> event Items — every dated
 * row now emits one (registered = auto, everything else = pending review).
 * The day comes from each table's colspan'd header, times from the row's
 * range text; a dated row with no parseable time is all-day.
 * @param {any[]} rows  parseDashboard events rows
 * @param {Date} now
 * @param {{url?: string}} [opts]  url = the page the rows were read on
 * @returns {Item[]}
 */
export function dashboardEventItems(rows, now, { url } = {}) {
  const nowIso = iso(now);
  const used = new Set();
  const items = [];
  for (const row of arr(rows)) {
    // Never a time without a date: every emitted row anchors on a real day.
    if (!row || !row.date) continue;
    const timed = Boolean(row.startAt);
    /** @type {string} */
    let key = row.eventId
      ? `event:${row.eventId}`
      : `event:${fnv(`${row.category || ""}|${row.name || ""}|${row.startAt || row.date}`)}`;
    let id = itemId(SOURCE, key);
    let n = 2;
    while (used.has(id)) {
      key = `${key}-${n++}`;
      id = itemId(SOURCE, key);
    }
    used.add(id);
    const registered = row.registration
      ? isRegistered(row.registration)
      : undefined;
    const waitlisted =
      row.registration && /waitlist/i.test(row.registration) ? true : undefined;
    /** @type {any} */
    const item = {
      id,
      source: SOURCE,
      type: "event",
      title: row.name || "Event",
      org: eventOrg(row.name),
      startAt: timed ? row.startAt : row.date,
      endAt: timed ? row.endAt || undefined : undefined,
      location: row.link || row.location || undefined,
      url: row.link || undefined,
      status: cancelled(row.registration) ? "cancelled" : "open",
      confidence: "exact",
      review: registered ? "auto" : "pending",
      evidence: { method: "html", url: url || undefined },
      seenIn: [{ source: SOURCE, key, scope: SCOPE, at: nowIso }],
      meta: {
        eventId: row.eventId || undefined,
        category: row.category || undefined,
        registered,
        waitlisted,
        registrationStatus: row.registration,
        facts: factsOf([
          ["Category", row.category],
          ["Registration", row.registration],
          ["Location", row.location],
        ]),
      },
    };
    if (!timed) item.allDay = true;
    items.push(item);
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
  for (const row of arr(rows)) {
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
      seenIn: [{ source: SOURCE, key, scope: SCOPE, at: nowIso }],
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
      seenIn: [{ source: SOURCE, key, scope: SCOPE, at: iso(now) }],
      meta: {
        jobId: posting.jobId,
        division: posting.division,
        facts: factsOf([
          [
            "Job",
            posting.jobTitle
              ? `${posting.jobId} - ${posting.jobTitle}`
              : posting.jobId,
          ],
          ["Employer", posting.employer],
          ["Work term", posting.fields?.["Work Term"]],
          ["Level", posting.fields?.Level],
          ["City", posting.fields?.["Job - City"] || posting.fields?.City],
        ]),
      },
    },
  ];
}

/** Message-date items are kept only when the hit clears this bar. */
const MSG_MIN_CONFIDENCE = 0.6;
/** Offer phrasing that marks a message body as an actual job offer. */
const OFFER_BODY_RE =
  /\b(?:job\s+offer|offer\s+of\s+employment|employment\s+offer|respond\s+to\s+(?:the|this|your)\s+offer|accept\s+(?:the|this|your)\s+offer|offer\s+(?:deadline|expires?))\b/i;
/** Within an offer message, only a hit whose sentence asks for a response. */
const OFFER_HIT_RE = /\b(?:respond|accept|decline|deadline|expires?|by)\b/i;
/** Hits more than this far before the message's send time are past references. */
const MSG_PAST_MS = DAY_MS;
const SNIPPET_MAX = 300;
const TITLE_MAX = 100;

/** Normalize a message subject so list rows and detail pages hash alike. */
const normalizeSubject = (subject) =>
  String(subject || "").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * The Toronto calendar day (YYYY-MM-DD) of a send time. A bare "YYYY-MM-DD"
 * input is already a calendar day; a timestamp is read in Toronto.
 * @param {string|undefined} sentAt
 * @param {Date} fallback
 */
function torontoDay(sentAt, fallback) {
  if (typeof sentAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sentAt)) {
    return sentAt;
  }
  const date = sentAt ? new Date(sentAt) : fallback;
  const valid = date instanceof Date && !Number.isNaN(date.getTime()) ? date : fallback;
  const p = zonedParts(valid);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/**
 * Stable per-message key. The inbox row's `receivedAt` and the detail page's
 * `createdAt` are the same instant, so both hash to one key and the detail
 * read replaces the list read's items rather than duplicating them.
 * @param {string|undefined} subject
 * @param {string|undefined} sentAt
 * @param {Date} now  fallback when sentAt is missing/unparseable
 */
export function messageKey(subject, sentAt, now) {
  return hashString(`${normalizeSubject(subject)}|${torontoDay(sentAt, now)}`);
}

/**
 * The sentence of `text` containing the matched date (hit.index/hit.text),
 * capped at SNIPPET_MAX chars. When the sentence itself overflows, keep a
 * window centred on the match so the snippet still shows the date.
 * @param {string} text
 * @param {{index: number, text: string}} hit
 */
function snippetAround(text, hit) {
  const start = hit.index;
  const end = start + hit.text.length;
  const before = text.slice(0, start);
  const left =
    Math.max(
      before.lastIndexOf("."),
      before.lastIndexOf("!"),
      before.lastIndexOf("?"),
      before.lastIndexOf("\n")
    ) + 1;
  const rest = /[.!?]/.exec(text.slice(end));
  const right = rest ? end + rest.index + 1 : text.length;
  let sentence = text.slice(left, right).replace(/\s+/g, " ").trim();
  if (sentence.length > SNIPPET_MAX) {
    const hitStart = Math.max(0, start - left);
    const from = Math.max(
      0,
      Math.min(hitStart - Math.floor(SNIPPET_MAX / 2), sentence.length - SNIPPET_MAX)
    );
    sentence = sentence.slice(from, from + SNIPPET_MAX).trim();
  }
  return sentence.slice(0, SNIPPET_MAX);
}

/** First keyword match on subject + snippet decides the item type. */
function messageType(subject, snippet) {
  const text = `${subject || ""} ${snippet}`;
  if (/interview/i.test(text)) return "interview";
  if (/\b(rank|ranking|match|cycle|job postings?)\b/i.test(text)) return "cycle-date";
  if (/\b(due|deadline|closes?|submit|by)\b/i.test(text)) return "deadline";
  return "event";
}

/**
 * Dates mentioned in a WaterlooWorks message -> pending Review items.
 * `text` is transient (subject + body text); only the ≤300-char sentence that
 * contains each matched date is stored, in `details` and `evidence.snippet`.
 * @param {{subject?: string, sentAt?: string, text?: string, url?: string,
 *   category?: string, subCategory?: string, employer?: string,
 *   jobId?: string, origin?: "list"|"detail"}} msg
 * @param {(text: string, opts: {now: Date, termCode?: number, tz?: string}) => any[]} extractDates
 *   ctx.textDates — the shared textdates extractor
 * @param {string} nowIso
 * @returns {Item[]}
 */
export function messageDateItems(msg, extractDates, nowIso) {
  if (typeof extractDates !== "function" || !msg?.text) return [];
  const now = new Date(nowIso);
  const sent = msg.sentAt ? new Date(msg.sentAt) : null;
  const ref = sent && !Number.isNaN(sent.getTime()) ? sent : now;
  const hits = extractDates(msg.text, {
    now: ref,
    termCode: termCodeFor(ref),
  });
  const msgKey = messageKey(msg.subject, msg.sentAt, now);
  const cutoff = ref.getTime() - MSG_PAST_MS;
  const employer = normEmployer(msg.employer);
  // Offer mail linked to a job/employer turns its date hits into
  // respond-to-offer tasks rather than generic message items (same id, so
  // they replace rather than duplicate). The body must use explicit
  // offer-of-employment phrasing — "we offer flexible hours" in an
  // interview invite is not an offer.
  const offerMessage =
    Boolean(employer || msg.jobId) &&
    (/\boffers?\b/i.test(
      `${msg.subject || ""} ${msg.category || ""} ${msg.subCategory || ""}`
    ) ||
      OFFER_BODY_RE.test(String(msg.text || "")));
  const items = [];
  for (const hit of hits || []) {
    if (hit.confidence < MSG_MIN_CONFIDENCE) continue;
    const startMs = Date.parse(hit.startAt);
    if (Number.isNaN(startMs) || startMs < cutoff) continue;
    const snippet = snippetAround(msg.text, hit);
    const type = messageType(msg.subject, snippet);
    const key = `msg:${msgKey}:${hit.startAt}`;
    /** @type {Item} */
    const item = {
      id: itemId(SOURCE, key),
      source: SOURCE,
      type,
      title: String(msg.subject || "WaterlooWorks message").trim().slice(0, TITLE_MAX) ||
        "WaterlooWorks message",
      org: msg.employer || "WaterlooWorks",
      url: msg.url || undefined,
      status: "open",
      confidence: "tentative",
      review: "pending",
      seenIn: [{ source: SOURCE, key, scope: SCOPE, at: nowIso }],
      details: snippet || undefined,
      evidence: { snippet, url: msg.url || undefined, method: "text" },
      meta: {
        messageKey: msgKey,
        messageOrigin: msg.origin === "list" ? "list" : "detail",
        category: msg.category || undefined,
        weekdayMismatch: Boolean(hit.weekdayMismatch),
        facts: factsOf([
          ["Category", msg.category],
          ["From message", msg.subject],
        ]),
      },
    };
    if (hit.allDay) {
      item.startAt = hit.startAt;
      item.allDay = true;
      if (hit.endAt) item.endAt = hit.endAt; // exclusive midnight (textdates)
    } else if (type === "deadline" || type === "cycle-date") {
      item.dueAt = hit.startAt;
    } else {
      item.startAt = hit.startAt;
      if (hit.endAt) item.endAt = hit.endAt;
    }
    // Even on offer mail, only a hit whose own sentence carries a response
    // cue converts — an unrelated date in the same body stays generic.
    if (offerMessage && OFFER_HIT_RE.test(snippet || "")) {
      item.type = "deadline";
      item.title = employer
        ? `Respond to offer — ${employer}`
        : "Respond to offer";
      item.org = employer || "Co-op";
      delete item.startAt;
      delete item.endAt;
      delete item.allDay;
      item.dueAt = hit.startAt;
      /** @type {Record<string, unknown>} */
      const meta = item.meta || {};
      meta.action = "respond-offer";
      meta.employer = employer;
      meta.jobId = msg.jobId || undefined;
      item.meta = meta;
    }
    items.push(item);
  }
  return items;
}

// ---------------------------------------------------------------------------
// shared task seam: meta.action + meta.employer on every derived to-do

/**
 * Undated-task fallback: anchor + 2 days at 17:00 America/Toronto.
 * @param {number|string|Date} anchor
 * @returns {string} ISO
 */
function undatedDueAt(anchor) {
  const plus2 = new Date(new Date(anchor).getTime() + 2 * DAY_MS);
  const p = zonedParts(plus2, "America/Toronto");
  return zonedIso(p.y, p.m, p.d, 17, 0, "America/Toronto");
}

const NOTICE_DOC_RE =
  /\b(reports?|forms?|evaluations?|documents?|reflections?|resumes?|résumés?|cover\s+letters?|transcripts?)\b/i;
// Due cue: "due"/"deadline", or "submit(ted) by/before/no later than" — a
// bare "by" (a post's "Posted by", an author's name) is not a cue.
const NOTICE_DUE_RE =
  /\bdue\b|\bdeadlines?\b|\bsubmit(?:ted)?\s+(?:by|before|no\s+later\s+than)\b/i;

/**
 * Dashboard notices/alerts/posts -> "submit a document" hard deadlines.
 * A notice only qualifies when its text carries a document noun AND a due
 * cue AND a parseable date — "Posted <date>" video posts, term-status
 * alerts and the rankings-not-open notice never match the triple.
 * @param {{heading?: string, text?: string}[]} notices  parseDashboard
 * @param {(text: string, opts: {now: Date, termCode?: number}) => any[]}|undefined} extractDates
 * @param {string} nowIso
 * @returns {Item[]}
 */
export function noticeItems(notices, extractDates, nowIso) {
  if (typeof extractDates !== "function") return [];
  const now = new Date(nowIso);
  const items = [];
  const seenText = new Set();
  for (const notice of arr(notices)) {
    const text = `${notice?.heading || ""} ${notice?.text || ""}`.trim();
    if (!text || seenText.has(text)) continue;
    seenText.add(text);
    if (!NOTICE_DOC_RE.test(text) || !NOTICE_DUE_RE.test(text)) continue;
    const hit = arr(
      extractDates(text, { now, termCode: termCodeFor(now) })
    ).find(
      (h) =>
        h &&
        h.confidence >= MSG_MIN_CONFIDENCE &&
        Date.parse(h.startAt) >= now.getTime() - MSG_PAST_MS
    );
    if (!hit) continue;
    const heading = String(notice?.heading || "").trim();
    const key = `notice:${fnv(`${heading}|${hit.startAt}`)}`;
    items.push({
      id: itemId(SOURCE, key),
      source: SOURCE,
      type: "deadline",
      title: heading.slice(0, TITLE_MAX) || "WaterlooWorks notice",
      org: "Co-op",
      dueAt: hit.startAt,
      status: "open",
      review: "pending",
      seenIn: [{ source: SOURCE, key, scope: SCOPE, at: nowIso }],
      details: notice?.text
        ? String(notice.text).slice(0, 300)
        : undefined,
      evidence: { method: "text" },
      meta: {
        action: "submit-document",
        employer: "Co-op",
        facts: factsOf([["From notice", heading]]),
      },
    });
  }
  return items;
}

/** App statuses still in the interview/offer pipeline (rankings pending). */
const RANKINGS_IN_FLIGHT = new Set([
  "selected-for-interview",
  "interview-scheduled",
  "alternate",
  "offer",
]);

/**
 * One "Submit your rankings" task per work term that has an in-flight app.
 * dueAt = the earliest upcoming rankings-due co-op date for that term; when
 * none exists but the dashboard shows rankings open for the term the
 * undated rule anchors at the FIRST time rankings were seen open for the
 * term (rankingsOpenSeen) — the notice's `at` changes on every dashboard
 * read and would drift the dueAt, producing phantom "moved" updates.
 * @param {{applications?: any[], cycleItems?: Item[],
 *   rankings?: {term?: string, open?: boolean, note?: string,
 *   at?: string}, rankingsOpenSeen?: Record<string, string>}} input
 * @param {Date} now
 * @returns {Item[]}
 */
export function rankingsTaskItems(input, now) {
  const nowMs = now.getTime();
  const nowIso = iso(now);
  /** @type {Set<string>} */
  const inFlight = new Set();
  /** @type {Set<string>} */
  const answered = new Set();
  for (const app of arr(input?.applications)) {
    const term = termKey(app?.cycle);
    if (!term) continue;
    if (RANKINGS_IN_FLIGHT.has(app?.status)) inFlight.add(term);
    else if (app?.status === "ranked" || app?.status === "matched") {
      answered.add(term);
    }
  }
  const rankings = input?.rankings;
  const openTerm = rankings?.open ? termKey(rankings.term) : null;
  const items = [];
  for (const term of inFlight) {
    if (answered.has(term)) continue;
    let due;
    for (const c of arr(input?.cycleItems)) {
      if (c?.category !== "rankings-due") continue;
      if (termKey(c?.meta?.workTerm) !== term) continue;
      const ms = Date.parse(c.dueAt || c.startAt || "");
      if (!Number.isFinite(ms) || ms <= nowMs) continue;
      if (due === undefined || ms < Date.parse(due)) {
        due = c.dueAt || c.startAt;
      }
    }
    const undated = due === undefined;
    if (undated && !(openTerm && openTerm === term)) continue;
    const key = `rankings:${slug(term)}`;
    items.push({
      id: itemId(SOURCE, key),
      source: SOURCE,
      type: undated ? "task" : "deadline",
      title: `Submit your rankings — ${term}`,
      org: "Co-op",
      dueAt: undated
        ? undatedDueAt(
            (input?.rankingsOpenSeen || {})[term] || rankings?.at || now
          )
        : due,
      status: "open",
      review: "auto",
      seenIn: [{ source: SOURCE, key, scope: SCOPE, at: nowIso }],
      meta: {
        action: "submit-rankings",
        employer: "Co-op",
        workTerm: term,
        undated: undated || undefined,
        facts: factsOf([
          ["Work term", term],
          undated && rankings?.note ? ["Notice", rankings.note] : null,
        ]),
      },
    });
  }
  return items;
}

/**
 * Shortlist grid rows -> "Apply" deadlines, future postings only and never
 * for a job the applications list already shows.
 * @param {any[]} rows  parseShortlist rows
 * @param {any[]} applications  stored apps
 * @param {Date} now
 * @returns {Item[]}
 */
export function applyItems(rows, applications, now) {
  const applied = new Set(
    arr(applications)
      .map((app) => app && app.jobId)
      .filter(Boolean)
  );
  const nowMs = now.getTime();
  const nowIso = iso(now);
  const items = [];
  for (const row of arr(rows)) {
    const jobId = row && row.jobId;
    if (!jobId || applied.has(jobId)) continue;
    const dueMs = Date.parse(row.appDeadline || "");
    if (!Number.isFinite(dueMs) || dueMs <= nowMs) continue; // future only
    const employer = normEmployer(row.employer);
    const key = `apply:${jobId}`;
    items.push({
      id: itemId(SOURCE, key),
      source: SOURCE,
      type: "deadline",
      title: `Apply: ${row.jobTitle || jobId}${employer ? ` — ${employer}` : ""}`.slice(
        0,
        TITLE_MAX
      ),
      org: employer,
      dueAt: row.appDeadline,
      status: "open",
      // Structured grid data the student shortlisted themselves — straight
      // to the feed, no Review stop.
      review: "auto",
      seenIn: [{ source: SOURCE, key, scope: SCOPE, at: nowIso }],
      evidence: { method: "html" },
      meta: {
        action: "apply",
        employer,
        jobId,
        category: "apply",
        facts: factsOf([
          [
            "Job",
            row.jobTitle ? `${jobId} - ${row.jobTitle}` : jobId,
          ],
          ["Employer", employer],
          ["Deadline", wwLocalText(row.appDeadline)],
        ]),
      },
    });
  }
  return items;
}

/** Ids are slug-based and date-free so a moved date reads as "moved". */
const slug = (text, fallback = "general") =>
  String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || fallback;

/**
 * An entry's work term. Lines that name their term ("Fall 2026 co-op work
 * term starts") use the named season/year; otherwise the recruiting-month
 * rule applies: Sep–Dec year Y is for the Winter Y+1 work term, Jan–Apr for
 * Spring Y, May–Aug for Fall Y.
 * @param {{date: string, text?: string}} e
 */
function coopWorkTerm(e) {
  const named = COOP_WORK_TERM_LINE_RE.exec(e?.text || "");
  if (named) {
    const season = named[1][0].toUpperCase() + named[1].slice(1).toLowerCase();
    return `${season} ${named[2]}`;
  }
  const [y, m] = e.date.split("-").map(Number);
  if (m >= 9) return `Winter ${y + 1}`;
  if (m <= 4) return `Spring ${y}`;
  return `Fall ${y}`;
}

/** Event text minus the time phrase / "(ET)" / "by end of day" — for titles. */
function coopTextWithoutTime(text) {
  let t = String(text || "").replace(COOP_END_OF_DAY_RE, "");
  for (let i = 0; i < 4; i++) {
    const tm = COOP_TIME_RE.exec(t);
    if (!tm) break;
    t = t.slice(0, tm.index) + t.slice(tm.index + tm[0].length);
  }
  t = t.replace(COOP_ZONE_RE, " ");
  return t
    .replace(/\s*(?:at|by)\s*$/i, "")
    .replace(/\s*\d{1,2}\s*-\s*$/, "") // a range's orphaned lower bound ("… 2 -")
    .replace(/[\s,;:–—-]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function coopCategory(text) {
  for (const pair of COOP_CATEGORIES) {
    const [re, category] = /** @type {[RegExp, string]} */ (pair);
    if (re.test(text)) return category;
  }
  return "other";
}

/** "HH:MM" -> [h, mi]; date "YYYY-MM-DD" -> [y, m, d]. */
const parseHHMM = (t) => t.split(":").map(Number);
const parseYMD = (d) => d.split("-").map(Number);
const nextDay = (d) =>
  new Date(Date.parse(`${d}T00:00:00.000Z`) + DAY_MS).toISOString().slice(0, 10);

/**
 * Co-op important-dates entries -> cycle-date Items. The page is
 * authoritative: review "auto", confidence "exact". Ids contain no date so a
 * date that moves keeps its id (the core records "moved").
 * @param {{date: string, cycle: string|null, text: string,
 *   time: string|null, endOfDay: boolean}[]} entries  parseCoopDates output
 * @param {{url?: string, nowIso?: string}} opts
 * @returns {Item[]}
 */
export function coopDateItems(entries, { url, nowIso } = {}) {
  const keep = (e) =>
    Boolean(
      e && typeof e.date === "string" && /^\d{4}-\d{2}-\d{2}/.test(e.date)
    ) && COOP_KEEP_RE.test(`${e.cycle || ""} ${e.text || ""}`);

  // "Interviews" runs collapse to one all-day range per (workTerm, cycle) —
  // the same cycle name recurs each recruiting season, so the workTerm half
  // of the key keeps September's and January's "Cycle 1" apart.
  /** @type {Map<string, {first: number, min: string, max: string}>} */
  const runs = new Map();
  arr(entries).forEach((e, i) => {
    if (!keep(e) || coopCategory(e.text) !== "interviews") return;
    const key = `${coopWorkTerm(e)}|${e.cycle || "general"}`;
    const run = runs.get(key);
    if (run) {
      run.min = e.date < run.min ? e.date : run.min;
      run.max = e.date > run.max ? e.date : run.max;
    } else {
      runs.set(key, { first: i, min: e.date, max: e.date });
    }
  });
  /** @type {Map<number, string>} index of each run's first entry -> run key */
  const runFirst = new Map();
  for (const [key, run] of runs) runFirst.set(run.first, key);

  const used = new Set();
  /** @type {Item[]} */
  const items = [];
  const push = ({ cycle, workTerm, category, text, timing }) => {
    const leaf = category === "other" ? text : category;
    const base = `cycle:${slug(workTerm)}:${slug(cycle || "general")}:${slug(leaf, "other")}`;
    let key = base;
    let n = 2;
    while (used.has(key)) key = `${base}-${n++}`;
    used.add(key);
    /** @type {Item} */
    const item = {
      id: itemId(SOURCE, key),
      source: SOURCE,
      type: "cycle-date",
      category,
      title: cycle ? `${cycle}: ${text}` : text,
      org: "Co-op",
      ...timing,
      url: url || undefined,
      status: "open",
      confidence: "exact",
      review: "auto",
      seenIn: [{ source: SOURCE, key, scope: SCOPE, at: nowIso }],
      meta: {
        workTerm,
        cycle: cycle || undefined,
        facts: factsOf([
          ["Cycle", cycle],
          ["Work term", workTerm],
        ]),
      },
    };
    items.push(item);
  };

  arr(entries).forEach((e, i) => {
    if (!keep(e)) return; // holidays, classes, exams — not co-op items
    const workTerm = coopWorkTerm(e);
    const category = coopCategory(e.text);
    if (category === "interviews") {
      const runKey = `${workTerm}|${e.cycle || "general"}`;
      if (runFirst.get(i) !== runKey) return; // folded into the range item
      const run = /** @type {{min: string, max: string}} */ (runs.get(runKey));
      const [sy, sm, sd] = parseYMD(run.min);
      const [ey, em, ed] = parseYMD(nextDay(run.max));
      push({
        cycle: e.cycle,
        workTerm,
        category,
        text: coopTextWithoutTime(e.text) || "Interviews",
        timing: {
          startAt: zonedIso(sy, sm, sd),
          endAt: zonedIso(ey, em, ed), // exclusive midnight (textdates)
          allDay: true,
        },
      });
      return;
    }
    const [y, m, d] = parseYMD(e.date);
    /** @type {Record<string, unknown>} */
    let timing;
    if (e.endOfDay) {
      timing = { dueAt: zonedIso(y, m, d, 23, 59) };
    } else if (typeof e.time === "string" && e.time) {
      const [h, mi] = parseHHMM(e.time);
      timing = { dueAt: zonedIso(y, m, d, h, mi) };
    } else {
      timing = { startAt: zonedIso(y, m, d), allDay: true };
    }
    push({
      cycle: e.cycle,
      workTerm,
      category,
      text: coopTextWithoutTime(e.text) || e.text,
      timing,
    });
  });
  return items;
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
  return arr(applications).map((app) => {
    if (!app?.jobId) return app;
    return {
      ...app,
      itemIds: arr(items)
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
  const detailById = new Map(arr(detailItems).map((item) => [item.id, item]));
  const merged = arr(listItems).map((item) => {
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
      // Concatenate de-duplicated lines — list lines first, then the detail's
      // (interviewer, instructions) so neither side loses information.
      details: mergeDetails(item.details, detail.details),
      meta: {
        ...detail.meta,
        ...item.meta,
        prep: { ...listPrep, ...detailPrep },
        // The detail knows more; its facts win on a shared label.
        facts: mergeFacts(detail.meta?.facts, item.meta?.facts),
      },
      seenIn: dedupeSeenIn(item.seenIn, detail.seenIn),
    };
  });
  return [...merged, ...detailById.values()];
}

/**
 * Merge two same-id items from different scopes (dashboard schedule vs
 * interviews list, etc): `later` wins field by field, `earlier` fills
 * whatever `later` lacks — a schedule item's endAt survives a list item
 * that arrives after it. meta.facts is the union by label with `later`'s
 * values winning shared labels.
 * @param {Item} earlier
 * @param {Item} later
 * @returns {Item}
 */
export function mergeItemById(earlier, later) {
  const merged = {
    ...earlier,
    ...later,
    title: later.title ?? earlier.title,
    org: later.org ?? earlier.org,
    startAt: later.startAt ?? earlier.startAt,
    endAt: later.endAt ?? earlier.endAt,
    dueAt: later.dueAt ?? earlier.dueAt,
    location: later.location ?? earlier.location,
    status: later.status ?? earlier.status,
    details: mergeDetails(later.details, earlier.details),
    seenIn: dedupeSeenIn(later.seenIn, earlier.seenIn),
  };
  const meta = { ...earlier?.meta, ...later?.meta };
  const facts = mergeFacts(later?.meta?.facts, earlier?.meta?.facts);
  if (facts) meta.facts = facts;
  const earlierPrep = /** @type {Record<string, unknown>} */ (earlier?.meta?.prep) || {};
  const laterPrep = /** @type {Record<string, unknown>} */ (later?.meta?.prep) || {};
  const prep = { ...earlierPrep, ...laterPrep };
  if (Object.keys(prep).length) meta.prep = prep;
  if (Object.keys(meta).length) merged.meta = meta;
  return merged;
}

/**
 * @param {string|undefined} a  list-side details
 * @param {string|undefined} b  detail-side details
 */
/** Facts union: `a` entries first; same-label (case-insensitive) `b` dropped. */
function mergeFacts(a, b) {
  const out = [];
  const seen = new Set();
  for (const f of [...arr(a), ...arr(b)]) {
    const key = String(f?.label || "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out.length ? out : undefined;
}

function mergeDetails(a, b) {
  const lines = [];
  for (const line of `${a || ""}\n${b || ""}`.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !lines.includes(trimmed)) lines.push(trimmed);
  }
  return lines.length ? lines.join("\n") : undefined;
}

function dedupeSeenIn(...lists) {
  const seen = new Set();
  const out = [];
  for (const entry of lists.flatMap(arr).filter(Boolean)) {
    const key = `${entry.source}:${entry.scope || ""}:${entry.key}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out.length ? out : undefined;
}
