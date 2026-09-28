// @ts-check
/*
  Reader probe for W1's "Check readers" screen: counts how many of the
  selectors the email adapter depends on actually hit on the current page.
  Pure and never throws — counts only, no text, names, ids or addresses.
*/

import { accountEmail, extractFor, inviteCard, linksOf } from "./dom.js";
import { GMAIL, OUTLOOK } from "./selectors.js";

const HINT_LIST = "No messages found — open your Inbox and wait for it to load.";
const HINT_BODY = "Open one email so the message body can be checked.";
const HINT_ACCOUNT =
  "Couldn't detect your signed-in address — replies won't auto-complete reply to-dos.";
const HINT_OPEN = "Open your inbox or an email.";

/**
 * W1's CheckRow plus the v2 checklist fields (`url` is the page an "Open"
 * button targets, `essential` marks first-run rows, `refreshDays` nudges
 * when the last good read is older).
 * @typedef {import("../probes.js").CheckRow & {
 *   url?: string, essential?: boolean, refreshDays?: number}} CheckRow
 */

/** Pages the user should open to verify this reader. `page` is the probe
 *  page kind the item expects.
 * @type {CheckRow[]} */
export const CHECKLIST = [
  {
    id: "gmail-inbox",
    page: "gmail-list",
    label: "Gmail inbox",
    how: "Open mail.google.com and let the inbox load.",
    url: "https://mail.google.com/mail/u/0/#inbox",
    essential: true,
    refreshDays: 3,
    stat: { kind: "observe", scope: "email:gmail:list", itemsMin: 0 },
  },
  {
    id: "gmail-invite",
    page: "gmail-message",
    label: "A Gmail invite email",
    how: "Open an email with a calendar invite (Yes / No / Maybe buttons).",
    url: "https://mail.google.com/mail/u/0/#search/filename%3Aics",
  },
  {
    id: "gmail-prof",
    page: "gmail-message",
    label: "An email from a prof or TA",
    how: "Open any email from a course instructor.",
  },
  {
    id: "gmail-sent",
    page: "gmail-list",
    label: "Gmail Sent folder",
    how: "Open Sent — used to mark reply to-dos done.",
    url: "https://mail.google.com/mail/u/0/#sent",
    refreshDays: 7,
    stat: { kind: "observe", scope: "email:gmail:list", itemsMin: 0 },
  },
  {
    id: "outlook-inbox",
    page: "outlook-list",
    label: "Outlook inbox",
    how: "Open Outlook on the web and let the inbox load.",
    url: "https://outlook.office.com/mail/inbox",
    essential: true,
    refreshDays: 3,
    stat: { kind: "observe", scope: "email:outlook:list", itemsMin: 0 },
  },
  {
    id: "outlook-invite",
    page: "outlook-message",
    label: "An Outlook meeting invite",
    how: "Open an invite with Accept / Tentative / Decline.",
  },
  {
    id: "outlook-message",
    page: "outlook-message",
    label: "Any Outlook email",
    how: "Open any email so its body shows.",
  },
];

const UNKNOWN = { page: "unknown", counts: {}, ok: false, hints: [HINT_OPEN] };

/** @param {any[]} rows @param {string} sel */
const rowsWith = (rows, sel) =>
  rows.reduce((n, r) => {
    try {
      return n + (r.querySelector(sel) ? 1 : 0);
    } catch {
      return n;
    }
  }, 0);

/** @param {any} root @param {string} sel */
const count = (root, sel) => {
  try {
    return (root && root.querySelectorAll(sel).length) || 0;
  } catch {
    return 0;
  }
};

/**
 * @param {any} doc   a DOM Document (linkedom or real)
 * @param {string} href
 * @returns {{page: string, counts: Record<string, number>, ok: boolean, hints: string[]}}
 */
export function probe(doc, href) {
  try {
    if (!doc || typeof doc.querySelectorAll !== "function") return { ...UNKNOWN };
    /** @type {URL} */
    let u;
    try {
      u = new URL(String(href || ""));
    } catch {
      return { ...UNKNOWN };
    }
    const host = u.hostname;
    const provider =
      host === "mail.google.com"
        ? "gmail"
        : ["outlook.office.com", "outlook.cloud.microsoft", "outlook.live.com"].includes(host)
          ? "outlook"
          : null;
    if (!provider) return { ...UNKNOWN };

    // Same view split as extractFor (it never throws).
    const ex = extractFor(doc, href);
    let page = `${provider}-${ex.view}`;
    // A recognized host on a non-mail path is just "other".
    if (provider === "outlook" && !/^\/mail(\/|$)/.test(u.pathname)) page = "outlook-other";
    if (provider === "gmail" && !/^\/mail(\/|$)/.test(u.pathname)) page = "gmail-other";
    const account = accountEmail(doc) ? 1 : 0;
    /** @type {Record<string, number>} */
    let counts = {};
    /** @type {boolean} */
    let ok = false;
    /** @type {string[]} */
    const hints = [];

    if (page === "gmail-list") {
      const rows = [...doc.querySelectorAll(GMAIL.listRow)];
      counts = {
        listRows: rows.length,
        threadIds: rows.filter(
          (tr) => tr.getAttribute("data-legacy-thread-id") || tr.querySelector(GMAIL.threadId),
        ).length,
        sender: rowsWith(rows, GMAIL.sender),
        subject: rowsWith(rows, GMAIL.subject),
        preview: rowsWith(rows, GMAIL.preview),
        date: rowsWith(rows, GMAIL.date),
        account,
      };
      ok = rows.length > 0 && counts.subject > 0;
      if (!rows.length) hints.push(HINT_LIST);
    } else if (page === "gmail-message") {
      const msgs = [...doc.querySelectorAll(GMAIL.msg)];
      const main = doc.querySelector('[role="main"]');
      counts = {
        messageSubject: count(doc, GMAIL.msgSubject),
        messages: msgs.length,
        sender: rowsWith(msgs, GMAIL.msgFrom),
        date: rowsWith(msgs, GMAIL.msgDate),
        messageBody: rowsWith(msgs, GMAIL.msgBody),
        inviteCard: inviteCard(doc, true) ? 1 : 0,
        links: linksOf(main || doc).length,
        account,
      };
      ok = msgs.length > 0 && counts.messageBody > 0;
      if (!counts.messageBody) hints.push(HINT_BODY);
    } else if (page === "outlook-list") {
      const rows = [...doc.querySelectorAll(OUTLOOK.listRow)];
      const any = [...doc.querySelectorAll(OUTLOOK.listRowAny)];
      const eff = rows.length ? rows : any;
      counts = {
        listRows: rows.length,
        rowsAny: any.length,
        sender: rowsWith(eff, OUTLOOK.sender),
        account,
      };
      ok = counts.listRows + counts.rowsAny > 0;
      if (!eff.length) hints.push(HINT_LIST);
    } else if (page === "outlook-message") {
      const main = doc.querySelector(OUTLOOK.main);
      counts = {
        main: count(doc, OUTLOOK.main),
        heading: main ? count(main, OUTLOOK.heading) : 0,
        messageBody: main ? count(main, OUTLOOK.body) : 0,
        sentTime: main ? count(main, OUTLOOK.sentTime) : 0,
        selectedRow: count(doc, OUTLOOK.selected),
        inviteCard: inviteCard(doc, false) ? 1 : 0,
        account,
      };
      ok = counts.messageBody > 0;
      if (!counts.messageBody) hints.push(HINT_BODY);
    } else {
      hints.push(HINT_OPEN);
    }
    if (!account && (page.endsWith("-list") || page.endsWith("-message"))) {
      hints.push(HINT_ACCOUNT);
    }
    return { page, counts, ok, hints };
  } catch {
    return { ...UNKNOWN };
  }
}
