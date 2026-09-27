// @ts-check
/*
  Normalised Msg -> contract Items. Two paths: calendar/meeting invites become
  exact items; senders/subjects that pass the gates produce tentative Review
  items from keyword sentences. Pure: dates come from opts.textDates.
*/

import { classify, factsOf, sentenceOf } from "../learn/classify.js";
import { slug } from "../outline/expand.js";
import { extractDates, zonedIso, zonedParts } from "../../lib/textdates/index.js";
import {
  cleanSubject,
  DEADLINE_TYPES,
  EASTERN_TZ,
  employerOf,
  GCAL_INVITE_RE,
  isBulk,
  isCoopSender,
  keywordOf,
  keywordRe,
  mailType,
  MEET_LINK,
  normCardWhen,
  senderGate,
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
    if (hit) {
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
  const gate = senderGate(msg, { courses, settings, applications });
  // A non-bulk human sender qualifies on its own; bulk mail needs the gate.
  if (!gate.ok && isBulk(msg)) return [];

  const text = `${subject}\n${body || msg.preview || ""}`;
  const floor = ref.getTime() - DAY_MS;
  /** @type {{h: any, sentence: string, kw: string}[]} */
  const good = [];
  const days = new Set();
  const hits = td(text, { now: ref, termCode })
    .filter((h) => h.confidence >= 0.6)
    .sort((a, b) => b.confidence - a.confidence);
  for (const h of hits) {
    if (good.length >= MAX_HITS) break;
    if (Date.parse(h.endAt || h.startAt) < floor) continue;
    const sentence = sentenceOf(text, h.index, h.text.length);
    const kw = keywordOf(sentence, kwRe);
    if (!kw) continue;
    const day = torontoDay(h.startAt);
    if (days.has(day)) continue;
    days.add(day);
    good.push({ h, sentence, kw });
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
    let itemTitle = title;
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
