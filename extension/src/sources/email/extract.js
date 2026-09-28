// @ts-check
/*
  Normalised Msg -> contract Items. Two paths: calendar/meeting invites become
  exact items; senders/subjects that pass the gates produce tentative Review
  items from keyword sentences. Pure: dates come from opts.textDates.
*/

import { classify, factsOf, sentenceOf } from "../learn/classify.js";
import { slug } from "../outline/expand.js";
import { extractDates, zonedIso, zonedParts } from "../../lib/textdates/index.js";
import { hashString } from "../../capture/redact.js";
import {
  APP_RECEIVED_RE,
  ATS_RE,
  BOOK_LINK,
  BOOK_RE,
  cleanSubject,
  CONFIRM_RE,
  DEADLINE_TYPES,
  EASTERN_TZ,
  employerOf,
  EVENT_ANY_RE,
  DEADLINE_CUE_RE,
  EXPLICIT_DATE_RE,
  GCAL_INVITE_RE,
  isBulk,
  isCoopSender,
  keywordOf,
  keywordRe,
  mailType,
  MEET_LINK,
  NEGATIVE_RE,
  normCardWhen,
  QUOTE_CUT_RE,
  REPLY_RE,
  senderGate,
  SLOT_RE,
  WHEN_LINE,
  WHERE_LINE,
} from "./rules.js";

/** @typedef {import("../../core/contract.js").Item} Item */
/** @typedef {import("./dom.js").Msg} Msg */

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_HITS = 3;

const dueEndOfDay = (iso) => {
  const p = zonedParts(new Date(iso));
  return zonedIso(p.y, p.m, p.d, 23, 59);
};
const torontoDay = (iso) => {
  const p = zonedParts(new Date(iso));
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
};

/* ---- mail-item titles -------------------------------------------------- */

const GENERIC_TITLE_RE =
  /^\s*(?:re:|fwd?:|fw:|reminder|hi|hello|hey|update|notification|ping)\s*[.!:-]*$/i;

/** A subject too thin to name an item: empty, a stub, or <3 words w/o a noun. */
const genericTitle = (title) => {
  const s = String(title || "").trim();
  if (!s || GENERIC_TITLE_RE.test(s)) return true;
  if (s.split(/\s+/).filter(Boolean).length < 3 && !EVENT_ANY_RE.test(s)) return true;
  return false;
};

/** The dated sentence as a title — lead-ins dropped, capped like a subject. */
const titleFromSentence = (sentence) => {
  const t = String(sentence || "")
    .replace(/\s+/g, " ")
    .replace(/^(?:please|re:|fwd?:|fw:|hi|hello|hey)[\s,:-]*/i, "")
    .replace(/[.\s]+$/, "")
    .trim();
  if (!t) return "Email";
  return (t.charAt(0).toUpperCase() + t.slice(1)).slice(0, 100);
};

/* ---- same-output dedupe -------------------------------------------------- */

const MERGE_WINDOW_MS = 15 * 60 * 1000;

const TITLE_STOP = new Set([
  "the", "and", "for", "with", "your", "you", "this", "that", "from", "have",
  "has", "are", "was", "will", "our", "please", "join", "update", "reminder",
  "hello", "team", "all", "any", "see", "re", "fw", "fwd", "dont", "can",
]);
const MONTH_WD = new Set([
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december", "monday", "tuesday",
  "wednesday", "thursday", "friday", "saturday", "sunday", "jan", "feb",
  "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun",
]);

/** Capitalised 4+ letter words that can actually name something. */
const distinctiveTokens = (t) => {
  const out = new Set();
  for (const w of String(t || "").match(/[A-Za-z]{4,}/g) || []) {
    const l = w.toLowerCase();
    if (/^[A-Z]/.test(w) && !TITLE_STOP.has(l) && !MONTH_WD.has(l)) out.add(l);
  }
  return out;
};

const titleWords = (t) =>
  new Set(
    (String(t || "").toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => !TITLE_STOP.has(w)),
  );

/** Shared distinctive token, or Jaccard word similarity ≥ 0.6. */
const titlesMatch = (a, b) => {
  const da = distinctiveTokens(a);
  const db = distinctiveTokens(b);
  for (const w of da) if (db.has(w)) return true;
  const wa = titleWords(a);
  const wb = titleWords(b);
  if (!wa.size || !wb.size) return false;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter) >= 0.6;
};

const itemInstant = (i) => i.startAt || i.dueAt || "";
const isMailItem = (i) => /:mail:/.test(String(i.id));
const isInviteItem = (i) => /:invite:/.test(String(i.id));

/** Less-generic wins, then the longer (more complete) title. */
const titleScore = (t) => (genericTitle(t) ? 0 : 1) * 10000 + String(t || "").length;

/**
 * Within one adapter output, collapse near-duplicate mail items:
 * - a tentative `:mail:` item within ±15 min of an exact `:invite:` item is
 *   the same meeting seen twice — the invite wins;
 * - tentative `:mail:` items of the same type whose starts/dues sit within
 *   ±15 min and whose titles share a distinctive token or are ≥0.6 similar
 *   are the same thing from two threads — the better title survives and both
 *   threads' urls are kept in meta.threads.
 * @param {Item[]} items
 * @returns {Item[]}
 */
export function dedupeMailItems(items) {
  const invites = items.filter((i) => isInviteItem(i) && i.confidence === "exact");
  /** @type {Item[]} */
  const kept = [];
  for (const it of items) {
    if (!isMailItem(it)) {
      kept.push(it);
      continue;
    }
    const when = itemInstant(it);
    if (
      when &&
      invites.some(
        (iv) =>
          iv.startAt && Math.abs(Date.parse(iv.startAt) - Date.parse(when)) <= MERGE_WINDOW_MS,
      )
    ) {
      continue; // exact invite already covers this mail item
    }
    const dup = kept.find(
      (k) =>
        isMailItem(k) &&
        k.type === it.type &&
        itemInstant(k) &&
        when &&
        Math.abs(Date.parse(itemInstant(k)) - Date.parse(when)) <= MERGE_WINDOW_MS &&
        titlesMatch(String(k.title), String(it.title)),
    );
    if (!dup) {
      kept.push(it);
      continue;
    }
    const threads = new Set([
      .../** @type {any[]} */ ((dup.meta && dup.meta.threads) || []),
      .../** @type {any[]} */ ((it.meta && it.meta.threads) || []),
      dup.evidence && dup.evidence.url,
      it.evidence && it.evidence.url,
    ].filter(Boolean));
    const winner = titleScore(it.title) > titleScore(dup.title) ? it : dup;
    winner.meta = { ...(winner.meta || {}), threads: [...threads] };
    if (winner === it) kept[kept.indexOf(dup)] = it;
  }
  return kept;
}

/**
 * @param {Msg} msg
 * @param {{provider?: "gmail"|"outlook", now?: Date, termCode?: number,
 *   textDates?: any, courses?: any[], settings?: Record<string, any>,
 *   applications?: any, at?: string}} opts
 * @returns {Item[]}
 */
export function itemsFromMessage(msg, { provider = "gmail", now, termCode, textDates, courses = [], settings = {}, applications, at } = {}) {
  const td = textDates || extractDates;
  const ref = msg.receivedAt ? new Date(msg.receivedAt) : now || new Date();
  const when = ref.toISOString();
  const subject = String(msg.subject || "");
  const body = String(msg.body || "");
  const scope = `email:${provider}:${msg.key}`;
  const seen = (id) => [
    { source: provider, key: id.replace(new RegExp(`^${provider}:`), ""), scope, at: at || when },
  ];
  const link = (msg.links || []).find((l) => MEET_LINK.test(l));
  const where = body.match(WHERE_LINE);
  const whereText = where ? where[1].trim() : undefined;

  // Sender filters run before anything is produced: a blocked sender is
  // fully silent; under the course/co-op preset only gated senders count.
  const gate = senderGate(msg, { courses, settings, applications });
  if (gate.blocked || (settings.onlyCourseCoop && !gate.ok)) return [];

  /* ---- 1. invites -> exact items ---- */
  // An invite card the client rendered above the message wins over the
  // Google-Calendar subject, the "When:" line and the link+timed fallback.
  const card = msg.invite;
  const g = subject.match(GCAL_INVITE_RE);
  /** @type {{title?: string, whenText?: string, tz?: string, where?: string, organizer?: string, hit?: any}|null} */
  let invite = null;
  if (card && card.whenText) {
    invite = {
      title: card.title,
      whenText: normCardWhen(card.whenText),
      where: card.where,
      organizer: card.organizer,
    };
  } else if (g) {
    invite = { title: g[2], whenText: g[3], tz: g[4] };
  } else {
    const w = body.match(WHEN_LINE);
    if (w) {
      invite = { whenText: w[1] };
    } else if (link) {
      const timed = td(`${subject}\n${body.slice(0, 500)}`, { now: ref, termCode }).find(
        (h) => !h.allDay,
      );
      if (timed) invite = { hit: timed };
    }
  }
  if (invite) {
    const hit =
      invite.hit ||
      td(invite.whenText, { now: ref, termCode }).find((h) => !h.allDay);
    // An invite for a meeting that already ended is dropped like any other
    // stale date — the floor is the observation time, not receivedAt.
    if (hit && !(Date.parse(hit.endAt || hit.startAt) < (now || new Date()).getTime())) {
      const eastern = !invite.tz || EASTERN_TZ.test(invite.tz);
      const cancelled = /^(canceled|cancelled)\b/i.test(subject);
      const coopSender = isCoopSender(msg);
      const interview =
        /interview/i.test(subject) || /interview/i.test(body.slice(0, 1000)) || coopSender;
      const title = (invite.title || cleanSubject(subject)).slice(0, 100);
      // Same meeting seen through many mails (Invitation, update, reminder,
      // forward, Canceled event) collapses to one id; a cancellation lands as
      // status "cancelled" and the publisher drops it.
      const id = `${provider}:invite:${slug(title)}:${hit.startAt}`;
      const employer = interview || coopSender ? employerOf(msg.fromEmail, msg.from) : undefined;
      // Gmail invitations already appear on the user's Google Calendar —
      // publishing them again would duplicate the event (opt back in with
      // settings.gmailInvitesToFeed).
      const onCalendar =
        provider === "gmail" && settings.gmailInvitesToFeed !== true ? "google" : undefined;
      /** @type {Item} */
      const item = {
        id,
        source: provider,
        type: interview ? "interview" : "meeting",
        title,
        startAt: hit.startAt,
        endAt: hit.endAt || undefined,
        location: link || invite.where || whereText,
        status: cancelled ? "cancelled" : "open",
        confidence: eastern ? "exact" : "tentative",
        review: eastern ? "auto" : "pending",
        meta: {
          provider,
          messageKey: msg.key,
          ...(eastern ? {} : { tz: invite.tz }),
          ...(employer ? { employer } : {}),
          ...(onCalendar ? { onCalendar } : {}),
          facts: factsOf([
            ["Organizer", invite.organizer || msg.from],
            ["Where", invite.where || whereText],
            ["Join", link],
          ]),
        },
        seenIn: seen(id),
        evidence: { method: "text", snippet: (invite.title || cleanSubject(subject)).slice(0, 300), url: msg.url },
      };
      return [item];
    }
  }

  /* ---- 2. important mail -> Review items ---- */
  const kwRe = keywordRe(settings.keywords);
  // A non-bulk human sender qualifies on its own. Ungated bulk passes ONLY
  // through the narrow exception below (event noun or confirmation phrase
  // in the same sentence as an explicit calendar date, at most 2 items).
  const ungatedBulk = !gate.ok && isBulk(msg);

  // Quoted history ("On … wrote:", "From: … Sent:") is never date-worthy —
  // previews carry it inline, bodies carry it as header lines.
  const text = `${subject}\n${unquoted(body || msg.preview || "")}`;
  // Anything that already ended is dropped against the observation time —
  // an old message's own receivedAt must not rescue a stale date.
  const floor = (now || ref).getTime();
  const hitCap = ungatedBulk ? 2 : MAX_HITS;
  // "Application received" only counts as a confirmation when the message
  // actually names a dated event or interview.
  const appReceivedCounts =
    APP_RECEIVED_RE.test(text) &&
    /interview|event|workshop|session|fair|expo|summit|orientation|meeting/i.test(text);
  /** @type {{h: any, sentence: string, kw: string}[]} */
  const good = [];
  const days = new Set();
  const hits = td(text, { now: ref, termCode })
    .filter((h) => h.confidence >= 0.6)
    .sort((a, b) => b.confidence - a.confidence);
  for (const h of hits) {
    if (good.length >= hitCap) break;
    if (Date.parse(h.endAt || h.startAt) < floor) continue;
    const sentence = sentenceOf(text, h.index, h.text.length);
    const nounM = sentence.match(EVENT_ANY_RE);
    const cueM = sentence.match(DEADLINE_CUE_RE);
    const confirm = CONFIRM_RE.test(sentence) || (appReceivedCounts && APP_RECEIVED_RE.test(sentence));
    // Promo/shipping/billing/security/renewal sentences never produce an
    // item — unless a real event signal shares the sentence.
    if (NEGATIVE_RE.test(sentence) && !nounM && !confirm) continue;
    /** @type {string|undefined} */
    let kw;
    if (ungatedBulk) {
      // Bulk exception: noun, confirmation or deadline cue, and THIS hit
      // must be an explicit calendar date (no bare weekday or "tomorrow").
      if (!nounM && !confirm && !cueM) continue;
      if (!EXPLICIT_DATE_RE.test(h.text)) continue;
      kw = (nounM && nounM[0]) || (cueM && cueM[0]) || "confirmation";
    } else {
      kw =
        keywordOf(sentence, kwRe) ||
        (nounM && nounM[0]) ||
        (cueM && cueM[0]) ||
        (confirm ? "confirmation" : undefined);
      if (!kw) continue;
    }
    const day = torontoDay(h.startAt);
    if (days.has(day)) continue;
    days.add(day);
    good.push({ h, sentence, kw: /** @type {string} */ (kw) });
  }
  if (!good.length) return [];

  const coop = gate.coop || isCoopSender(msg);
  const employer = employerOf(msg.fromEmail, msg.from);
  const title = cleanSubject(subject);
  /** @type {Item[]} */
  const items = [];
  for (const { h, sentence, kw } of good) {
    const rule = mailType(sentence);
    // A meeting from a co-op/employer sender, or about an interview/screen,
    // is an interview.
    const type =
      rule.type === "meeting" && (gate.coop || /interview|screen/i.test(subject))
        ? "interview"
        : rule.type;
    const isDeadline = DEADLINE_TYPES.has(type);
    const iso = isDeadline ? (h.allDay ? dueEndOfDay(h.startAt) : h.startAt) : h.startAt;
    const id = `${provider}:mail:${msg.key}:${iso}`;
    const emp = gate.employer || (coop || type === "interview" ? employer : undefined);
    const org = gate.course || gate.team || emp;
    // Exam mail uses the titles outline/Portal emit ("Midterm"/"Final exam")
    // so the same exam merges into one calendar event; the subject stays in
    // details. Other types keep the cleaned subject as the title.
    /** @type {string|undefined} */
    let details;
    // Mail items title by the cleaned subject; a generic one ("Reminder",
    // "Hi", near-empty) falls back to the dated sentence itself.
    let itemTitle = genericTitle(title) ? titleFromSentence(sentence) : title;
    if (type === "exam") {
      const c = classify({ title: sentence });
      const cat = c.type === "exam" ? c.category : classify({ title: subject }).category;
      itemTitle = cat === "midterm" ? "Midterm" : cat === "final" ? "Final exam" : title;
      details = `Email: ${title}`;
    }
    /** @type {Item} */
    const item = {
      id,
      source: provider,
      type: /** @type {Item["type"]} */ (type),
      category: rule.category,
      title: itemTitle,
      details,
      org,
      status: "open",
      confidence: "tentative",
      review: "pending",
      seenIn: seen(id),
      evidence: { method: "text", snippet: sentence.slice(0, 300), url: msg.url },
      meta: {
        provider,
        messageKey: msg.key,
        messageUrl: msg.url,
        fromName: msg.from,
        employer: emp,
        ...(gate.jobId ? { jobId: gate.jobId } : {}),
        keyword: kw,
        facts: factsOf([["From", msg.from]]),
      },
    };
    if (isDeadline) {
      item.dueAt = iso;
      if (h.allDay) item.allDay = true;
    } else {
      item.startAt = h.startAt;
      if (h.endAt) item.endAt = h.endAt;
      if (h.allDay) item.allDay = true;
    }
    items.push(item);
  }
  return items;
}

/* ------------------------------------------------------------------ *
 *  Reply-needed and book-a-call tasks                                  *
 * ------------------------------------------------------------------ */

/** Folders that hold the user's own outgoing mail. */
export const SENT_FOLDERS = new Set(["sent", "sentitems", "sent items"]);

const REPLIES_CAP = 300;
const BOOKINGS_CAP = 200;

/** Default task due: two days after `iso`, at 17:00 Toronto. */
const taskDue = (iso) => {
  const p = zonedParts(new Date(iso));
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d + 2));
  return zonedIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 17, 0);
};

/** Body minus quoted history: the first "On … wrote:" etc. line ends it. */
const unquoted = (t) => {
  const s = String(t || "");
  const m = QUOTE_CUT_RE.exec(s);
  return (m ? s.slice(0, m.index) : s).trim();
};

const sentencesOf = (t) =>
  (String(t).match(/[^.!?\n]+[.!?]*/g) || []).map((s) => s.trim()).filter(Boolean);

/* ---- derived to-do vocabulary -----------------------------------------
 * The shared seam: every to-do a message produces is a task (or a deadline
 * when the message states a hard due) with meta.action naming what it asks. */

/** Offer wording from a co-op/employer sender. */
const OFFER_RE =
  /\bpleased to offer\b|\boffer of employment\b|\boffer letter\b|\bextend (?:an|you an) offer\b/i;
/** "accept … offer by <date>" — an offer ask with a stated due. */
const OFFER_ACCEPT_RE = /\baccept\b[^.!?\n]{0,40}\boffer\b[^.!?\n]{0,25}\bby\b/i;
/** Form/survey/booking-form hosts a link can point at. */
const FORM_LINK_RE =
  /forms\.office\.com|docs\.google\.com\/forms|forms\.gle|qualtrics\.com|calendly\.com/i;
const CALENDLY_RE = /calendly\.com/i;
/** The ask that makes a form link a to-do ("please fill out", "register"…). */
const FORM_ASK_RE =
  /\b(?:fill (?:out|in)|complete (?:the |this |our |a )?(?:form|survey|questionnaire)|submit (?:the |this |your |a )?(?:form|response|survey)|regist(?:er|ration)|rsvp|sign ?up|let us know|confirm your (?:spot|attendance|participation))\b/i;
/** Sentences about registering/attending turn a form task into an RSVP. */
const RSVP_WORD_RE =
  /\b(?:rsvp|regist(?:er|ration)|sign ?up|attend(?:ing)?|save your spot|reserve your (?:spot|seat))\b/i;
/** "please submit / upload / sign / complete and return" + a document noun. */
const DOC_ASK_RE = /\bplease (?:submit|upload|sign|complete and return|return)\b/i;
const DOC_NOUN_RE =
  /\b(?:form|document|transcript|r[eé]sum[eé]s?|\bcv\b|contract|waiver|agreement|timesheet|paperwork|certificate)\b/i;
/** Fees/tuition/payment-due wording — Waterloo senders only. */
const FEE_RE =
  /\b(?:tuition|fees?|amount due|payment due|balance due|invoices?|statement of account|account balance|pay your)\b/i;
/** Receipts are never to-dos. */
const RECEIPT_RE =
  /\b(?:payment (?:received|processed|confirmed|successful)|receipt|order (?:confirmed|shipped|number)|refund (?:issued|processed)|paid in full)\b/i;
/** Ranking windows ("rank your matches by …") from co-op senders. */
const RANK_RE = /\brank(?:ing|ings)?\b/i;
const DUE_CUE_RE = /\b(?:by|before|no later than|deadline|due|clos(?:e|es|ing))\b/i;
/** "apply by …", "applications close …", "submit your application". */
const APPLY_ASK_RE =
  /\bapply\b[^.!?\n]{0,30}\b(?:by|before|no later than|deadline)\b|\bapplications?\b[^.!?\n]{0,25}\b(?:due|clos(?:e|es|ing)|deadline)\b|\bsubmit (?:your |an |the )?application\b/i;
const UW_DOMAIN_RE = /@(?:[a-z0-9-]+\.)*uwaterloo\.ca$/i;

/**
 * A hard due inside one sentence: a textdates hit preceded by
 * "by"/"before"/"no later than". Returns the due ISO or undefined.
 * @param {string} sentence @param {{now: Date, termCode?: number, td: any}} o
 */
function statedDue(sentence, { now: ref, termCode, td }) {
  for (const h of td(sentence, { now: ref, termCode })) {
    const pre = sentence.slice(0, h.index).trimEnd();
    if (/\b(?:by|before|no later than)\s*$/i.test(pre)) {
      return h.allDay ? dueEndOfDay(h.startAt) : h.startAt;
    }
  }
  return undefined;
}

/**
 * The ask in a message: the first sentence that begs a reply, plus an
 * explicit "by <date>" deadline inside it if present.
 * @param {Msg} m
 * @param {{now: Date, termCode?: number, td: any}} o
 * @returns {{sentence: string, dueAt?: string}|null}
 */
function askOf(m, { now, termCode, td }) {
  const ref = m.receivedAt ? new Date(m.receivedAt) : now;
  const text = unquoted(`${m.subject || ""}\n${m.body || m.preview || ""}`);
  for (const s of sentencesOf(text)) {
    if (!REPLY_RE.test(s) && !(s.endsWith("?") && /\byou(r)?\b/i.test(s))) continue;
    /** @type {string|undefined} */
    let dueAt;
    for (const h of td(s, { now: ref, termCode })) {
      if (/\bby\s*$/i.test(s.slice(0, h.index))) {
        dueAt = h.allDay ? dueEndOfDay(h.startAt) : h.startAt;
        break;
      }
    }
    return { sentence: s, dueAt };
  }
  return null;
}

/** A booking link or "book a time"-style wording -> a book-a-call trigger. */
function bookingOf(m) {
  const link = (m.links || []).find((l) => BOOK_LINK.test(l));
  const text = unquoted(`${m.subject || ""}\n${m.body || m.preview || ""}`);
  const sentences = sentencesOf(text);
  const slot = sentences.find((s) => SLOT_RE.test(s));
  const sentence = slot || sentences.find((s) => BOOK_RE.test(s));
  if (!link && !sentence) return null;
  return { link, sentence, slot: !!slot };
}

/**
 * Reply-needed and book-a-call tasks for one observe pass, and the state
 * that tracks them. `prod` pairs each Msg with the items it produced this
 * pass (so a message that yielded an invite can't spawn tasks). Task
 * creation runs only on `frame.allowed` views; completion — a later from-me
 * message, a sent-folder row, an all-mine thread, or an invite from the
 * requester — runs on every pass.
 * @param {{m: Msg, items: Item[]}[]} prod
 * @param {{view: string, folder: string|null, allowed: boolean}} frame
 * @param {any} prev   previous adapter state ({replies, bookings})
 * @param {{provider: string, now: Date, termCode?: number, textDates?: any,
 *   courses?: any[], settings?: Record<string, any>, applications?: any,
 *   at: string}} opts
 * @returns {{items: Item[], replies: Record<string, any>, bookings: Record<string, any>}}
 */
export function taskItems(prod, frame, prev, opts) {
  const { provider, now, termCode, courses = [], settings = {}, applications, at } = opts;
  const td = opts.textDates || extractDates;
  const replies = { ...((prev && prev.replies) || {}) };
  const bookings = { ...((prev && prev.bookings) || {}) };
  /** @type {Item[]} */
  const items = [];

  // Invites produced this pass mark a thread (or a sender) as scheduled.
  const inviteKey = new Set();
  const inviteSender = new Set();
  const rows = prod.map((p) => {
    const invited = p.items.some((i) => String(i.id).startsWith(`${provider}:invite:`));
    if (invited) {
      inviteKey.add(String(p.m.key));
      if (p.m.fromEmail) inviteSender.add(hashString(String(p.m.fromEmail).toLowerCase()));
    }
    return {
      m: p.m,
      invited,
      gate: senderGate(p.m, { courses, settings, applications }),
      bulk: isBulk(p.m),
    };
  });
  /** My own mail, invite-producing mail, blocked senders, preset-excluded
   * senders and ungated bulk can't make tasks. */
  const canTask = (r) =>
    !r.m.fromMe &&
    !r.invited &&
    !r.gate.blocked &&
    !(settings.onlyCourseCoop && !r.gate.ok) &&
    (r.gate.ok || !r.bulk);
  const rev = (r) => (r.gate.ok ? "auto" : "pending");
  /** Derived to-dos minted this pass: message key -> action set (cap 2). */
  const minted = new Map();
  /** @param {string} key */
  const mintedSet = (key) => {
    let s = minted.get(key);
    if (!s) minted.set(key, (s = new Set()));
    return s;
  };
  const seenEntry = (id, key) => [
    {
      source: provider,
      key: id.replace(new RegExp(`^${provider}:`), ""),
      scope: `email:${provider}:${key}`,
      at,
    },
  ];
  /** @param {string} key @param {any} rec */
  const replyDoneItem = (key, rec) => /** @type {Item} */ ({
    id: rec.id,
    source: /** @type {Item["source"]} */ (provider),
    type: "task",
    category: "reply",
    title: rec.title,
    dueAt: rec.dueAt,
    url: rec.url,
    status: "done",
    review: rec.review,
    confidence: "tentative",
    meta: {
      action: "reply",
      reply: { threadKey: key, askedAt: rec.askedAt },
      provider,
      messageUrl: rec.url,
      ...(rec.undated ? { undated: true } : {}),
    },
    seenIn: seenEntry(rec.id, key),
  });
  /** @param {string} key @param {any} rec */
  const bookDoneItem = (key, rec) => /** @type {Item} */ ({
    id: rec.id,
    source: /** @type {Item["source"]} */ (provider),
    type: "task",
    category: "book-call",
    title: rec.title,
    dueAt: rec.dueAt,
    url: rec.url,
    status: "done",
    review: rec.review,
    confidence: "tentative",
    meta: {
      action: rec.action || "other",
      provider,
      messageKey: key,
      messageUrl: rec.url,
      ...(rec.undated ? { undated: true } : {}),
      ...(rec.employer ? { employer: rec.employer } : {}),
    },
    seenIn: seenEntry(rec.id, key),
  });
  /** @param {Msg} m */
  const replyTitle = (m) =>
    `Reply to ${m.from || "the sender"}: ${cleanSubject(m.subject)}`.slice(0, 100);

  /* ---- thread views: the ask, then whether an answer came after ----
   * Backfill threads carry per-message `parts`, expanded into rows by the
   * adapter, so a multi-part backfill thread behaves like a message view. */
  if (frame.view === "message" || frame.view === "backfill") {
    /** @type {Map<string, {m: Msg, invited: boolean, gate: any, bulk: boolean}[]>} */
    const groups = new Map();
    for (const r of rows) {
      const k = String(r.m.key);
      const g = groups.get(k) || [];
      g.push(r);
      groups.set(k, g);
    }
    for (const [key, rs] of groups) {
      // The latest eligible triggering message is the ask.
      /** @type {number} */
      let askI = -1;
      /** @type {any} */
      let askRow;
      /** @type {{sentence: string, dueAt?: string}|null} */
      let ask = null;
      for (let i = 0; i < rs.length; i++) {
        const r = rs[i];
        if (!canTask(r)) continue;
        const a = askOf(r.m, { now, termCode, td });
        if (a) {
          askI = i;
          askRow = r;
          ask = a;
        }
      }
      if (ask && askRow) {
        const askedAt = askRow.m.receivedAt || at;
        const dueAt = ask.dueAt || taskDue(askedAt);
        // A from-me message after the ask (by receivedAt when both have one,
        // else by DOM order) completes the reply.
        /** @type {string|undefined} */
        let doneAt;
        for (let j = askI + 1; j < rs.length; j++) {
          const rj = rs[j];
          if (!rj.m.fromMe) continue;
          if (
            rj.m.receivedAt && askRow.m.receivedAt &&
            !(Date.parse(rj.m.receivedAt) > Date.parse(askRow.m.receivedAt))
          ) continue;
          doneAt = rj.m.receivedAt || at;
          break;
        }
        const prevRec = replies[key];
        if (doneAt && (frame.allowed || prevRec)) {
          replies[key] = prevRec
            ? { ...prevRec, status: "done", doneAt }
            : {
                id: `${provider}:reply:${key}`,
                title: replyTitle(askRow.m),
                dueAt,
                askedAt,
                review: rev(askRow),
                url: askRow.m.url,
                status: "done",
                doneAt,
                undated: !ask.dueAt || undefined,
              };
          items.push(replyDoneItem(key, replies[key]));
        } else if (
          prevRec && prevRec.status === "done" && prevRec.doneAt &&
          !(Date.parse(askedAt) > Date.parse(prevRec.doneAt))
        ) {
          // Already answered — an unseen from-me message must not reopen it.
          items.push(replyDoneItem(key, prevRec));
        } else if (frame.allowed) {
          const rec = {
            id: `${provider}:reply:${key}`,
            title: replyTitle(askRow.m),
            dueAt,
            askedAt,
            review: rev(askRow),
            url: askRow.m.url,
            status: "open",
            undated: !ask.dueAt || undefined,
          };
          replies[key] = rec;
          items.push(/** @type {Item} */ ({
            id: rec.id,
            source: /** @type {Item["source"]} */ (provider),
            type: "task",
            category: "reply",
            title: rec.title,
            dueAt,
            url: askRow.m.url,
            status: "open",
            review: rec.review,
            confidence: "tentative",
            org: askRow.gate.course || undefined,
            meta: {
              action: "reply",
              reply: { threadKey: key, askedAt, fromName: askRow.m.from },
              provider,
              messageUrl: askRow.m.url,
              ...(askRow.gate.employer ? { employer: askRow.gate.employer } : {}),
              ...(rec.undated ? { undated: true } : {}),
            },
            evidence: { method: "text", snippet: ask.sentence.slice(0, 300), url: askRow.m.url },
            seenIn: seenEntry(rec.id, key),
          }));
          mintedSet(key).add("reply");
        }
      } else if (rs.length && rs.every((r) => r.m.fromMe)) {
        // A thread view that is only my own messages completes a known reply.
        const prevRec = replies[key];
        if (prevRec && prevRec.status === "open") {
          replies[key] = { ...prevRec, status: "done", doneAt: at };
          items.push(replyDoneItem(key, replies[key]));
        }
      }
    }
  }

  /* ---- a sent-folder row closes its reply (and nothing else) ---- */
  if (
    (frame.view === "list" || frame.view === "backfill") &&
    SENT_FOLDERS.has(String(frame.folder || "").toLowerCase())
  ) {
    for (const r of rows) {
      const key = String(r.m.key);
      const prevRec = replies[key];
      if (prevRec && prevRec.status === "open") {
        replies[key] = { ...prevRec, status: "done", doneAt: at };
        items.push(replyDoneItem(key, replies[key]));
      }
    }
  }

  /* ---- book-a-call: wording or a booking link on an eligible message ---- */
  if (frame.allowed) {
    for (const r of rows) {
      if (!canTask(r)) continue;
      const trig = bookingOf(r.m);
      if (!trig) continue;
      const key = String(r.m.key);
      const existing = bookings[key];
      if (existing && existing.status === "done") continue; // never reopen
      const bookRef = r.m.receivedAt ? new Date(r.m.receivedAt) : now;
      const bookDue = trig.sentence
        ? statedDue(trig.sentence, { now: bookRef, termCode, td })
        : undefined;
      const dueAt = bookDue || taskDue(r.m.receivedAt || at);
      const employer = r.gate.employer || employerOf(r.m.fromEmail, r.m.from);
      // Interview-flavoured bookings (co-op/employer senders, slot wording,
      // interview vocabulary) are "book-interview"; any other booking link
      // is a generic "other" to-do.
      const email = String(r.m.fromEmail || "").toLowerCase();
      const interviewish =
        trig.slot ||
        r.gate.coop ||
        r.gate.employer ||
        isCoopSender(r.m) ||
        ATS_RE.test(email) ||
        /\binterviews?|screens?|hirevue\b/i.test(
          `${r.m.subject || ""}\n${trig.sentence || ""}`,
        );
      const action = interviewish ? "book-interview" : "other";
      const rec = {
        id: `${provider}:book:${key}`,
        title: trig.slot
          ? `Select interview time slot${employer ? ` — ${employer}` : ""}`
          : `Book a call with ${r.m.from || "the sender"}`,
        dueAt,
        url: trig.link || r.m.url,
        senderHash: hashString(String(r.m.fromEmail || "").toLowerCase()),
        review: rev(r),
        status: "open",
        action,
        undated: !bookDue || undefined,
        employer:
          r.gate.coop || r.gate.employer || ATS_RE.test(email)
            ? employer
            : undefined,
      };
      bookings[key] = rec;
      items.push(/** @type {Item} */ ({
        id: rec.id,
        source: /** @type {Item["source"]} */ (provider),
        type: "task",
        category: "book-call",
        title: rec.title,
        url: rec.url,
        dueAt,
        status: "open",
        review: rec.review,
        confidence: "tentative",
        org: r.gate.course || undefined,
        meta: {
          action,
          provider,
          messageKey: key,
          messageUrl: r.m.url,
          fromName: r.m.from,
          ...(rec.undated ? { undated: true } : {}),
          ...(rec.employer ? { employer: rec.employer } : {}),
        },
        ...(trig.sentence
          ? { evidence: { method: "text", snippet: trig.sentence.slice(0, 300), url: r.m.url } }
          : {}),
        seenIn: seenEntry(rec.id, key),
      }));
      mintedSet(key).add("book");
    }
  }

  /* ---- derived to-dos: offer / form / document / pay / rankings / apply ----
   * Stricter than the reply gate: the sender must pass senderGate (or be
   * allow-listed), and bulk/newsletter senders additionally need the strong
   * gate (co-op, Learn or uwaterloo.ca). At most 2 to-dos per message across
   * all actions, counting the reply/book tasks already minted. */
  if (frame.allowed) {
    for (const r of rows) {
      if (!canTask(r)) continue;
      const email = String(r.m.fromEmail || "").toLowerCase();
      const uw = UW_DOMAIN_RE.test(email);
      const learn = /learn|d2l/i.test(email);
      // New detections need the gate — uwaterloo.ca and Learn senders count
      // as gated on their own (fees@, learn@ aren't otherwise gated).
      if (!(r.gate.ok || uw || learn)) continue;
      // Bulk/newsletter senders additionally need the strong gate.
      if (r.bulk && !(r.gate.coop || learn || uw)) continue;
      const key = String(r.m.key);
      const acted = mintedSet(key);
      if (acted.size >= 2) continue;
      const ref = r.m.receivedAt ? new Date(r.m.receivedAt) : now;
      const text = unquoted(`${r.m.subject || ""}\n${r.m.body || r.m.preview || ""}`);
      const sentences = sentencesOf(text);
      const employer = r.gate.employer || employerOf(r.m.fromEmail, r.m.from);
      const employerish = r.gate.coop || r.gate.employer || ATS_RE.test(email);
      const subj = cleanSubject(r.m.subject);
      /** @type {{action: string, title: string, sentence: string, url?: string}[]} */
      const cands = [];

      // An offer from a co-op/employer sender.
      if (employerish) {
        const s = sentences.find((x) => OFFER_RE.test(x) || OFFER_ACCEPT_RE.test(x));
        if (s) {
          cands.push({
            action: "respond-offer",
            title: `Respond to offer — ${employer || r.m.from || "the sender"}`,
            sentence: s,
          });
        }
      }

      // A form link plus an ask. Calendly in interview/employer context
      // stays a book-interview task (the book block handles it).
      const formLink = (r.m.links || []).find((l) => FORM_LINK_RE.test(l));
      const calendlyBook =
        !!formLink &&
        CALENDLY_RE.test(formLink) &&
        (employerish ||
          /\binterviews?|screens?|hirevue\b/i.test(text) ||
          sentences.some((x) => SLOT_RE.test(x)));
      if (formLink && !calendlyBook) {
        const ask = sentences.find((x) => FORM_ASK_RE.test(x));
        if (ask) {
          const rsvp = RSVP_WORD_RE.test(ask) || sentences.some((x) => RSVP_WORD_RE.test(x));
          cands.push({
            action: rsvp ? "rsvp" : "submit-form",
            title: `${rsvp ? "RSVP" : "Submit form"}: ${subj}`,
            sentence: ask,
            url: formLink,
          });
        }
      }

      // "please submit / upload / sign / complete and return" + a document
      // noun, without a form link to do it in.
      if (!formLink) {
        const s = sentences.find((x) => DOC_ASK_RE.test(x));
        if (s && DOC_NOUN_RE.test(text)) {
          cands.push({ action: "submit-document", title: `Submit document: ${subj}`, sentence: s });
        }
      }

      // Fees/tuition — Waterloo accounts only, and never a receipt.
      if (uw && !RECEIPT_RE.test(text)) {
        const s = sentences.find((x) => FEE_RE.test(x));
        if (s) cands.push({ action: "pay", title: `Pay: ${subj}`, sentence: s });
      }

      // Ranking windows from co-op/Waterloo senders.
      if (employerish || uw) {
        const s = sentences.find((x) => RANK_RE.test(x) && DUE_CUE_RE.test(x));
        if (s) {
          cands.push({ action: "submit-rankings", title: `Submit rankings: ${subj}`, sentence: s });
        }
      }

      // Application asks ("apply by …", "submit your application").
      const ap = sentences.find((x) => APPLY_ASK_RE.test(x));
      if (ap) cands.push({ action: "apply", title: `Apply: ${subj}`, sentence: ap });

      // A stated due anywhere in the message supplies the due (the offer is
      // in one sentence, its "accept by <date>" often in the next).
      const anyDue = sentences
        .map((x) => statedDue(x, { now: ref, termCode, td }))
        .find(Boolean);
      for (const c of cands) {
        if (acted.size >= 2) break; // two to-dos per message, ever
        if (acted.has(c.action)) continue;
        acted.add(c.action);
        const due =
          statedDue(c.sentence, { now: ref, termCode, td }) || anyDue;
        const dueAt = due || taskDue(r.m.receivedAt || at);
        const auto = r.gate.coop || r.gate.course || learn || uw;
        const id = `${provider}:task:${c.action}:${key}`;
        items.push(/** @type {Item} */ ({
          id,
          source: /** @type {Item["source"]} */ (provider),
          type: due ? "deadline" : "task",
          category: c.action,
          title: c.title.slice(0, 100),
          dueAt,
          url: c.url || r.m.url,
          status: "open",
          review: auto ? "auto" : "pending",
          confidence: "tentative",
          org: r.gate.course || undefined,
          meta: {
            action: c.action,
            provider,
            messageKey: key,
            messageUrl: r.m.url,
            fromName: r.m.from,
            ...(employerish && employer ? { employer } : {}),
            // The 2-day fallback due is synthetic — an undated to-do is a
            // panel to-do, never a calendar event.
            ...(due ? {} : { undated: true, calendar: false }),
          },
          evidence: { method: "text", snippet: c.sentence.slice(0, 300), url: r.m.url },
          seenIn: seenEntry(id, key),
        }));
      }
    }
  }

  /* ---- an arriving invite answers the book-a-call task ---- */
  for (const [key, b] of Object.entries(bookings)) {
    if (b.status !== "open") continue;
    if (inviteKey.has(key) || (b.senderHash && inviteSender.has(b.senderHash))) {
      bookings[key] = { ...b, status: "done" };
      items.push(bookDoneItem(key, bookings[key]));
    }
  }

  // Caps: newest by askedAt (replies) / dueAt (bookings).
  const rks = Object.keys(replies);
  if (rks.length > REPLIES_CAP) {
    rks.sort((a, b) => String(replies[b].askedAt || "").localeCompare(String(replies[a].askedAt || "")));
    for (const k of rks.slice(REPLIES_CAP)) delete replies[k];
  }
  const bks = Object.keys(bookings);
  if (bks.length > BOOKINGS_CAP) {
    bks.sort((a, b) => String(bookings[b].dueAt || "").localeCompare(String(bookings[a].dueAt || "")));
    for (const k of bks.slice(BOOKINGS_CAP)) delete bookings[k];
  }

  return { items, replies, bookings };
}
