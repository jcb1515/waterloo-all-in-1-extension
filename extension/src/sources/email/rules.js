// @ts-check
/*
  Mail rules: what counts as an invite, which senders/subjects qualify for a
  Review item, and which keyword decides the item type. Pure — no fetch, no
  chrome, no Date of its own (timestamps come in as arguments).
*/

import { normCourseCode } from "../../core/contract.js";
import { titleSimilarity } from "../../core/merge.js";

/**
 * Google Calendar invite subjects:
 *   "Invitation: Robotics design review @ Tue Oct 6, 2026 6pm - 7pm (EDT) (a@b)"
 * Groups: 2 = title, 3 = when text, 4 = optional time zone.
 */
export const GCAL_INVITE_RE =
  /^(Updated invitation|Invitation|Canceled event|Cancelled event)(?: with note)?:\s*(.+?)\s+@\s+(.+?)(?:\s+\(([^()@]+)\))?\s+\([^()]*@[^()]*\)\s*$/;

export const WHEN_LINE = /^\s*When:\s*(.+)$/im;
export const WHERE_LINE = /^\s*(?:Where|Location):\s*(.+)$/im;

/** Absent or Eastern zones parse as exact; anything else is tentative. */
export const EASTERN_TZ = /^(E[SD]?T|Eastern|America\/Toronto|GMT-0?[45])/i;

export const MEET_LINK =
  /teams\.microsoft\.com\/l\/meetup-join|zoom\.us\/j\/|meet\.google\.com\/|waterlooworks\.uwaterloo\.ca/i;

/* ---- invite cards (the RSVP card the client renders above a message) ---- */

/**
 * A card date line, one of:
 *   "Tue, Sep 29 · 1:00 PM – 1:30 PM"
 *   "Tue 9/29/2026 1:00 PM - 1:30 PM"
 *   "2026-09-29 13:00"
 */
export const CARD_WHEN_RE = new RegExp(
  [
    "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\\s+[A-Z][a-z]{2,8}\\.?\\s+\\d{1,2}(?:,\\s*\\d{4})?\\s*[·•|,-]?\\s*\\d{1,2}(?::\\d{2})?\\s*[AP]M",
    "(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\\s+)?\\d{1,2}\\/\\d{1,2}\\/\\d{4}\\s+\\d{1,2}:\\d{2}\\s*[AP]M",
    "\\d{4}-\\d{2}-\\d{2}\\s+\\d{1,2}:\\d{2}",
  ].join("|"),
  "i",
);

/** Response buttons / RSVP cues that mark an element as an invite card. */
export const CARD_CUE_RE =
  /^(Yes|No|Maybe|RSVP|Propose a new time|Add note|Accept|Decline|Tentative)$/i;

/** "<name> - Organizer" — both the detection line and the name capture. */
export const CARD_ORG_RE = /^(.+?)\s*[-–]\s*Organizer$/i;

/** Card chrome that is neither the title nor the location. */
export const CARD_UI_RE =
  /^(Directions|Open in Google Maps?|Add to calendar|More details|Join (now|with Google Meet)|Going\??|View on Google Maps)$/i;

/** Conflict notices describe OTHER events — parsing stops at these lines. */
export const CARD_STOP_RE =
  /^(On your (Google )?Calendar|Conflict with|Based on this email)/i;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Card when-text for textdates: `·`, `•` and `|` are separators, `M/D/YYYY`
 * (US order) and `YYYY-MM-DD` become "Month D, YYYY".
 * @param {string} s
 */
export function normCardWhen(s) {
  let t = String(s || "").replace(/[·•|]/g, " ").replace(/\s+/g, " ").trim();
  t = t.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/, (_m, mo, d, y) =>
    `${MONTH_NAMES[Number(mo) - 1]} ${Number(d)}, ${y}`);
  t = t.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/, (_m, y, mo, d) =>
    `${MONTH_NAMES[Number(mo) - 1]} ${Number(d)}, ${y}`);
  return t;
}

/* ---- guided scan ---------------------------------------------------- */

/** @param {number} days */
export const GMAIL_SCAN_QUERY = (days) =>
  `(filename:ics OR subject:(invitation OR invite OR invited OR meeting OR interview OR rsvp)) newer_than:${days}d`;
export const OUTLOOK_SCAN_QUERY =
  "invitation OR invite OR invited OR meeting OR interview OR rsvp";

/** Words that make a mail date-worthy (word-bounded; multi-word ok). */
export const KEYWORDS = [
  "interview",
  "offer",
  "rank",
  "ranking",
  "deadline",
  "due",
  "extension",
  "midterm",
  "exam",
  "room change",
  "cancelled",
  "canceled",
  "rescheduled",
  "meeting",
  "tapeout",
  "design review",
  "rsvp",
  "invited",
  "invitation",
  "register",
  "registration",
  "event",
  "meet",
  "call",
  "phone",
  "phone screen",
  "chat",
  "coffee chat",
  "sync",
  "catch up",
  "available",
  "availability",
  "schedule",
  "reschedule",
  "office hours",
  "info session",
  "workshop",
  "assessment",
  "coding challenge",
  "online assessment",
  "hirevue",
  "onsite",
  "zoom",
  "teams meeting",
  "google meet",
  "calendly",
  "book",
  "confirm",
  "reminder",
  "action required",
];

const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");

/** @param {string[]|string|undefined} extra settings.keywords */
export function keywordRe(extra) {
  const list =
    typeof extra === "string" ? extra.split(",") : Array.isArray(extra) ? extra : [];
  const words = [...KEYWORDS, ...list.map((w) => String(w).trim())].filter(Boolean).map(esc);
  return new RegExp(`\\b(?:${words.join("|")})\\b`, "i");
}

/** "OA" only ever counts capitalised — too many lowercase collisions. */
export const OA_KW = /\bOA\b/;

/**
 * Keyword match for a date's sentence: the insensitive word list, or a
 * case-sensitive capital "OA".
 * @param {string} sentence @param {RegExp} kwRe
 */
export function keywordOf(sentence, kwRe) {
  const m = String(sentence || "").match(kwRe) || String(sentence || "").match(OA_KW);
  return m ? m[0] : undefined;
}

/** Item type from the keyword inside the hit's sentence. @type {[RegExp, string, string?][]} */
export const TYPE_RULES = [
  [/interview|phone screen|\bscreen(ing)?\b|hirevue|onsite/i, "interview"],
  [/offer/i, "offer-deadline"],
  [/rank(ing)?/i, "cycle-date"],
  [/\b(rsvp|register|registration|sign\s*up|apply)\b[^.!?\n]{0,25}\b(by|before|deadline)\b/i, "deadline"],
  [/online assessment|coding challenge|\bassessment\b/i, "deadline", "assessment"],
  [/\bOA\b/, "deadline", "assessment"], // capital-OA only, case-sensitive
  [/mid-?terms?|exams?/i, "exam"],
  [/\bmeet(ing|ings)?\b|\bcalls?\b|\bphone\b|\bchat\b|coffee|\bsync\b|catch up|zoom|teams meeting|google meet|design reviews?|tapeout|availab|\b(?:re)?schedul/i, "meeting"],
  [/office hours|info session|workshop/i, "event"],
  [/due|deadlines?|extensions?/i, "deadline"],
];

/**
 * @param {string} sentence
 * @returns {{type: string, category?: string}}
 */
export function mailType(sentence) {
  for (const [re, t, cat] of TYPE_RULES) if (re.test(sentence)) return { type: t, category: cat };
  return { type: "event" };
}

/** Bulk sender mail: no-reply-style local parts or list-footer boilerplate. */
export function isBulk(msg) {
  const local = String(msg.fromEmail || "").split("@")[0] || "";
  if (/^(no-?reply|do-?not-?reply|notifications?|newsletters?)\b/i.test(local)) return true;
  return /unsubscribe|view (it |this (email |message )?)?in (your )?browser|manage (your )?(email |subscription )?preferences/i
    .test(String(msg.body || ""));
}

export const DEADLINE_TYPES = new Set(["deadline", "offer-deadline", "cycle-date"]);

const compact = (s) => String(s || "").toUpperCase().replace(/\s+/g, "");
const list = (v) =>
  (typeof v === "string" ? v.split(",") : Array.isArray(v) ? v : [])
    .map((s) => String(s).trim())
    .filter(Boolean);

/** Mailboxes that can't be employers — use the sender's display name. */
const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "yahoo.com", "yahoo.ca", "icloud.com", "me.com", "proton.me", "protonmail.com",
]);

/**
 * Employer-ish label for a sender: first domain label ("acme" for
 * acme.example.com), or — on a personal domain — the cleaned display name
 * (quotes and a trailing " via …" removed), never "gmail".
 * @param {string} email @param {string} [fromName]
 */
export function employerOf(email, fromName) {
  const domain = String(email || "").split("@")[1] || "";
  if (PERSONAL_DOMAINS.has(domain.toLowerCase())) {
    const name = String(fromName || "")
      .replace(/^["']+|["']+$/g, "")
      .replace(/\s+via\s+.*$/i, "")
      .trim();
    return name || undefined;
  }
  const labels = domain.split(".").filter(Boolean);
  return labels.length ? labels[0] : undefined;
}

/** True for WaterlooWorks or uwaterloo.co co-op-flavoured senders. */
export function isCoopSender(msg) {
  const email = String(msg.fromEmail || "").toLowerCase();
  const domain = email.split("@")[1] || "";
  if (domain.includes("waterlooworks")) return true;
  return /uwaterloo\.ca$/.test(domain) && /co-?op|waterlooworks|ccd|career/i.test(`${msg.from} ${msg.subject}`);
}

/** ctx.applications may be an array or an id-keyed map. @param {any} v */
const appList = (v) =>
  Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : [];

/**
 * The sender gate for Review items: co-op, Learn, a course instructor,
 * a course code in the subject, a settings team/sender match, or an
 * employer match against ctx.applications (WaterlooWorks).
 * @param {any} msg
 * @param {{courses?: any[], settings?: Record<string, any>, applications?: any}} [ctx]
 * @returns {{ok: boolean, course?: string, team?: string, coop?: boolean,
 *   employer?: string, jobId?: string}}
 */
export function senderGate(msg, { courses = [], settings = {}, applications } = {}) {
  const email = String(msg.fromEmail || "").toLowerCase();
  const domain = email.split("@")[1] || "";
  const subject = String(msg.subject || "");
  const fromLine = `${msg.from || ""} ${email}`.toLowerCase();

  if (isCoopSender(msg)) return { ok: true, coop: true };
  if (/learn|d2l/i.test(email)) return { ok: true };

  for (const c of courses) {
    for (const i of (c && c.instructors) || []) {
      if (i && i.email && String(i.email).toLowerCase() === email) {
        return { ok: true, course: c.code };
      }
    }
  }
  const subj = compact(subject);
  for (const c of courses) {
    if (c && c.code && subj.includes(compact(c.code))) {
      return { ok: true, course: normCourseCode(c.code) };
    }
  }
  for (const t of list(settings.teams)) {
    if (fromLine.includes(t.toLowerCase())) return { ok: true, team: t };
  }
  for (const s of list(settings.senders)) {
    if (fromLine.includes(s.toLowerCase())) return { ok: true };
  }
  // An application employer: fuzzy on the display name or the domain label,
  // or a literal domain-label token inside the employer name.
  const domainLabel = (domain.split(".")[0] || "").toLowerCase();
  for (const app of appList(applications)) {
    const emp = String((app && app.employer) || "");
    if (!emp) continue;
    const tokens = emp.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (
      titleSimilarity(emp, null, String(msg.from || ""), null) >= 0.6 ||
      titleSimilarity(emp, null, domainLabel, null) >= 0.6 ||
      (domainLabel.length >= 4 && tokens.includes(domainLabel))
    ) {
      return {
        ok: true,
        coop: true,
        employer: emp,
        jobId: app.jobId == null ? undefined : String(app.jobId),
      };
    }
  }
  return { ok: false };
}

/** Strip repeatable RE:/FW:/Fwd:/Updated:/Invitation: prefixes off a subject. */
export function cleanSubject(subject) {
  let s = String(subject || "").trim();
  for (;;) {
    const next = s.replace(/^\s*(re|fw|fwd|updated|invitation)\s*:\s*/i, "").trim();
    if (next === s) break;
    s = next;
  }
  return s.slice(0, 100);
}
