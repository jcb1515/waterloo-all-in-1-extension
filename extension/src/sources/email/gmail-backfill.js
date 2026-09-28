// @ts-check
/*
  Gmail backfill acquisition. Two request kinds, both same-origin GETs with
  the page's own cookies:

    - list pages come from a hidden same-origin iframe pointed at
      `/mail/u/<n>/#search/<encoded query>` (paging via `/p2`, `/p3`…). The
      rendered `tr.zA` rows are parsed by the SAME extractFor() path the
      passive reader uses, so keys/subjects/previews/senders/receivedAt are
      identical. Unread rows carry the `zE` class; `data-legacy-thread-id`
      and `data-legacy-last-message-id` feed the Atom threadMap.
    - bodies come from `GET /mail/u/<n>/?view=pt&search=all&th=<threadHex>`,
      the rendered print view (no `ik` needed — `view=om` is NOT used).

  Nothing here changes read state, navigates a user tab, or posts to the
  page. The iframe is ours and is removed when the round ends.
*/

import { BF_MAX_PAGES } from "./backfill.js";
import {
  accountEmail,
  extractFor,
  linksOf,
  parseListLabel,
  textWithBreaks,
} from "./dom.js";
import { QUOTE_SEL } from "./selectors.js";
import { extractDates } from "../../lib/textdates/index.js";

const SETTLE_MS = 1500;
const POLL_MS = 300;
const PAGE_DEADLINE_MS = 45000;
const QUIET_PAGE_MS = 9000; // an empty result set still counts as settled
const BODY_CAP = 20000;

const textOf = (/** @type {any} */ el) =>
  String((el && el.textContent) || "").replace(/\s+/g, " ").trim();
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;

/**
 * The list query for one folder pass.
 * @param {string} folder "inbox"|"sent"
 * @param {{since?: string|null, lookbackDays: number}} plan
 */
export function gmailListQuery(folder, plan) {
  const box = folder === "sent" ? "in:sent" : "in:inbox";
  if (plan && plan.since) {
    const t = Date.parse(String(plan.since));
    if (Number.isFinite(t)) return `${box} after:${Math.floor(t / 1000)}`;
  }
  return `${box} newer_than:${(plan && plan.lookbackDays) || 30}d`;
}

/** The hidden-iframe list URL for one search page (1-based pages). */
export function gmailSearchPath(account, query, page = 1) {
  return `/mail/u/${account}/#search/${encodeURIComponent(query)}${page > 1 ? `/p${page}` : ""}`;
}

/** The print-view body URL for a thread's legacy id. */
export function gmailPrintPath(account, threadId) {
  return `/mail/u/${account}/?view=pt&search=all&th=${encodeURIComponent(threadId)}`;
}

/**
 * Wait until the iframe's search page has rendered and the row count is
 * stable (~1.5 s). Returns the document, or null on timeout/freeze.
 * @param {any} env @param {any} frame
 */
async function settleList(env, frame) {
  const settleMs = env.settleMs ?? SETTLE_MS;
  const pollMs = env.pollMs ?? POLL_MS;
  const quietMs = env.quietMs ?? QUIET_PAGE_MS;
  const deadline = env.pageDeadlineMs ?? PAGE_DEADLINE_MS;
  const end = Date.now() + deadline;
  let last = -1;
  let changedAt = Date.now();
  const navAt = Date.now();
  for (;;) {
    if (env.isFrozen && env.isFrozen()) return null;
    if (Date.now() >= end) return null;
    /** @type {any} */
    let doc = null;
    /** @type {string} */
    let hash = "";
    try {
      doc = frame.doc();
      hash = String(frame.href() || "");
    } catch {
      doc = null;
    }
    const rows =
      doc && doc.querySelectorAll ? doc.querySelectorAll("tr.zA").length : 0;
    if (rows !== last) {
      last = rows;
      changedAt = Date.now();
    } else if (
      /#search\//.test(hash) &&
      Date.now() - changedAt >= settleMs &&
      (last > 0 || Date.now() - navAt >= quietMs)
    ) {
      return doc;
    }
    // eslint-disable-next-line no-await-in-loop
    await env.sleep(pollMs);
  }
}

/**
 * The print view of one thread -> one Msg part per rendered message.
 * Real print markup varies a little across builds, so every lookup keeps a
 * text fallback; a table that yields neither sender nor body is skipped.
 * `acct` (the account address learned from the list page) flags fromMe.
 * @param {any} doc
 * @param {{acct?: string, now?: Date|number|string}} [opts]
 */
export function printViewParts(doc, { acct = "", now } = {}) {
  const ref = now instanceof Date ? now : new Date(/** @type {any} */ (now) || Date.now());
  /** @type {any[]} */
  const parts = [];
  const tables = doc.querySelectorAll("table.message");
  for (const t of tables) {
    /** @type {string} */
    let from = "";
    /** @type {string} */
    let fromEmail = "";
    const senderEl = t.querySelector(".gD[email], [email]");
    if (senderEl) {
      from = senderEl.getAttribute("name") || textOf(senderEl);
      fromEmail = senderEl.getAttribute("email") || "";
    }
    if (!fromEmail) {
      // Header fallback: a "<b>Name</b> <a@b>" shaped line in the first rows.
      const rows = [...t.querySelectorAll("tr")].slice(0, 4);
      for (const r of rows) {
        const line = textOf(r);
        const m = EMAIL_RE.exec(line);
        if (m) {
          fromEmail = m[0];
          if (!from) {
            from = line
              .replace(m[0], "")
              .replace(/[<>()]/g, "")
              .replace(/\s{2,}/g, " ")
              .trim();
          }
          break;
        }
      }
    }
    /** @type {string|undefined} */
    let receivedText;
    const dateEl = t.querySelector(".g3[title], td[title], [title]");
    if (dateEl) receivedText = dateEl.getAttribute("title") || textOf(dateEl);
    let receivedAt = receivedText && parseListLabel(receivedText, ref);
    if (!receivedAt && receivedText) {
      try {
        const h = extractDates(receivedText, { now: ref })[0];
        receivedAt = h && h.startAt;
      } catch {
        receivedAt = undefined;
      }
    }
    if (!receivedText) {
      // No title attr — a lone date-looking cell.
      for (const td of t.querySelectorAll("td")) {
        const s = textOf(td);
        if (
          /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b/i.test(
            s,
          ) &&
          /\d/.test(s) &&
          s.length < 60
        ) {
          receivedText = s;
          receivedAt = parseListLabel(s, ref);
          if (!receivedAt) {
            try {
              const h = extractDates(s, { now: ref })[0];
              receivedAt = h && h.startAt;
            } catch {
              receivedAt = undefined;
            }
          }
          break;
        }
      }
    }
    const bodyEl = t.querySelector(".a3s") || t;
    const body = textWithBreaks(bodyEl, QUOTE_SEL).slice(0, BODY_CAP);
    if (!from && !body) continue;
    const self =
      String(from).trim().toLowerCase() === "me" ||
      (!!acct && String(fromEmail).toLowerCase() === acct);
    parts.push({
      from,
      fromEmail: self ? "" : fromEmail,
      fromMe: self || undefined,
      receivedText: receivedText || undefined,
      receivedAt,
      body: body || undefined,
      links: linksOf(bodyEl),
    });
  }
  return parts;
}

/**
 * The Gmail impl for backfillRound(). env supplies: account (the /u/<n>/
 * index), makeFrame(url) -> {navigate(url), doc(), href(), remove()},
 * parseHtml(text), sleep(ms), pageUrl.
 */
export const gmailBackfill = {
  provider: "gmail",

  /** @param {any} settings */
  folders(settings) {
    const f = Array.isArray(settings.folders) ? settings.folders : ["inbox"];
    const out = ["inbox"];
    if (f.some((x) => String(x).toLowerCase() === "sent")) out.push("sent");
    return out;
  },

  /** Create the hidden iframe once per round. */
  open(env) {
    if (typeof env.makeFrame !== "function") return null;
    const frame = env.makeFrame("about:blank");
    return frame ? { frame, acct: "" } : null;
  },

  async listPage(env, { ctx, folder, cursor, plan, slot }) {
    const page = Number(cursor) || 1;
    const query = gmailListQuery(folder, plan);
    const url = gmailSearchPath(env.account || 0, query, page);
    await slot();
    ctx.frame.navigate(url);
    const doc = await settleList(env, ctx.frame);
    if (!doc || !doc.querySelectorAll) return null;
    if (!ctx.acct) ctx.acct = accountEmail(doc);
    /** @type {string} */
    let href = "";
    try {
      href = String(ctx.frame.href() || "");
    } catch {
      href = "";
    }
    const ext = extractFor(doc, href || `https://mail.google.com${url}`, {
      now: env.now,
    });
    /** @type {Record<string, string>} */
    const threadMap = {};
    let unreadCount = 0;
    for (const tr of doc.querySelectorAll("tr.zA")) {
      const th = tr.getAttribute("data-legacy-thread-id");
      const lm = tr.getAttribute("data-legacy-last-message-id");
      if (th && lm && lm !== th) threadMap[lm] = th;
      if (/\bzE\b/.test(String(tr.className || ""))) unreadCount++;
    }
    const messages = (ext.messages || []).map((m) => ({ ...m }));
    if (unreadCount) {
      // Rows the list marks unread keep that flag for the body's gate.
      let i = 0;
      for (const tr of doc.querySelectorAll("tr.zA")) {
        if (i >= messages.length) break;
        if (/\bzE\b/.test(String(tr.className || ""))) messages[i].unread = true;
        i++;
      }
    }
    return {
      messages,
      threadMap,
      // Keep paging while a full page came back — the run-level page cap
      // (<=10) is enforced by the orchestrator.
      nextCursor: messages.length >= 50 ? page + 1 : null,
    };
  },

  async fetchBody(env, { ctx, msg, request }) {
    /** @type {any} */
    let res;
    try {
      res = await request(gmailPrintPath(env.account || 0, msg.key), {
        method: "GET",
        credentials: "same-origin",
      });
    } catch {
      return "abort";
    }
    if (!res || res.status !== 200 || res.redirected) return "abort";
    /** @type {string} */
    let ct = "";
    try {
      ct = (res.headers && res.headers.get("content-type")) || "";
    } catch {
      ct = "";
    }
    if (!/html/i.test(ct)) return "abort";
    /** @type {any} */
    let doc;
    try {
      doc = env.parseHtml(await res.text());
    } catch {
      return "abort";
    }
    if (!doc || /accounts\.google\.com/i.test(String((doc && doc.title) || ""))) {
      return "abort"; // bounced to sign-in
    }
    const parts = printViewParts(doc, { acct: ctx.acct, now: env.now });
    if (!parts.length) return null;
    const bodies = parts.map((p) => p.body).filter(Boolean);
    const links = [...new Set(parts.flatMap((p) => p.links || []))];
    // The thread's sender stays the incoming party — an all-mine thread or a
    // trailing own reply must not relabel the row "me".
    const last = parts[parts.length - 1];
    const incoming = [...parts].reverse().find((p) => !p.fromMe) || last;
    /** @type {string|undefined} */
    let subject;
    const h = doc.querySelector("h1, h2, .hP");
    if (h) subject = textOf(h) || undefined;
    return {
      body: bodies.join("\n\n").slice(0, BODY_CAP),
      links,
      parts,
      subject: subject || msg.subject,
      from: incoming.from || msg.from,
      fromEmail: incoming.fromEmail || msg.fromEmail,
      receivedAt: last.receivedAt || msg.receivedAt,
    };
  },

  close(env, ctx) {
    try {
      ctx.frame.remove();
    } catch {
      /* already gone */
    }
  },
};

export { BF_MAX_PAGES };
