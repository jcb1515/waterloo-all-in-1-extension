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
