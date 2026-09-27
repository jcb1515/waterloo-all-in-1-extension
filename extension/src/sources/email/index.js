// @ts-check
/*
  Email adapter — passive observe only (T3). OWA needs a tokened API we never
  captured and Gmail was likewise structural-only, so there are no net
  urlPatterns at all; everything arrives as a serialised DOM extract from
  content.js. "outlook" and "gmail" payloads both land here (the registry maps
  them to this adapter id).
*/

import { extractDates, termCodeFor } from "../../lib/textdates/index.js";
import { itemsFromMessage } from "./extract.js";
import { GMAIL_SCAN_QUERY, OUTLOOK_SCAN_QUERY } from "./rules.js";

/** @typedef {import("../../core/contract.js").SyncContext} SyncContext */
/** @typedef {import("../../core/contract.js").SyncResult} SyncResult */

const SCAN_TTL_MS = 24 * 60 * 60 * 1000;
const QUEUE_CAP = 200;
const SCANNED_CAP = 1000;

/**
 * Begin a guided scan: the UI opens `url` in the user's own mail tab (Gmail
 * only — Outlook web has no working search deeplink, so it shows `query` for
 * the user to paste) and content.js keeps observing what is rendered.
 * @param {any} state
 * @param {{provider?: string, now?: Date|number|string, days?: number, account?: number}} [opts]
 */
export function startMailScan(state, { provider, now, days = 60, account = 0 } = {}) {
  const p = provider === "gmail" ? "gmail" : "outlook";
  const query = p === "gmail" ? GMAIL_SCAN_QUERY(days) : OUTLOOK_SCAN_QUERY;
  const when = now instanceof Date ? now : new Date(now || Date.now());
  const next = {
    ...(state || {}),
    scan: { provider: p, startedAt: when.toISOString(), days, query },
    scanQueue: [],
  };
  const url =
    p === "gmail"
      ? `https://mail.google.com/mail/u/${account}/#search/${encodeURIComponent(query)}`
      : null;
  return { state: next, url, query };
}

/** Stop a scan; `scanned` stays so already-read threads are never requeued. @param {any} state */
export function stopMailScan(state) {
  const next = { ...(state || {}) };
  delete next.scan;
  delete next.scanQueue;
  return next;
}

/**
 * A click-through url for a queued scan row.
 * @param {string} provider @param {string} pageUrl @param {string} key
 */
function scanItemUrl(provider, pageUrl, key) {
  try {
    const u = new URL(String(pageUrl || ""));
    if (provider === "gmail") {
      const n = (u.pathname.match(/\/u\/(\d+)/) || [])[1] || "0";
      return `https://mail.google.com/mail/u/${n}/#all/${key}`;
    }
    const zero = u.hostname === "outlook.live.com" ? "0/" : "";
    return `https://${u.hostname}/mail/${zero}id/${encodeURIComponent(key)}`;
  } catch {
    return "";
  }
}

/** @type {import("../../core/contract.js").Adapter} */
const adapter = {
  id: "outlook",
  label: "Email (Outlook + Gmail)",
  origins: [
    "https://outlook.office.com",
    "https://outlook.cloud.microsoft",
    "https://outlook.live.com",
    "https://mail.google.com",
  ],
  intervalMinutes: 0,
  syncOnTabOpen: false,

  /** No fetch tier — mail APIs need auth we never hold. */
  async sync() {
    return { items: [], complete: false, session: "no-tab" };
  },

  observe: {
    urlPatterns: [],
    /**
     * @param {import("../../core/contract.js").ObservedPayload} payload
     * @param {SyncContext} ctx
     * @returns {Promise<SyncResult & {scope: string}>}
     */
    async parse(payload, ctx) {
      const provider = payload.source === "gmail" ? "gmail" : "outlook";
      const prev = ctx.state && typeof ctx.state === "object" ? ctx.state : {};
      const settings = ctx.settings || {};

      if (settings[provider] === false) {
        return { items: [], complete: false, scope: "email:off", state: prev };
      }
      /** @type {any} */
      let data;
      try {
        data = JSON.parse(String(payload.body || ""));
      } catch {
        return { items: [], complete: false, scope: "email:none", state: prev };
      }
      if (!data || !Array.isArray(data.messages)) {
        return { items: [], complete: false, scope: "email:none", state: prev };
      }

      const now = ctx.now || new Date();
      const at = payload.at || now.toISOString();

      // Folder filter: a known folder outside the allow-list yields nothing;
      // a null folder is allowed. "search" is always allowed (guided scan),
      // and while a scan runs any message view is too — the user opens queued
      // threads under whatever folder they actually live in.
      const folders = settings.folders || ["inbox"];
      const folder = data.folder == null ? null : String(data.folder).toLowerCase();
      const inFolders =
        folder == null ||
        (Array.isArray(folders) && folders.some((f) => String(f).toLowerCase() === folder));
      const scan = prev.scan;
      const scanOn = !!(
        scan &&
        scan.provider === provider &&
        Math.abs(now.getTime() - Date.parse(scan.startedAt || "")) <= SCAN_TTL_MS
      );
      const allowed = folder === "search" || inFolders || (scanOn && data.view === "message");

      /** @type {import("../../core/contract.js").Item[]} */
      const items = [];
      const msgs = data.messages.filter((m) => m && m.key);
      if (allowed) {
        for (const m of msgs) {
          items.push(
            ...itemsFromMessage(m, {
              provider,
              now,
              termCode: termCodeFor(now),
              textDates: ctx.textDates || extractDates,
              courses: ctx.courses || [],
              settings,
              applications: /** @type {any} */ (ctx).applications,
              at,
            }),
          );
        }
      }

      // Guided scan bookkeeping: a search list queues unread rows; any read
      // thread leaves the queue and is marked scanned (newest 1000 kept).
      const scanned = { ...(prev.scanned || {}) };
      /** @type {any[]} */
      let scanQueue = Array.isArray(prev.scanQueue) ? prev.scanQueue.slice() : [];
      const msgKeys = msgs.map((m) => String(m.key));
      if (data.view === "message") {
        scanQueue = scanQueue.filter((q) => !msgKeys.includes(String(q && q.key)));
        for (const k of msgKeys) scanned[k] = at;
        const ks = Object.keys(scanned);
        for (const k of ks.slice(0, Math.max(0, ks.length - SCANNED_CAP))) delete scanned[k];
      } else if (scanOn && data.view === "list" && folder === "search") {
        const queued = new Set(scanQueue.map((q) => String(q && q.key)));
        for (const m of msgs) {
          const key = String(m.key);
          if (scanned[key] || queued.has(key) || scanQueue.length >= QUEUE_CAP) continue;
          scanQueue.push({
            provider,
            key,
            subject: String(m.subject || "").slice(0, 80),
            url: scanItemUrl(provider, payload.url, key),
          });
          queued.add(key);
        }
      }

      // A single message view scopes narrowly so that message's items are
      // replaced; a list view's scope matches no item, so nothing is removed.
      const keys = new Set(msgs.map((m) => String(m.key)));
      const scope =
        allowed && data.view === "message" && keys.size === 1
          ? `email:${provider}:${[...keys][0]}`
          : `email:${provider}:list`;

      const state = {
        ...prev,
        lastSeenAt: at,
        counts: { ...(prev.counts || {}), [provider]: msgs.length },
        scanned,
        scanQueue,
      };
      return {
        items,
        complete: true,
        readOk: [scope],
        scope,
        session: "signed-in",
        state,
      };
    },
  },
};

export default adapter;
