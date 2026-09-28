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

/** Booking links — kept on the Msg but never treated as invite evidence. */
export const BOOK_LINK =
  /calendly\.com\/|calendar\.app\.google\/|calendar\.google\.com\/calendar\/appointments|outlook\.office\.com\/bookwithme|outlook\.office365\.com\/owa\/calendar\/[^\s"'<>]*bookings|\/bookings\//i;

/** Wording that turns a booking link (or alone) into a book-a-call task. */
export const BOOK_RE =
  /schedule a (call|time|meeting|chat)|book a (time|call|slot|meeting)|pick a time|find a time/i;

/** Co-op "pick your interview slot" wording — a book-a-call task. */
export const SLOT_RE =
  /\bselect(?:ing)? (?:an?|your|the) (?:interview )?(?:time ?)?slots?\b|\bselect(?:ing)? (?:an?|your|the|a) (?:interview )?time\b|\bchoose (?:an?|your|the|a) (?:time ?slots?|slots?|times?)\b|\bsign ?up for (?:an?|your|the|a) (?:interview|slots?|times?)\b/i;

/** Phrases that mean a reply is owed, plus "?"-sentences addressed to "you". */
export const REPLY_RE =
  /\b(please (reply|respond|confirm|let me know)|let me know|get back to me|are you (available|free)|what times? works?|when (are|would) you (be )?(free|available)|rsvp)\b/i;

/** The first matching line ends the new part of a message body (quotes). */
/**
 * Quoted-history boundary: a reply's `On <date> <who> wrote:` header, an
 * Outlook `From: … Sent:` header (one line in list previews, separate lines
 * in bodies), or an `Original Message`/underscore separator. Everything from
 * the match on is somebody else's old text — never date-worthy. `On … wrote:`
 * requires a weekday/month/digit after "On" so prose can't trip it.
 */
export const QUOTE_CUT_RE =
  /\bOn (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d)[^\n]{0,200}?\bwrote:|\bFrom:[^\n]{0,200}?\bSent:|^From:[^\n]{0,200}\r?\n\s*Sent:|^-{2,}\s*Original Message\s*-{2,}\s*$|^_{4,}\s*$/im;

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
  "invite",
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

/* ---- event vocabulary -------------------------------------------------
 * Noun groups that turn a dated sentence into an `event` item; the matched
 * group becomes the item's category. "meeting"/"call"/"interview" stay
 * their own types (TYPE_RULES order decides). */

/** @type {[string, RegExp][]} */
export const EVENT_GROUPS = [
  [
    "hack",
    /\bhackathons?\b|\bhack ?nights?\b|\bcode ?jams?\b|\bgame ?jams?\b|\bdatathons?\b|\bideathons?\b|\bmakeathons?\b|\bdesignathons?\b|\bbuildathons?\b/i,
  ],
  [
    "social",
    /\bnetworking\b|\bmixers?\b|\bmeet ?ups?\b|\bmeet ?and ?greets?\b|\bsocials?\b|\bcoffee chats?\b|\bhappy hours?\b|\breceptions?\b|\bgalas?\b|\bbanquets?\b|\blunch ?and ?learns?\b|\bgame nights?\b|\btrivia\b|\bkaraoke\b|\bmovie nights?\b|\bwatch parties\b|\bpicnics?\b|\bdinners?\b|\blunches?\b|\bbrunch(?:es)?\b|\bbreakfasts?\b/i,
  ],
  [
    "career",
    /\bcareer fairs?\b|\bjob fairs?\b|\bemployer events?\b|\brecruit(?:ing|ment) events?\b|\binfo(?:rmation)? sessions?\b|\bopen houses?\b|\bcompany visits?\b|\bsite visits?\b|\boffice tours?\b|\brecruitment\b|\bappointments?\b|\bconsultations?\b/i,
  ],
  [
    "learning",
    /\bworkshops?\b|\bbootcamps?\b|\btraining sessions?\b|\btrainings?\b|\bcertifications?\b|\bseminars?\b|\bwebinars?\b|\bspeaker series\b|\bguest speakers?\b|\btalks?\b|\bpanels?\b|\bfireside chats?\b|\bAMAs?\b|\bQ&As?\b|\blecture series\b|\blectures?\b|\boffice hours\b|\bdrop-?ins?\b/i,
  ],
  [
    "conference",
    /\bconferences?\b|\bsummits?\b|\bsymposiums?\b|\bsymposia\b|\bexpos?\b|\bforums?\b|\bconventions?\b/i,
  ],
  [
    "competition",
    /\b(?:case |pitch )?competitions?\b|\bpitch nights?\b|\bdemo days?\b|\bshowcases?\b|\btournaments?\b|\bcontests?\b|\bolympiads?\b/i,
  ],
  [
    "community",
    /\borientations?\b|\bkick ?offs?\b|\blaunch parties\b|\bwelcome events?\b|\btown halls?\b|\bgeneral meetings?\b|\bannual general meetings?\b|\bAGMs?\b|\bclub meetings?\b|\binfo nights?\b|\bvolunteer shifts?\b|\bvolunteer(?:ing)?\b|\bfundraisers?\b|\bceremonies\b|\bconvocations?\b|\bfestivals?\b|\bauditions?\b|\btry ?outs?\b|\bpractices?\b|\brehearsals?\b|\bshifts?\b|\bbookings?\b|\breservations?\b/i,
  ],
];

/** Every event noun in one expression — for the keyword-provenance match. */
export const EVENT_ANY_RE = new RegExp(
  EVENT_GROUPS.map(([, re]) => re.source).join("|"),
  "i",
);

/**
 * The event-noun group a sentence names, or undefined.
 * @param {string} sentence
 */
export function eventNounOf(sentence) {
  const s = String(sentence || "");
  for (const [group, re] of EVENT_GROUPS) if (re.test(s)) return group;
  return undefined;
}

/* ---- confirmations ----------------------------------------------------
 * Registration/RSVP confirmations: evidence on their own, so a dated
 * confirmation from a no-reply sender still yields an event. "application
 * received" is handled separately — it only counts when a dated
 * event/interview is mentioned in the same message. */
export const CONFIRM_RE =
  /\byou(?:'re| are) registered\b|\bregistration confirmed\b|\bthank(?:s| you) for register(?:ing|ation)\b|\byour tickets?\b|\bsee you at\b|\byou(?:'ve| have) RSVP'?d\b|\bRSVP confirmed\b|\bthank(?:s| you) for filling out (?:this|the|our) form\b|\byour spot is confirmed\b/i;
export const APP_RECEIVED_RE = /\bapplication received\b/i;

/* ---- negatives ----------------------------------------------------------
 * Sentences that are never date-worthy on their own: promos, shipping,
 * billing, security codes, social notifications, renewals. A genuine event
 * noun or confirmation phrase in the same sentence overrides the veto
 * ("order your ticket for the hackathon on Nov 7" is still an event). */
export const NEGATIVE_RES = [
  /\b(?:sale|flash sale|discount|coupons?|promo(?:\s*code)?s?|\d{1,2}\s*%\s*off|deals?|last chance|door-?busters?|clearance)\b/i,
  /\b(?:offer|price|pricing|deal|subscription)\b[^.!?\n]{0,25}\b(?:ends?|expires?|expiring)\b/i,
  /\b(?:arriv(?:e|es|ed|ing)|deliver(?:y|ies|ed|ing)|out for delivery|on (?:its|the) way|ships?\b|shipped|shipping|track(?:ing)? (?:your|the|a)|your (?:package|parcel)|packages?|tracking number|order (?:is|has|was) (?:shipped|on its way)|order confirmed)\b/i,
  /\b(?:payments?(?:\s+due)?|invoices?|billing|bills?|receipts?|statements?|balance|amount due|past due|refunds?|charged?|auto-?pay|declined)\b/i,
  /\b(?:security codes?|verification codes?|one-?time (?:codes?|passcodes?|passwords?)|passcodes?|password resets?|reset (?:your|the) password|sign-?in (?:codes?|attempts?|alerts?)|new sign-?in|\botp\b|two-?factor|2fa)\b/i,
  /\b(?:viewed your profile|profile views?|liked your|endorsed you|connection requests?|new followers?|started following|sent you a (?:connection )?request)\b/i,
  /\b(?:subscriptions?|auto-?renew\w*|renew(?:s|al|als|ed|ing)?\b|membership (?:renewal|has|will|expires)|free trials? (?:ends?|expir|renew))\b/i,
];
export const NEGATIVE_RE = new RegExp(NEGATIVE_RES.map((r) => r.source).join("|"), "i");

/**
 * A date hit's matched text carrying an explicit calendar date — a named
 * month + day, an ISO date or an M/D/Y — not a bare weekday or relative
 * word ("Friday", "tomorrow"). Used by the bulk exception.
 * @param {string} text
 */
export const EXPLICIT_DATE_RE =
  /(?:jan|feb|mar|apr|may|june?|july?|aug|sep(?:t)?|oct|nov|dec)[a-z]*\.?\s*\d|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}/i;

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

/**
 * Application/registration window cues: "applications close Nov 1",
 * "RSVP by Friday", "registration deadline", "apply before …". These are
 * evidence on their own (a dated window needs no keyword), so the same
 * expressions drive both the deadline type and the evidence gate.
 */
export const DEADLINE_CUE_RES = [
  /\b(?:rsvp|regist(?:er|ration|rations)|sign[- ]?ups?|apply|applications?|submissions?|entries|abstracts?|responses?)\b[^.!?\n]{0,30}\b(?:by|before|deadline|due|clos(?:e|es|ing)|ends?)\b/i,
  /\b(?:clos(?:e|es|ing)|deadline|due)\b[^.!?\n]{0,25}\b(?:rsvp|regist(?:er|ration)|applications?|submissions?|entries|abstracts?)\b/i,
];
export const DEADLINE_CUE_RE = new RegExp(
  DEADLINE_CUE_RES.map((r) => r.source).join("|"),
  "i",
);

/** Item type from the keyword inside the hit's sentence. @type {[RegExp, string, string?][]} */
export const TYPE_RULES = [
  [/interview|phone screen|\bscreen(ing)?\b|hirevue|onsite/i, "interview"],
  [/offer/i, "offer-deadline"],
  [/rank(ing)?/i, "cycle-date"],
  ...DEADLINE_CUE_RES.map((re) => /** @type {[RegExp, string]} */ ([re, "deadline"])),
  [/online assessment|coding challenge|\bassessment\b/i, "deadline", "assessment"],
  [/\bOA\b/, "deadline", "assessment"], // capital-OA only, case-sensitive
  [/mid-?terms?|exams?/i, "exam"],
  // Event nouns get their group as the item category — they outrank the
  // generic meeting rule so "club meeting"/"coffee chat" classify right.
  ...EVENT_GROUPS.map(([group, re]) => /** @type {[RegExp, string, string]} */ ([re, "event", group])),
  [/\bmeet(ing|ings)?\b|\bcalls?\b|\bphone\b|\bchat\b|coffee|\bsync\b|catch up|zoom|teams meeting|google meet|design reviews?|tapeout|availab|\b(?:re)?schedul|\binvite[sd]?\b|\binvitations?\b/i, "meeting"],
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
  if (
    /^(no-?reply|do-?not-?reply|notifications?|newsletters?|alerts?|account|security|support|mailer|daemon|postmaster|bounce|system|service|digest|updates?)\b/i
      .test(local)
  ) return true;
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
 *   employer?: string, jobId?: string, blocked?: boolean}}
 */
export function senderGate(msg, { courses = [], settings = {}, applications } = {}) {
  const email = String(msg.fromEmail || "").toLowerCase();
  const domain = email.split("@")[1] || "";
  const subject = String(msg.subject || "");
  const fromLine = `${msg.from || ""} ${email}`.toLowerCase();

  // A block entry wins over every other rule — no items, no tasks.
  if (senderBlocked(email, settings)) return { ok: false, blocked: true };

  if (isCoopSender(msg)) {
    return {
      ok: true,
      coop: true,
      employer: String(msg.from || "").trim() || undefined,
    };
  }
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
  // allowSenders (exact address or domain incl. subdomains) plus the legacy
  // `senders` substrings.
  if (senderListed(msg, settings)) return { ok: true };
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

/* ---- sender lists -----------------------------------------------------
 * settings.allowSenders / settings.blockSenders: each entry is an address
 * ("a@b.example.com" — exact match) or a domain ("acme.com" or "@acme.com" —
 * matches that domain and its subdomains). Block wins over allow. Legacy
 * `senders` substrings keep working as allow entries. */

/**
 * Does one allow/block entry match this address?
 * @param {string} entry @param {string} email
 */
export function senderEntryMatch(entry, email) {
  const e = String(entry || "").trim().toLowerCase();
  const addr = String(email || "").toLowerCase();
  if (!e || !addr) return false;
  const domain = addr.split("@")[1] || "";
  if (e.includes("@") && !e.startsWith("@")) return addr === e;
  const d = e.startsWith("@") ? e.slice(1) : e;
  return domain === d || domain.endsWith(`.${d}`);
}

/** Legacy `senders` are substring matches on name+address (gate only). @param {any} settings */
export function senderBlocked(email, settings) {
  const s = settings || {};
  return list(s.blockSenders).some((e) => senderEntryMatch(e, email));
}

/** allowSenders (entry match) or legacy `senders` (substring match). @param {any} msg @param {any} settings */
export function senderListed(msg, settings) {
  const s = settings || {};
  const email = String(msg.fromEmail || "").toLowerCase();
  if (list(s.allowSenders).some((e) => senderEntryMatch(e, email))) return true;
  const fromLine = `${msg.from || ""} ${email}`.toLowerCase();
  return list(s.senders).some((e) => fromLine.includes(e.toLowerCase()));
}

/* ---- the backfill body gate --------------------------------------------
 * Which list rows deserve a body fetch. Uses ONLY what the content script
 * knows (settings + the row itself): never courses/applications. */

/** Applicant-tracking / employer-ish senders (their mail often schedules). */
export const ATS_RE =
  /(?:^|[@.])(?:greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|workday\.com|smartrecruiters\.com|icims\.com|jobvite\.com|taleo\.net|bamboohr\.com|hirevue\.com|successfactors\.(?:com|eu)|waterlooworks\.uwaterloo\.ca|uwaterloo\.ca)$/i;

/** A course-code-looking token, e.g. "ECE105" / "MATH 115". */
export const COURSE_CODE_RE = /\b[A-Z]{2,5}\s?\d{3}[A-Z]?\b/;

/** The whole "this mail wants something" cue set, for subject+preview. */
export function bodyCueRe(extra) {
  const kw = keywordRe(extra);
  return new RegExp(
    [
      kw.source,
      OA_KW.source,
      EVENT_ANY_RE.source,
      DEADLINE_CUE_RE.source,
      CONFIRM_RE.source,
      REPLY_RE.source,
      BOOK_RE.source,
      SLOT_RE.source,
      GCAL_INVITE_RE.source,
      WHEN_LINE.source,
      "pleased to offer|offer of employment|offer letter|extend an offer",
      "forms\\.office\\.com|docs\\.google\\.com\\/forms|forms\\.gle|qualtrics\\.com|calendly\\.com",
      "please (?:submit|upload|sign|complete and return)",
      "tuition|payment due|amount due",
    ].join("|"),
    "im",
  );
}

/**
 * Should this list row's body be fetched? Blocked senders never; then any
 * gated reason: allow-listed, co-op/Learn/uwaterloo.ca, a known
 * ATS/employer-ish domain, a course code in the subject, or a
 * trigger/keyword/booking/form/offer/fee cue in subject+preview. With the
 * onlyCourseCoop preset only course/co-op/Learn/allow-listed senders count.
 * Bulk senders without a gated reason never get bodies.
 * @param {any} msg  list-row Msg ({fromEmail, from, subject, preview, key})
 * @param {{settings?: Record<string, any>, kwRe?: RegExp}} [opts]
 */
export function needsBody(msg, { settings = {}, kwRe } = {}) {
  if (!msg || !msg.key) return false;
  const email = String(msg.fromEmail || "").toLowerCase();
  if (senderBlocked(email, settings)) return false;
  const listed = senderListed(msg, settings);
  const coop = isCoopSender(msg);
  const learn = /learn|d2l/i.test(email);
  const uw = /@(?:[a-z0-9-]+\.)*uwaterloo\.ca$/i.test(email);
  const subjectHasCode = COURSE_CODE_RE.test(String(msg.subject || ""));
  if (settings.onlyCourseCoop) {
    return listed || coop || learn || uw || subjectHasCode;
  }
  if (listed || coop || learn || uw) return true;
  if (ATS_RE.test(email)) return true;
  if (subjectHasCode) return true;
  const text = `${msg.subject || ""}\n${msg.preview || ""}`;
  return (kwRe || bodyCueRe(settings.keywords)).test(text);
}

