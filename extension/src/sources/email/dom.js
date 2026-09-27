// @ts-check
/*
  Pure DOM readers for mail.google.com and outlook.* — produce a normalised
  Msg list for the adapter. Every selector is a best guess (see selectors.js
  and README "needs tuning"); a miss just yields fewer messages. No fetch,
  no chrome, no storage.
*/

import { extractDates } from "../../lib/textdates/index.js";
import { GMAIL, OUTLOOK } from "./selectors.js";

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
 */

const BODY_CAP = 20000;
const PREVIEW_CAP = 200;

const textOf = (el) => String((el && el.textContent) || "").replace(/\s+/g, " ").trim();

/**
 * Element text with line structure preserved: <br> and block boundaries
 * become "\n", inline whitespace collapses to one space. (Same walk as
 * sources/discord/dom.js's textWithBreaks.)
 * @param {any} el
 */
export function textWithBreaks(el) {
  let out = "";
  const walk = (node) => {
    for (const child of (node && node.childNodes) || []) {
      if (child.nodeType === 3 /* TEXT_NODE */) {
        out += child.nodeValue || "";
      } else if (String(child.nodeName || "").toUpperCase() === "BR") {
        out += "\n";
      } else {
        const before = out.length;
        walk(child);
        if (
          out.length > before &&
          /^(DIV|P|LI|H[1-6]|SECTION|ARTICLE|TR|PRE|BLOCKQUOTE)$/.test(
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
function linksOf(el) {
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
    if (MEET_LINK.test(href) && !out.includes(href)) out.push(href);
  }
  return out;
}

/** Parse a human date/time label ("Thu, Oct 1, 2026, 3:14 PM") Toronto-side. */
function parseReceived(text) {
  try {
    const hits = extractDates(String(text || ""), { now: new Date() });
    const h = hits.find((x) => x.confidence >= 0.5) || hits[0];
    return h ? h.startAt : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {any} doc
 * @param {string} href
 * @returns {{v: 1, provider: "gmail"|"outlook", folder: string|null,
 *   view: "list"|"message"|"other", messages: Msg[]}}
 */
export function extractFor(doc, href) {
  try {
    const host = new URL(href).hostname;
    if (host === "mail.google.com") return gmailExtract(doc, href);
    return outlookExtract(doc, href);
  } catch {
    return { v: 1, provider: "outlook", folder: null, view: "other", messages: [] };
  }
}

/* ------------------------------ Gmail ------------------------------ */

function gmailExtract(doc, href) {
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
  } else {
    folder = segs[0] || "inbox";
    msgId = segs[1];
  }
  const view = /** @type {"message"|"list"} */ (msgId ? "message" : "list");
  const urlFor = (key) => `https://mail.google.com/mail/u/${n}/#${folder || "inbox"}/${key}`;

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
      messages.push({
        key: String(key || ""),
        url: urlFor(key),
        from: (senderEl && (senderEl.getAttribute("name") || textOf(senderEl))) || "",
        fromEmail: (senderEl && senderEl.getAttribute("email")) || "",
        subject,
        receivedText: receivedText || undefined,
        receivedAt: parseReceived(receivedText),
        body: bodyEl ? textWithBreaks(bodyEl).slice(0, BODY_CAP) : undefined,
        links: linksOf(bodyEl),
      });
    }
  } else {
    for (const tr of doc.querySelectorAll(GMAIL.listRow)) {
      const idEl = tr.getAttribute("data-legacy-thread-id") ? tr : tr.querySelector(GMAIL.threadId);
      const key = idEl && idEl.getAttribute("data-legacy-thread-id");
      if (!key) continue;
      const senderEl = tr.querySelector(GMAIL.sender);
      const dateEl = tr.querySelector(GMAIL.date);
      const receivedText = dateEl ? dateEl.getAttribute("title") || textOf(dateEl) : "";
      messages.push({
        key: String(key),
        url: urlFor(key),
        from: (senderEl && (senderEl.getAttribute("name") || textOf(senderEl))) || "",
        fromEmail: (senderEl && senderEl.getAttribute("email")) || "",
        subject: textOf(tr.querySelector(GMAIL.subject)),
        preview: textOf(tr.querySelector(GMAIL.preview))
          .replace(/^\s*[-–—]+\s*/, "")
          .slice(0, PREVIEW_CAP) || undefined,
        receivedText: receivedText || undefined,
        receivedAt: parseReceived(receivedText),
        links: [],
      });
    }
  }
  return { v: /** @type {1} */ (1), provider: /** @type {"gmail"} */ ("gmail"), folder, view, messages };
}

/* ----------------------------- Outlook ----------------------------- */

const TIME_LINE = /^\d{1,2}:\d{2}\s*[AP]M$|^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b|^\d{4}-\d{2}-\d{2}$/i;

function outlookExtract(doc, href) {
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
      messages.push({
        key: String(key),
        url: urlFor(key),
        from: textOf(senderEl),
        fromEmail: (senderEl && senderEl.getAttribute("title")) || "",
        subject: textOf(main.querySelector(OUTLOOK.heading)),
        receivedText: receivedText || undefined,
        receivedAt: parseReceived(receivedText),
        body: bodyEl ? textWithBreaks(bodyEl).slice(0, BODY_CAP) : undefined,
        links: linksOf(bodyEl),
      });
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
        fromEmail,
        subject,
        preview: rest2.join(" ").slice(0, PREVIEW_CAP) || undefined,
        receivedText: time || undefined,
        receivedAt: parseReceived(time),
        links: linksOf(row),
      });
    }
  }
  return { v: /** @type {1} */ (1), provider: /** @type {"outlook"} */ ("outlook"), folder, view, messages };
}
