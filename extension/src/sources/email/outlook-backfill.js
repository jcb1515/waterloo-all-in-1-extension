// @ts-check
/*
  Outlook-web backfill acquisition, via the page's own MSAL access token
  against the same-origin OWA REST endpoint:

    - token: read per round from the page's localStorage MSAL cache, kept in
      a local variable for that round, and used ONLY as the Authorization
      header of same-origin `/api/v2.0/me/...` GETs. Never stored, never
      logged, never put in a message/payload/URL, never sent off-origin.
      No token -> the round is skipped silently (payload-less).
    - lists: GET /api/v2.0/me/mailfolders/{inbox|sentitems}/messages with
      $top/$select/$filter/$orderby/$count, paged via @odata.nextLink
      (stripped back to the same-origin path).
    - bodies: GET /api/v2.0/me/messages/<id>?$select=Body,IsRead with
      Prefer: outlook.body-content-type="text" — a read, never a write.

  NOT used: the global Graph endpoint (403) or OWA's legacy SOAP-style item
  API (401, and there is no canary cookie to authorise it anyway).
  Canonical key = ConversationId (the passive reader's data-convid); the
  item url is the message's WebLink.
*/

const BODY_CAP = 20000;
const LINK_CAP = 25;
const MAIL_SCOPE_RE = /https:\/\/outlook\.office\.com\/Mail\.Read(Write)?\b/i;
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;

/**
 * Pick the unexpired Mail.Read(Write) AccessToken from raw localStorage
 * values. `values` are the storage strings; each must parse to
 * {credentialType, secret, expiresOn (epoch s), target (space scopes)}.
 * Returns the secret string or null. @param {string[]} values @param {number} nowMs
 */
export function outlookToken(values, nowMs) {
  /** @type {{secret: string, exp: number} | null} */
  let best = null;
  for (const raw of values || []) {
    /** @type {any} */
    let v;
    try {
      v = JSON.parse(String(raw));
    } catch {
      continue;
    }
    if (!v || String(v.credentialType || "").toLowerCase() !== "accesstoken") continue;
    const secret = String(v.secret || "");
    if (!secret) continue;
    const exp = Number(v.expiresOn) * 1000;
    if (!Number.isFinite(exp) || exp <= nowMs + 60000) continue;
    if (!MAIL_SCOPE_RE.test(String(v.target || ""))) continue;
    if (!best || exp > best.exp) best = { secret, exp };
  }
  return best ? best.secret : null;
}

/** The single-message body path. @param {string} id */
export function outlookBodyPath(id) {
  return `/api/v2.0/me/messages/${encodeURIComponent(id)}?$select=Body,IsRead`;
}

/**
 * Strip an absolute @odata.nextLink back to a same-origin /api/ path; null
 * for anything off that shape (never follow an off-origin link).
 * @param {string} link
 */
export function outlookNextPath(link) {
  try {
    const u = new URL(String(link || ""));
    const p = u.pathname + u.search;
    return p.startsWith("/api/v2.0/me/") ? p : null;
  } catch {
    return null;
  }
}

/**
 * One REST message -> the Msg shape the adapter reads. To/Cc recipients are
 * collapsed to a count plus a toMe flag — the addresses themselves never
 * leave the page.
 * @param {any} m @param {boolean} sent @param {string} [acct] my address (lowercased)
 */
export function outlookMsg(m, sent, acct = "") {
  const ea = (m && m.From && m.From.EmailAddress) || {};
  const when = m && (sent ? m.SentDateTime || m.ReceivedDateTime : m.ReceivedDateTime);
  /** @type {string[]} */
  const recips = [];
  for (const r of [...((m && m.ToRecipients) || []), ...((m && m.CcRecipients) || [])]) {
    const a = String((r && r.EmailAddress && r.EmailAddress.Address) || "").toLowerCase();
    if (a && !recips.includes(a)) recips.push(a);
  }
  const me = String(acct || "").toLowerCase();
  return {
    key: String((m && m.ConversationId) || ""),
    messageId: String((m && m.Id) || ""),
    url: (m && m.WebLink) || undefined,
    from: String(ea.Name || ""),
    fromEmail: String(ea.Address || ""),
    subject: String((m && m.Subject) || ""),
    preview: String((m && m.BodyPreview) || "").slice(0, 200) || undefined,
    receivedAt: Number.isFinite(Date.parse(when || ""))
      ? new Date(when).toISOString()
      : undefined,
    unread: (m && m.IsRead) === false || undefined,
    ...(recips.length ? { recipients: recips.length, toMe: !!me && recips.includes(me) } : {}),
    links: [],
  };
}

/**
 * The folder-list request path for one pass: newest N rows, no date filter.
 * @param {string} folder "inbox"|"sent"
 */
export function outlookListPath(folder) {
  const sent = folder === "sent";
  const stamp = sent ? "SentDateTime" : "ReceivedDateTime";
  const select = sent
    ? "Id,SentDateTime,IsRead,Subject,From,BodyPreview,WebLink,ConversationId,ToRecipients,CcRecipients"
    : "Id,ReceivedDateTime,IsRead,Subject,From,BodyPreview,WebLink,ConversationId,ToRecipients,CcRecipients";
  return (
    `/api/v2.0/me/mailfolders/${sent ? "sentitems" : "inbox"}/messages` +
    `?$top=50&$select=${select}` +
    `&$orderby=${encodeURIComponent(`${stamp} desc`)}&$count=true`
  );
}

const H = (/** @type {string} */ token) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/json",
});

/** urls embedded in a text body — for booking/form link detection. */
function bodyLinks(/** @type {string} */ text) {
  /** @type {string[]} */
  const out = [];
  for (const m of String(text || "").matchAll(URL_RE)) {
    const u = m[0].replace(/[.,;:!?'”’)\]]+$/, "");
    if (!out.includes(u)) out.push(u);
    if (out.length >= LINK_CAP) break;
  }
  return out;
}

/**
 * The Outlook impl for backfillRound(). env supplies lsValues() (raw
 * localStorage strings), fetchImpl, sleep, pageUrl.
 */
export const outlookBackfill = {
  provider: "outlook",
  skipReason: "no-token",

  /** @param {any} settings */
  folders(settings) {
    const f = Array.isArray(settings.folders) ? settings.folders : ["inbox"];
    const out = ["inbox"];
    if (f.some((x) => String(x).toLowerCase() === "sent")) out.push("sent");
    return out;
  },

  /** Read the MSAL token for this round only; null -> skip quietly. */
  open(env) {
    /** @type {string[]} */
    let values = [];
    try {
      values = env.lsValues ? env.lsValues() || [] : [];
    } catch {
      values = [];
    }
    const secret = outlookToken(values, (env.now || new Date()).getTime());
    return secret ? { secret } : null;
  },

  async listPage(env, { ctx, folder, cursor, plan, request }) {
    // Once per round: who am I? — one GET /me?$select=EmailAddress, held in
    // the round-local ctx like the token (never sent, never stored). Used
    // only to flag toMe/recipients on each row.
    if (ctx.acct === undefined) {
      ctx.acct = "";
      try {
        const me = await request("/api/v2.0/me?$select=EmailAddress", {
          method: "GET",
          headers: H(ctx.secret),
        });
        if (me && me.status === 200 && !me.redirected) {
          const ct = (me.headers && me.headers.get("content-type")) || "";
          if (/json/i.test(ct)) {
            const d = JSON.parse(await me.text());
            ctx.acct = String((d && d.EmailAddress) || "").toLowerCase();
          }
        }
      } catch {
        ctx.acct = ""; // no toMe this round — degrade, don't abort
      }
    }
    const path =
      typeof cursor === "string" && cursor ? cursor : outlookListPath(folder);
    /** @type {any} */
    let res;
    try {
      res = await request(path, { method: "GET", headers: H(ctx.secret) });
    } catch {
      return null;
    }
    if (!res || res.status !== 200 || res.redirected) return null;
    /** @type {string} */
    let ct = "";
    try {
      ct = (res.headers && res.headers.get("content-type")) || "";
    } catch {
      ct = "";
    }
    if (!/json/i.test(ct)) return null;
    /** @type {any} */
    let data;
    try {
      data = JSON.parse(await res.text());
    } catch {
      return null;
    }
    if (!data || !Array.isArray(data.value)) return null;
    const sent = folder === "sent";
    const messages = data.value
      .map((/** @type {any} */ m) => outlookMsg(m, sent, ctx.acct))
      .filter((/** @type {any} */ m) => m.key);
    // Newest N rows only: inbox follows plan.count (50/100/200), the sent
    // pass is capped at one page (50) — it only closes reply tasks.
    const seen = (ctx.seen && ctx.seen[folder]) || 0;
    ctx.seen = { ...(ctx.seen || {}), [folder]: seen + messages.length };
    const target = sent ? 50 : (plan && plan.count) || 100;
    const next = outlookNextPath(data["@odata.nextLink"]);
    return {
      messages,
      nextCursor: next && ctx.seen[folder] < target ? next : null,
    };
  },

  async fetchBody(env, { ctx, msg, request }) {
    if (!msg.messageId) return null;
    /** @type {any} */
    let res;
    try {
      res = await request(outlookBodyPath(msg.messageId), {
        method: "GET",
        headers: {
          ...H(ctx.secret),
          Prefer: 'outlook.body-content-type="text"',
        },
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
    if (!/json/i.test(ct)) return "abort";
    /** @type {any} */
    let data;
    try {
      data = JSON.parse(await res.text());
    } catch {
      return "abort";
    }
    const body = data && data.Body && String(data.Body.Content || "");
    if (!body) return null;
    return {
      body: body.slice(0, BODY_CAP),
      links: bodyLinks(body),
    };
  },

  close() {
    /* the token lived only in ctx for the round — nothing to clean */
  },
};
