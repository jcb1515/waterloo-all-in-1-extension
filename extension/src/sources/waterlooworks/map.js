// @ts-check
// Parser rows/details -> contract objects (pure; no chrome APIs).

import { itemId } from "../../core/contract.js";
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
 * @typedef {Application & {jobStatus?: string}} WWApplication
 */

const SOURCE = "waterlooworks";
const DAY_MS = 24 * 60 * 60 * 1000;

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
 * @returns {Item[]}
 */
export function interviewDetailItems(detail, now) {
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
 * Dashboard "Upcoming Events / Workshops" rows -> event Items. The day comes
 * from each table's colspan'd header, times from the row's range text.
 * @param {any[]} rows  parseDashboard events rows
 * @param {Date} now
 * @returns {Item[]}
 */
export function dashboardEventItems(rows, now) {
  const nowIso = iso(now);
  const used = new Set();
  const items = [];
  for (const row of arr(rows)) {
    if (!row?.startAt) continue;
    if (!isRegistered(row.registration)) continue;
    /** @type {string} */
    let key = `event:${fnv(`${row.category || ""}|${row.name || ""}|${row.startAt}`)}`;
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
      type: "event",
      title: row.name || "Event",
      org: row.category || undefined,
      startAt: row.startAt,
      endAt: row.endAt || undefined,
      location: row.location || undefined,
      status: cancelled(row.registration) ? "cancelled" : "open",
      confidence: "exact",
      review: "auto",
      seenIn: [{ source: SOURCE, key, scope: SCOPE, at: nowIso }],
      meta: {
        registrationStatus: row.registration,
        facts: factsOf([
          ["Category", row.category],
          ["Registration", row.registration],
          ["Location", row.location],
        ]),
      },
    });
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
 *   category?: string, employer?: string, origin?: "list"|"detail"}} msg
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
    items.push(item);
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
  const tm = COOP_TIME_RE.exec(t);
  if (tm) t = t.slice(0, tm.index) + t.slice(tm.index + tm[0].length);
  t = t.replace(COOP_ZONE_RE, " ");
  return t
    .replace(/\s*(?:at|by)\s*$/i, "")
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
