// @ts-check
/*
  Gmail mail read. Two acquisition paths, both read-only:

    - the list comes from the OPEN TAB's own inbox DOM — the same
      extractFor() list path the passive reader uses, so keys/subjects/
      previews/senders/receivedAt are identical. The tab must show the
      first inbox page ("#inbox", not "#inbox/p2" or a thread id); runs are
      gated on that by content.js and again by impl.skipReason below.
      `tr.zA` rows' `data-legacy-thread-id` / `data-legacy-last-message-id`
      feed the Atom threadMap, and the `zE` class marks unread rows.
    - bodies come from `GET /mail/u/<n>/?view=pt&search=all&th=<threadHex>`,
      the rendered print view (no `ik` needed — `view=om` is NOT used),
      fetched only for needsBody candidates under the shared rate cap.

  Nothing here changes read state, navigates or focuses the user tab, or
  posts to the page. There is no iframe: framing Gmail on the same origin
  syncs the top URL hash, which is a user-visible navigation.
*/

import {
  accountEmail,
  extractFor,
  linksOf,
  parseListLabel,
  textWithBreaks,
} from "./dom.js";
import { QUOTE_SEL } from "./selectors.js";
import { extractDates } from "../../lib/textdates/index.js";

const BODY_CAP = 20000;
const LIST_CAP = 50; // the first inbox page

const textOf = (/** @type {any} */ el) =>
  String((el && el.textContent) || "").replace(/\s+/g, " ").trim();
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;

/** The print-view body URL for a thread's legacy id. */
export function gmailPrintPath(account, threadId) {
  return `/mail/u/${account}/?view=pt&search=all&th=${encodeURIComponent(threadId)}`;
}

const EMAIL_RE_G = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/**
 * The To:/Cc:/Bcc: recipient block of one print-view message:
 * `<font class="recipient"><div>To: a@b, c@d</div><div>Cc: e@f</div></font>`.
 * Returns the address list (lowercased), or null when the block is absent.
 * @param {any} t  one table.message element
 */
function recipientAddrs(t) {
  /** @type {string[]} */
  const out = [];
  for (const d of t.querySelectorAll(".recipient div")) {
    const line = textOf(d);
    const m = /^(?:to|cc|bcc)\s*:\s*(.+)$/i.exec(line);
    if (m) out.push(...(m[1].match(EMAIL_RE_G) || []).map((e) => e.toLowerCase()));
  }
  return out.length ? out : null;
}

/**
 * The print view of one thread -> one Msg part per rendered message.
 * Current markup (verified live): `table.message`, first cell holds
 * `<b>Name</b> &lt;addr&gt;`, the right-aligned cell the date, a
 * `.recipient` block the To/Cc lines, `div[dir]` the body. Older builds
 * used .gD/.g3/.a3s — every lookup keeps that fallback; a table that
 * yields neither sender nor body is skipped.
 * `acct` (the account address learned from the list page) flags fromMe
 * and drives toMe — the address itself never lands on the Msg.
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
    if (!from) {
      // Current header: first cell is "<b>Name</b> <addr>" — take the name
      // from the b, never the whole row (it trails the date text).
      const firstTd = t.querySelector("td");
      if (firstTd) {
        const b = firstTd.querySelector("b");
        from = b ? textOf(b) : "";
        if (!fromEmail) {
          const m = /<([^<>\s@()]+@[^<>\s@()]+)>/.exec(textOf(firstTd));
          if (m) fromEmail = m[1];
        }
      }
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
    const dateEl =
      t.querySelector('td[align="right"] [title], td[align="right"]') ||
      t.querySelector(".g3[title], td[title], [title]");
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
    const bodyEl =
      t.querySelector(".a3s") || t.querySelector("div[dir]") || t;
    const body = textWithBreaks(bodyEl, QUOTE_SEL).slice(0, BODY_CAP);
    if (!from && !body) continue;
    const self =
      String(from).trim().toLowerCase() === "me" ||
      (!!acct && String(fromEmail).toLowerCase() === acct);
    const recips = recipientAddrs(t);
    parts.push({
      from,
      fromEmail: self ? "" : fromEmail,
      fromMe: self || undefined,
      receivedText: receivedText || undefined,
      receivedAt,
      body: body || undefined,
      links: linksOf(bodyEl),
      ...(recips
        ? {
            recipients: recips.length,
            toMe: !!acct && recips.includes(String(acct).toLowerCase()),
          }
        : {}),
    });
  }
  return parts;
}

/**
 * The Gmail impl for backfillRound(). env supplies: account (the /u/<n>/
 * index), doc() -> the tab's live Document, onInbox() -> bool, parseHtml,
 * sleep, pageUrl.
 */
export const gmailBackfill = {
  provider: "gmail",
  skipReason: "not-on-page",

  /** @param {any} _settings — the read is the tab's own inbox page. */
  folders(_settings) {
    return ["inbox"];
  },

  /** The tab must be showing the inbox's first page; nothing else opens. */
  open(env) {
    if (env.onInbox && !env.onInbox()) return null;
    return { acct: "" };
  },

  /** One page only: the inbox list as rendered in this tab. */
  async listPage(env, { ctx }) {
    const doc = typeof env.doc === "function" ? env.doc() : null;
    if (!doc || !doc.querySelectorAll) return null;
    if (!ctx.acct) ctx.acct = accountEmail(doc);
    const ext = extractFor(doc, env.pageUrl || "", { now: env.now });
    /** @type {Record<string, string>} */
    const threadMap = {};
    const unread = new Set();
    {
      const rows = doc.querySelectorAll("tr.zA");
      for (const tr of rows) {
        const th = tr.getAttribute("data-legacy-thread-id");
        const lm = tr.getAttribute("data-legacy-last-message-id");
        if (th && lm && lm !== th) threadMap[lm] = th;
      }
      let i = 0;
      const messages = (ext.messages || []).slice(0, LIST_CAP);
      for (const tr of rows) {
        if (i >= messages.length) break;
        if (/\bzE\b/.test(String(tr.className || ""))) unread.add(i);
        // The thread's last-message id is the body-read signature: a new
        // reply bumps it, so a stale signature means refetch the body.
        const sig =
          tr.getAttribute("data-legacy-last-message-id") ||
          tr.getAttribute("data-legacy-thread-id");
        if (sig) messages[i].sig = sig;
        i++;
      }
      messages.forEach((m, i) => {
        if (unread.has(i)) m.unread = true;
      });
      return { messages, threadMap, nextCursor: null };
    }
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

  close() {
    /* nothing opened — the tab's own DOM needs no cleanup */
  },
};
