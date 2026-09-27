// @ts-check
/*
  Normalised Msg -> contract Items. Two paths: calendar/meeting invites become
  exact items; senders/subjects that pass the gates produce tentative Review
  items from keyword sentences. Pure: dates come from opts.textDates.
*/

import { factsOf, sentenceOf } from "../learn/classify.js";
import { extractDates, zonedIso, zonedParts } from "../../lib/textdates/index.js";
import {
  cleanSubject,
  DEADLINE_TYPES,
  EASTERN_TZ,
  employerOf,
  GCAL_INVITE_RE,
  isCoopSender,
  keywordRe,
  mailType,
  MEET_LINK,
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
 *   at?: string}} opts
 * @returns {Item[]}
 */
export function itemsFromMessage(msg, { provider = "gmail", now, termCode, textDates, courses = [], settings = {}, at } = {}) {
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
  const g = subject.match(GCAL_INVITE_RE);
  /** @type {{title?: string, whenText?: string, tz?: string, hit?: any}|null} */
  let invite = null;
  if (g) {
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
      const interview =
        /interview/i.test(subject) || /interview/i.test(body.slice(0, 1000)) || isCoopSender(msg);
      const id = `${provider}:invite:${msg.key}:${hit.startAt}`;
      /** @type {Item} */
      const item = {
        id,
        source: provider,
        type: interview ? "interview" : "meeting",
        title: (invite.title || cleanSubject(subject)).slice(0, 100),
        startAt: hit.startAt,
        endAt: hit.endAt || undefined,
        location: link || whereText,
        status: cancelled ? "cancelled" : "open",
        confidence: eastern ? "exact" : "tentative",
        review: eastern ? "auto" : "pending",
        meta: {
          provider,
          messageKey: msg.key,
          ...(eastern ? {} : { tz: invite.tz }),
          facts: factsOf([
            ["Organizer", msg.from],
            ["Where", whereText],
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
  const gate = senderGate(msg, { courses, settings });
  const subjectKw = subject.match(kwRe);
  if (!gate.ok && !subjectKw) return [];

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
    const km = sentence.match(kwRe);
    if (!km) continue;
    const day = torontoDay(h.startAt);
    if (days.has(day)) continue;
    days.add(day);
    good.push({ h, sentence, kw: km[0] });
  }
  if (!good.length) return [];

  const coop = gate.coop || isCoopSender(msg);
  const employer = employerOf(msg.fromEmail);
  const title = cleanSubject(subject);
  /** @type {Item[]} */
  const items = [];
  for (const { h, sentence, kw } of good) {
    const type = mailType(sentence);
    const isDeadline = DEADLINE_TYPES.has(type);
    const iso = isDeadline ? (h.allDay ? dueEndOfDay(h.startAt) : h.startAt) : h.startAt;
    const id = `${provider}:mail:${msg.key}:${iso}`;
    const org = gate.course || gate.team || (coop || type === "interview" ? employer : undefined);
    /** @type {Item} */
    const item = {
      id,
      source: provider,
      type: /** @type {Item["type"]} */ (type),
      title,
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
        employer: coop || type === "interview" ? employer : undefined,
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
