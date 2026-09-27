// @ts-check
/*
  Mail rules: what counts as an invite, which senders/subjects qualify for a
  Review item, and which keyword decides the item type. Pure — no fetch, no
  chrome, no Date of its own (timestamps come in as arguments).
*/

import { normCourseCode } from "../../core/contract.js";

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
];

const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");

/** @param {string[]|string|undefined} extra settings.keywords */
export function keywordRe(extra) {
  const list =
    typeof extra === "string" ? extra.split(",") : Array.isArray(extra) ? extra : [];
  const words = [...KEYWORDS, ...list.map((w) => String(w).trim())].filter(Boolean).map(esc);
  return new RegExp(`\\b(?:${words.join("|")})\\b`, "i");
}

/** Item type from the keyword inside the hit's sentence. @type {[RegExp, string][]} */
export const TYPE_RULES = [
  [/interview/i, "interview"],
  [/offer/i, "offer-deadline"],
  [/rank(ing)?/i, "cycle-date"],
  [/\b(rsvp|register|registration|sign\s*up|apply)\b[^.!?\n]{0,25}\b(by|before|deadline)\b/i, "deadline"],
  [/mid-?terms?|exams?/i, "exam"],
  [/meetings?|design reviews?|tapeout/i, "meeting"],
  [/due|deadlines?|extensions?/i, "deadline"],
];

export function mailType(sentence) {
  for (const [re, t] of TYPE_RULES) if (re.test(sentence)) return t;
  return "event";
}

export const DEADLINE_TYPES = new Set(["deadline", "offer-deadline", "cycle-date"]);

const compact = (s) => String(s || "").toUpperCase().replace(/\s+/g, "");
const list = (v) =>
  (typeof v === "string" ? v.split(",") : Array.isArray(v) ? v : [])
    .map((s) => String(s).trim())
    .filter(Boolean);

/** Sender domain minus its TLD, leftmost label — "acme" for acme.example.com. */
export function employerOf(email) {
  const domain = String(email || "").split("@")[1] || "";
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

/**
 * The sender gate for Review items: co-op, Learn, a course instructor,
 * a course code in the subject, or a settings team/sender match.
 * @param {any} msg
 * @param {{courses?: any[], settings?: Record<string, any>}} [ctx]
 * @returns {{ok: boolean, course?: string, team?: string, coop?: boolean}}
 */
export function senderGate(msg, { courses = [], settings = {} } = {}) {
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
