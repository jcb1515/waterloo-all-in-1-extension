// @ts-check
// Gmail Atom fetch — the ONLY network call this source makes (README
// "Network"). The unread-mail feed at /mail/u/<n>/feed/atom is a same-origin
// GET with the page's own cookies: no tokens, no storage writes, nothing
// leaves the page but the same wa1:observed DOM payload the passive reader
// already produces. Mail text still travels only as a transient extract to
// OUR OWN background.
//
// Privacy rules:
//   - the feed-level <title>/<tagline> carry the account address — entries
//     only, never the feed header;
//   - author/email feeds the sender/bulk gates exactly like a list row and
//     is never stored in items or state;
//   - a fetch result that lands after a freeze is dropped (generation), so
//     a resumed tab can never double-send.

import { MSG } from "../../core/contract.js";

export const ATOM_TIMEOUT_MS = 15000;
export const ATOM_GAP_MS = 30 * 60 * 1000;
export const ATOM_RETRY_MS = 5 * 60 * 1000;
export const ATOM_KEY = "wa1:gmail:atomAt";
const PREVIEW_CAP = 200; // same cap dom.js applies to list-row previews

/** The one URL this script may request, relative to the Gmail origin. */
export const atomPath = (account) => `/mail/u/${account}/feed/atom`;

/** The /u/<n>/ account index of a Gmail page path; 0 when absent. */
export function gmailAccountIndex(pathname) {
  const m = String(pathname || "").match(/\/u\/(\d+)\//);
  return m ? Number(m[1]) : 0;
}

// Bumped on the Page Lifecycle `freeze` event: a fetch issued under an
// older generation that settles late is stale and is dropped.
let generation = 0;
export function atomFreeze() {
  generation++;
}

/** Test hook — reset the freeze generation. */
export function __resetAtom() {
  generation = 0;
}

const text = (el, tag) => {
  const n = el && el.getElementsByTagName ? el.getElementsByTagName(tag)[0] : null;
  return n && n.textContent ? n.textContent.trim() : "";
};

/** Trailing id of an Atom <id> ("…:1443955098434545334") or link href. */
const idTail = (s) => {
  const m = String(s || "").match(/([0-9a-z]+)\s*$/i);
  return m ? m[1] : "";
};

/**
 * Atom XML document -> the same message shape a Gmail list row produces.
 * Reads <entry> children only — the feed header names the account.
 * @param {any} doc parsed feed document
 * @param {{account?: number}} [opts]
 * @returns {any[]}
 */
export function atomMessages(doc, { account = 0 } = {}) {
  const urlFor = (key) => `https://mail.google.com/mail/u/${account}/#inbox/${key}`;
  /** @type {any[]} */
  const messages = [];
  for (const e of doc.getElementsByTagName("entry")) {
    let key = "";
    for (const l of e.getElementsByTagName("link")) {
      const href = l.getAttribute && l.getAttribute("href");
      const m = href && href.match(/message_id=([0-9a-z]+)/i);
      if (m) {
        key = m[1];
        break;
      }
    }
    if (!key) key = idTail(text(e, "id"));
    if (!key) continue;
    const issued = text(e, "issued") || text(e, "modified");
    messages.push({
      key: String(key),
      url: urlFor(key),
      from: text(e.getElementsByTagName("author")[0], "name"),
      fromEmail: text(e.getElementsByTagName("author")[0], "email"),
      subject: text(e, "title"),
      preview: text(e, "summary").slice(0, PREVIEW_CAP) || undefined,
      receivedAt: Date.parse(issued) ? new Date(issued).toISOString() : undefined,
      links: [],
    });
  }
  return messages;
}

/**
 * One Atom fetch when the page is not frozen and the throttle allows it:
 * GET the feed, parse entries, and replay them as the exact wa1:observed
 * "dom" payload the passive Gmail reader sends. Never throws.
 * @param {{
 *   fetchImpl: (url: string, init: RequestInit) => Promise<any>,
 *   sendMessage: (msg: any) => void,
 *   parseXml: (text: string) => any,
 *   getLast?: () => {at?: number, ok?: boolean} | number | null,
 *   setLast?: (stamp: {at: number, ok: boolean}) => void,
 *   isFrozen?: () => boolean,
 *   account?: number,
 *   pageUrl?: string,
 *   now?: Date,
 * }} env
 */
export async function atomRound(env) {
  const now = env.now || new Date();
  if (typeof env.isFrozen === "function" && env.isFrozen()) {
    return { skipped: "frozen", sent: 0 };
  }
  const lastRaw = env.getLast ? env.getLast() : null;
  const last = typeof lastRaw === "number" ? { at: lastRaw, ok: true } : lastRaw || null;
  if (last && last.at) {
    const gap = last.ok === false ? ATOM_RETRY_MS : ATOM_GAP_MS;
    if (now.getTime() - last.at < gap) return { skipped: "throttled", sent: 0 };
  }

  const account = env.account ?? 0;
  const gen = generation;
  const t0 = Date.now();
  /** @type {any} */
  let res;
  try {
    res = await env.fetchImpl(atomPath(account), {
      method: "GET",
      credentials: "same-origin",
      signal: AbortSignal.timeout(ATOM_TIMEOUT_MS),
    });
  } catch {
    res = null;
  }
  if (gen !== generation) return { stale: true, sent: 0 }; // froze mid-fetch

  /** @param {boolean} ok */
  const done = (ok, extra = {}) => {
    if (env.setLast) env.setLast({ at: now.getTime(), ok });
    return { sent: 0, ms: Date.now() - t0, ...extra };
  };
  if (!res) return done(false, { error: "network" });
  const status = Number(res.status) || 0;
  let type = "";
  try {
    type = (res.headers && res.headers.get("content-type")) || "";
  } catch {
    /* keep "" */
  }
  // Anything but a 200 XML document (sign-in redirect, HTML error page,
  // JSON) stops the round — nothing is forwarded.
  if (status !== 200 || res.redirected || !/xml/i.test(type)) {
    return done(false, { error: `http-${status}` });
  }

  let doc;
  try {
    doc = env.parseXml(await res.text());
  } catch {
    return done(false, { error: "parse" });
  }
  const messages = atomMessages(doc, { account });
  if (!messages.length) return done(true);

  env.sendMessage({
    type: MSG.OBSERVED,
    payload: {
      source: "gmail",
      kind: "dom",
      url: env.pageUrl || "",
      body: JSON.stringify({
        v: 1,
        provider: "gmail",
        folder: "inbox",
        view: "atom",
        messages,
      }),
      at: new Date().toISOString(),
    },
  });
  if (env.setLast) env.setLast({ at: now.getTime(), ok: true });
  return { sent: 1, ms: Date.now() - t0, entries: messages.length };
}
