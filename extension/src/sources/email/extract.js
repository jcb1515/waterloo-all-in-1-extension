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
  // A non-bulk human sender qualifies on its own. Ungated bulk passes ONLY
  // through the narrow exception below (event noun or confirmation phrase
  // in the same sentence as an explicit calendar date, at most 2 items).
  const ungatedBulk = !gate.ok && isBulk(msg);

  const text = `${subject}\n${body || msg.preview || ""}`;
  const floor = ref.getTime() - DAY_MS;
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
  /** My own mail, invite-producing mail and ungated bulk can't make tasks. */
  const canTask = (r) => !r.m.fromMe && !r.invited && (r.gate.ok || !r.bulk);
  const rev = (r) => (r.gate.ok ? "auto" : "pending");
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
    meta: { reply: { threadKey: key, askedAt: rec.askedAt }, provider, messageUrl: rec.url },
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
    meta: { provider, messageKey: key, messageUrl: rec.url },
    seenIn: seenEntry(rec.id, key),
  });
  /** @param {Msg} m */
  const replyTitle = (m) =>
    `Reply to ${m.from || "the sender"}: ${cleanSubject(m.subject)}`.slice(0, 100);

  /* ---- message views: the ask, then whether an answer came after ---- */
  if (frame.view === "message") {
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
            meta: {
              reply: { threadKey: key, askedAt, fromName: askRow.m.from },
              provider,
              messageUrl: askRow.m.url,
            },
            evidence: { method: "text", snippet: ask.sentence.slice(0, 300), url: askRow.m.url },
            seenIn: seenEntry(rec.id, key),
          }));
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
    frame.view === "list" &&
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
      const dueAt = taskDue(r.m.receivedAt || at);
      const employer = r.gate.employer || employerOf(r.m.fromEmail, r.m.from);
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
        meta: { provider, messageKey: key, messageUrl: r.m.url, fromName: r.m.from },
        ...(trig.sentence
          ? { evidence: { method: "text", snippet: trig.sentence.slice(0, 300), url: r.m.url } }
          : {}),
        seenIn: seenEntry(rec.id, key),
      }));
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
