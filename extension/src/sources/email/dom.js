// @ts-check
/*
  Pure DOM readers for mail.google.com and outlook.* — produce a normalised
  Msg list for the adapter. Every selector is a best guess (see selectors.js
  and README "needs tuning"); a miss just yields fewer messages. No fetch,
  no chrome, no storage.
*/

import { extractDates, weekdayOf, zonedIso, zonedParts } from "../../lib/textdates/index.js";
import { ACCOUNT, CARD, GMAIL, OUTLOOK, QUOTE_SEL } from "./selectors.js";
import {
  BOOK_LINK,
  CARD_CUE_RE,
  CARD_ORG_RE,
  CARD_STOP_RE,
  CARD_UI_RE,
  CARD_WHEN_RE,
} from "./rules.js";

/**
 * @typedef {Object} Msg
 * @property {string} key
 * @property {string} url
 * @property {string} from
 * @property {string} fromEmail
 * @property {string} subject
 * @property {string} [preview]
 * @property {string} [receivedText]
 * @property {string} [receivedAt]   ISO, Toronto-parsed
 * @property {string} [body]         message view only, <=20000 chars
 * @property {string[]} links        meeting/co-op links found in the body
 * @property {boolean} [fromMe]      sender is the signed-in account
 * @property {{whenText: string, title?: string, where?: string, organizer?: string}} [invite]
 *   the invite card the client renders above the message (first Msg only)
 */

const BODY_CAP = 20000;
const PREVIEW_CAP = 200;

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;

const textOf = (el) => String((el && el.textContent) || "").replace(/\s+/g, " ").trim();

/**
 * Element text with line structure preserved: <br> and block boundaries
 * become "\n", inline whitespace collapses to one space. (Same walk as
 * sources/discord/dom.js's textWithBreaks.) `skip` subtrees (a selector —
 * the quoted-history containers) are dropped entirely.
 * @param {any} el @param {string} [skip]
 */
export function textWithBreaks(el, skip) {
  let out = "";
  const walk = (node) => {
    for (const child of (node && node.childNodes) || []) {
      if (child.nodeType === 3 /* TEXT_NODE */) {
        out += child.nodeValue || "";
      } else if (
        skip && child.nodeType === 1 && child.matches && child.matches(skip)
      ) {
        continue; // quoted history — not new content
      } else if (String(child.nodeName || "").toUpperCase() === "BR") {
        out += "\n";
      } else {
        const before = out.length;
        walk(child);
        if (
          out.length > before &&
          /^(DIV|P|LI|H[1-6]|SECTION|ARTICLE|TR|PRE|BLOCKQUOTE|BUTTON)$/.test(
            String(child.nodeName || "").toUpperCase(),
          ) &&
          !out.endsWith("\n")
        ) {
          out += "\n";
        }
      }
    }
  };
  walk(el);
  return out
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n+ */g, "\n")
    .trim();
}

const MEET_LINK =
  /teams\.microsoft\.com\/l\/meetup-join|zoom\.us\/j\/|meet\.google\.com\/|waterlooworks\.uwaterloo\.ca/i;
const GOOGLE_REDIRECT = /^https?:\/\/www\.google\.com\/url\?/i;

/** Meeting/co-op hrefs under el, Google redirect wrappers unwrapped. */
export function linksOf(el) {
  /** @type {string[]} */
  const out = [];
  for (const a of (el && el.querySelectorAll("a[href]")) || []) {
    let href = String(a.getAttribute("href") || "");
    if (GOOGLE_REDIRECT.test(href)) {
      try {
        href = new URL(href).searchParams.get("q") || href;
      } catch {
        /* keep the wrapped url */
      }
    }
    if ((MEET_LINK.test(href) || BOOK_LINK.test(href)) && !out.includes(href)) out.push(href);
  }
  return out;
}

const LABEL_MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const LABEL_WD = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const toHour = (h, mer) => (h % 12) + (/p/i.test(String(mer || "")) ? 12 : 0);

/**
 * The short "received" labels mail lists show, resolved to Toronto wall time
 * against `now`: "3:14 PM" (today), "Fri" / "Fri 4:34 PM" (the most recent
 * such weekday, today only when its time is still ahead), "Sep 25" (this
 * year, else last), "9/25/26" (M/D/Y, YY = 20YY). Anything else falls back to
 * the textdates parse ("Thu, Oct 1, 2026, 3:14 PM"). Returns ISO or undefined.
 * @param {string} text @param {Date|number|string} [now]
 */
export function parseListLabel(text, now = new Date()) {
  const s = String(text || "").trim();
  const d = now instanceof Date ? now : new Date(now || Date.now());
  if (Number.isNaN(d.getTime())) return undefined;
  const p = zonedParts(d);
  /** @type {RegExpExecArray|null} */ let m;
  // "3:14 PM" — today at that time.
  if ((m = /^(\d{1,2}):(\d{2})\s*([AP])M$/i.exec(s))) {
    return zonedIso(p.y, p.m, p.d, toHour(Number(m[1]), m[3]), Number(m[2]));
  }
  // "Fri" / "Fri 4:34 PM" — most recent such weekday.
  if ((m = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\.?(\s+(\d{1,2}):(\d{2})\s*([AP])M)?$/i.exec(s))) {
    const wd = LABEL_WD[m[1].slice(0, 3).toLowerCase()];
    const hh = m[3] ? toHour(Number(m[3]), m[5]) : 0;
    const mi = m[4] ? Number(m[4]) : 0;
    let back = (weekdayOf(p.y, p.m, p.d) - wd + 7) % 7;
    if (back === 0 && hh * 60 + mi > p.h * 60 + p.mi) back = 7;
    const day = new Date(Date.UTC(p.y, p.m - 1, p.d - back));
    return zonedIso(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mi);
  }
  // "Sep 25" — this year, or last year when it hasn't happened yet.
  if ((m = /^([A-Z][a-z]{2,8})\.?\s+(\d{1,2})$/.exec(s))) {
    const name = m[1].toLowerCase();
    const mo = LABEL_MONTHS.findIndex((n) => n.startsWith(name));
    if (mo >= 0) {
      const dd = Number(m[2]);
      const y = mo + 1 > p.m || (mo + 1 === p.m && dd > p.d) ? p.y - 1 : p.y;
      return zonedIso(y, mo + 1, dd, 0, 0);
    }
  }
  // "9/25/26" — US M/D/Y, two-digit year is 20YY.
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s))) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return zonedIso(y, Number(m[1]), Number(m[2]), 0, 0);
  }
  return undefined;
}

/** Parse a human date/time label ("Thu, Oct 1, 2026, 3:14 PM") Toronto-side. */
function parseReceived(text, now) {
  const short = parseListLabel(text, now);
  if (short) return short;
  try {
    const hits = extractDates(String(text || ""), { now: now || new Date() });
    const h = hits.find((x) => x.confidence >= 0.5) || hits[0];
    return h ? h.startAt : undefined;
  } catch {
    return undefined;
  }
}

/* --------------------------- invite cards --------------------------- */

// Loose prefilter so textWithBreaks only runs on elements that could hold a
// card date line (class names are obfuscated, so there is nothing else to
// select on).
const CARD_MAYBE =
  /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+[A-Z][a-z]{2,8}|\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2}/i;

const linesOf = (el) =>
  textWithBreaks(el)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * The invite card a client renders above a Teams/Calendar mail: the smallest
 * element inside `[role="main"]` (Gmail falls back to the document) whose
 * lines hold a CARD_WHEN_RE date plus a response cue or "- Organizer" line.
 * Gmail bodies (.a3s) never count — a card is chrome, not message text.
 * Returns {whenText, title?, where?, organizer?} or null.
 * @param {any} doc @param {boolean} gmail
 */
export function inviteCard(doc, gmail) {
  const scope = (doc.querySelector && doc.querySelector(CARD.main)) || (gmail ? doc : null);
  if (!scope) return null;
  /** @type {any} */ let best = null;
  let bestLen = Infinity;
  for (const el of scope.querySelectorAll("*")) {
    if (gmail && el.closest && el.closest(GMAIL.msgBody)) continue;
    const tc = String(el.textContent || "");
    if (!CARD_MAYBE.test(tc)) continue;
    const lines = linesOf(el);
    if (!lines.some((l) => CARD_WHEN_RE.test(l))) continue;
    if (!lines.some((l) => CARD_CUE_RE.test(l) || CARD_ORG_RE.test(l))) continue;
    if (tc.length < bestLen) {
      best = el;
      bestLen = tc.length;
    }
  }
  if (!best) return null;

  // Parse the card's lines in order; conflict notices end the card.
  const lines = [];
  for (const l of linesOf(best)) {
    if (CARD_STOP_RE.test(l)) break;
    lines.push(l);
  }
  const whenText = lines.find((l) => CARD_WHEN_RE.test(l));
  if (!whenText) return null;
  const junk = (l) => CARD_CUE_RE.test(l) || CARD_ORG_RE.test(l) || CARD_UI_RE.test(l);
  const rest = lines.slice(lines.indexOf(whenText) + 1);
  const title = rest.find((l) => !junk(l));
  const where = title ? rest.slice(rest.indexOf(title) + 1).find((l) => !junk(l)) : undefined;
  const orgLine = lines.map((l) => CARD_ORG_RE.exec(l)).find(Boolean);
  /** @type {{whenText: string, title?: string, where?: string, organizer?: string}} */
  const invite = { whenText };
  if (title) invite.title = title;
  if (where) invite.where = where;
  if (orgLine) invite.organizer = orgLine[1].trim();
  return invite;
}

/**
 * @param {any} doc
 * @param {string} href
 * @param {{now?: Date}} [opts]
 * @returns {{v: 1, provider: "gmail"|"outlook", folder: string|null,
 *   view: "list"|"message"|"other", messages: Msg[]}}
 */
export function extractFor(doc, href, { now } = {}) {
  try {
    const host = new URL(href).hostname;
    if (host === "mail.google.com") return gmailExtract(doc, href, now);
    return outlookExtract(doc, href, now);
  } catch {
    return { v: 1, provider: "outlook", folder: null, view: "other", messages: [] };
  }
}

/**
 * The signed-in account's address, from the account button. Compared against
 * sender addresses to flag fromMe — itself it is NEVER serialised into the
 * extract (fromMe messages get `fromEmail: ""`).
 * @param {any} doc
 */
export function accountEmail(doc) {
  try {
    const g = doc.querySelector(ACCOUNT.gmail);
    const gl = g ? String(g.getAttribute("aria-label") || "") : "";
    const gm = /\(([^()\s]+@[^()\s]+)\)\s*$/.exec(gl);
    if (gm) return gm[1].toLowerCase();
    for (const el of doc.querySelectorAll(ACCOUNT.outlook)) {
      const t = String(
        el.getAttribute("data-folder-name") ||
          el.getAttribute("title") ||
          el.getAttribute("aria-label") ||
          el.textContent ||
          "",
      );
      const m = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(t);
      if (m) return m[0].toLowerCase();
    }
  } catch {
    /* no account button */
  }
  return "";
}

/* ------------------------------ Gmail ------------------------------ */

function gmailExtract(doc, href, now) {
  const u = new URL(href);
  const n = (u.pathname.match(/\/u\/(\d+)/) || [])[1] || "0";
  const segs = String(u.hash || "")
    .replace(/^#\/?/, "")
    .split("/")
    .filter(Boolean);
  /** @type {string|null} */
  let folder;
  /** @type {string|undefined} */
  let msgId;
  if (segs[0] === "label") {
    folder = segs[1] || null;
    msgId = segs[2];
  } else if (segs[0] === "search") {
    // #search/<query>[/<id>] — segment 1 is the query, never the id.
    folder = "search";
    msgId = segs[2];
  } else {
    folder = segs[0] || "inbox";
    msgId = segs[1];
  }
  const view = /** @type {"message"|"list"} */ (msgId ? "message" : "list");
  const urlFor = (key) => `https://mail.google.com/mail/u/${n}/#${folder || "inbox"}/${key}`;
  const acct = accountEmail(doc);
  // The user's own mail: name "me" or the account address. fromEmail is
  // blanked so the account address never leaves the page.
  /** @param {string} name @param {string} email */
  const mine = (name, email) =>
    name.trim().toLowerCase() === "me" || (!!acct && email.toLowerCase() === acct);

  /** @type {Msg[]} */
  const messages = [];
  if (view === "message") {
    const subjEl = doc.querySelector(GMAIL.msgSubject);
    const key = (subjEl && subjEl.getAttribute("data-legacy-thread-id")) || msgId;
    const subject = textOf(subjEl);
    for (const m of doc.querySelectorAll(GMAIL.msg)) {
      const senderEl = m.querySelector(GMAIL.msgFrom);
      const dateEl = m.querySelector(GMAIL.msgDate);
      const bodyEl = m.querySelector(GMAIL.msgBody);
      const receivedText = dateEl ? dateEl.getAttribute("title") || textOf(dateEl) : "";
      const from = (senderEl && (senderEl.getAttribute("name") || textOf(senderEl))) || "";
      const fromEmail = (senderEl && senderEl.getAttribute("email")) || "";
      const self = mine(from, fromEmail);
      messages.push({
        key: String(key || ""),
        url: urlFor(key),
        from,
        fromEmail: self ? "" : fromEmail,
        fromMe: self || undefined,
        subject,
        receivedText: receivedText || undefined,
        receivedAt: parseReceived(receivedText, now),
        body: bodyEl ? textWithBreaks(bodyEl, QUOTE_SEL).slice(0, BODY_CAP) : undefined,
        links: linksOf(bodyEl),
      });
    }
    const card = inviteCard(doc, true);
    if (card) {
      if (!messages.length) {
        messages.push({
          key: String(key || ""),
          url: urlFor(key),
          from: "",
          fromEmail: "",
          subject,
          links: linksOf(doc.querySelector(CARD.main) || doc),
        });
      }
      messages[0].invite = card;
    }
  } else {
    for (const tr of doc.querySelectorAll(GMAIL.listRow)) {
      const idEl = tr.getAttribute("data-legacy-thread-id") ? tr : tr.querySelector(GMAIL.threadId);
      const key = idEl && idEl.getAttribute("data-legacy-thread-id");
      if (!key) continue;
      const senderEl = tr.querySelector(GMAIL.sender);
      const dateEl = tr.querySelector(GMAIL.date);
      const receivedText = dateEl ? dateEl.getAttribute("title") || textOf(dateEl) : "";
      const from = (senderEl && (senderEl.getAttribute("name") || textOf(senderEl))) || "";
      const fromEmail = (senderEl && senderEl.getAttribute("email")) || "";
      const self = mine(from, fromEmail);
      messages.push({
        key: String(key),
        url: urlFor(key),
        from,
        fromEmail: self ? "" : fromEmail,
        fromMe: self || undefined,
        subject: textOf(tr.querySelector(GMAIL.subject)),
        preview: textOf(tr.querySelector(GMAIL.preview))
          .replace(/^\s*[-–—]+\s*/, "")
          .slice(0, PREVIEW_CAP) || undefined,
        receivedText: receivedText || undefined,
        receivedAt: parseReceived(receivedText, now),
        links: [],
      });
    }
  }
  return { v: /** @type {1} */ (1), provider: /** @type {"gmail"} */ ("gmail"), folder, view, messages };
}

/* ----------------------------- Outlook ----------------------------- */

const TIME_LINE = /^\d{1,2}:\d{2}\s*[AP]M$|^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b|^\d{4}-\d{2}-\d{2}$/i;

function outlookExtract(doc, href, now) {
  const u = new URL(href);
  const segs = u.pathname.split("/").filter(Boolean);
  let rest = segs.slice(segs.indexOf("mail") + 1);
  if (rest[0] === "0") rest = rest.slice(1); // live.com's account slot
  /** @type {string|null} */
  let folder = "inbox";
  /** @type {string|undefined} */
  let msgId;
  if (rest[0] === "id") {
    msgId = decodeURIComponent(rest[1] || "");
    folder = null;
  } else {
    folder = rest[0] ? decodeURIComponent(rest[0]) : "inbox";
    if (rest[1] === "id") msgId = decodeURIComponent(rest[2] || "");
  }
  const view = /** @type {"message"|"list"} */ (msgId != null && msgId !== "" ? "message" : "list");
  const zero = u.hostname === "outlook.live.com" ? "0/" : "";
  const urlFor = (key) =>
    `https://${u.hostname}/mail/${zero}${folder || "inbox"}/id/${encodeURIComponent(key)}`;
  const acct = accountEmail(doc);
  /** @param {string} email */
  const mine = (email) => !!acct && String(email).toLowerCase() === acct;

  /** @type {Msg[]} */
  const messages = [];
  if (view === "message") {
    const main = doc.querySelector(OUTLOOK.main);
    if (main) {
      const senderEl = main.querySelector(OUTLOOK.sender);
      const dateEl = main.querySelector(OUTLOOK.sentTime);
      const bodyEl = main.querySelector(OUTLOOK.body);
      const sel = doc.querySelector(OUTLOOK.selected);
      const key = (sel && sel.getAttribute("data-convid")) || msgId || "";
      const receivedText = dateEl ? textOf(dateEl) : "";
      let from = textOf(senderEl);
      const titleHit = EMAIL_RE.exec(
        (senderEl && senderEl.getAttribute("title")) || "",
      );
      let fromEmail = titleHit ? titleHit[0] : "";
      if (!fromEmail) {
        // The reading-pane header: "From: <name>" aria-label, and the address
        // inside a descendant's "Name<addr>" text.
        const fromEl = main.querySelector(OUTLOOK.senderFrom);
        if (fromEl) {
          if (!from) {
            from = String(fromEl.getAttribute("aria-label") || "")
              .replace(/^From:\s*/i, "")
              .trim();
          }
          const em = EMAIL_RE.exec(textOf(fromEl));
          fromEmail = em ? em[0] : "";
        }
      }
      const self = mine(fromEmail);
      messages.push({
        key: String(key),
        url: urlFor(key),
        from,
        fromEmail: self ? "" : fromEmail,
        fromMe: self || undefined,
        subject: textOf(main.querySelector(OUTLOOK.heading)),
        receivedText: receivedText || undefined,
        receivedAt: parseReceived(receivedText, now),
        body: bodyEl ? textWithBreaks(bodyEl, QUOTE_SEL).slice(0, BODY_CAP) : undefined,
        links: linksOf(bodyEl),
      });
      const card = inviteCard(doc, false);
      if (card) messages[0].invite = card;
    }
  } else {
    let rows = [...doc.querySelectorAll(OUTLOOK.listRow)];
    if (!rows.length) {
      rows = [...doc.querySelectorAll(OUTLOOK.listRowAny)].filter(
        (r) => !(r.closest && r.closest(OUTLOOK.main)),
      );
    }
    for (const row of rows) {
      const key = row.getAttribute("data-convid");
      if (!key) continue;
      const senderEl = row.querySelector(OUTLOOK.sender);
      const from = textOf(senderEl);
      const fromEmail = (senderEl && senderEl.getAttribute("title")) || "";
      const self = mine(fromEmail);
      const lines = textWithBreaks(row)
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const time = lines.find((l) => TIME_LINE.test(l));
      const rest2 = lines.filter(
        (l) => l !== time && l !== from && l !== fromEmail && l !== String(key),
      );
      const subject = rest2.shift() || "";
      messages.push({
        key: String(key),
        url: urlFor(key),
        from,
        fromEmail: self ? "" : fromEmail,
        fromMe: self || undefined,
        subject,
        preview: rest2.join(" ").slice(0, PREVIEW_CAP) || undefined,
        receivedText: time || undefined,
        receivedAt: parseReceived(time, now),
        links: linksOf(row),
      });
    }
  }
  return { v: /** @type {1} */ (1), provider: /** @type {"outlook"} */ ("outlook"), folder, view, messages };
}
