// @ts-check
/*
  Email adapter — passive observe only (T3). OWA needs a tokened API we never
  captured and Gmail was likewise structural-only, so there are no net
  urlPatterns at all; everything arrives as a serialised DOM extract from
  content.js. "outlook" and "gmail" payloads both land here (the registry maps
  them to this adapter id).
*/

import { extractDates, termCodeFor } from "../../lib/textdates/index.js";
import { dedupeMailItems, itemsFromMessage, SENT_FOLDERS, taskItems } from "./extract.js";
import { GMAIL_SCAN_QUERY, OUTLOOK_SCAN_QUERY } from "./rules.js";

/** @typedef {import("../../core/contract.js").SyncContext} SyncContext */
/** @typedef {import("../../core/contract.js").SyncResult} SyncResult */

const SCAN_TTL_MS = 24 * 60 * 60 * 1000;
const QUEUE_CAP = 200;
const SCANNED_CAP = 1000;

/**
 * @deprecated Guided scan is superseded by the automatic backfill (see
 * backfill.js); kept only because background/index.js still dispatches the
 * UI message. Removed when W1 drops the handler.
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

/** @deprecated See startMailScan — kept for the background handler.
 *  Stop a scan; `scanned` stays so already-read threads are never requeued. @param {any} state */
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
      // threads under whatever folder they actually live in. A "backfill"
      // view is allowed whenever its folder passes the same list.
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
      const isBackfill = data.view === "backfill";
      // Sent folders only ever close reply tasks — never produce items.
      const allowed =
        !SENT_FOLDERS.has(folder || "") &&
        (folder === "search" || inFolders || (scanOn && data.view === "message"));

      /** @type {import("../../core/contract.js").Item[]} */
      const items = [];
      // List views can carry dozens of rows — bound one observation's work.
      // Atom entries key on the message id; threadMap (learned by the
      // backfill list read) resolves them to the canonical thread id so one
      // message keeps ONE id across Atom, backfill and the passive DOM.
      const tmap =
        prev.threadMap && typeof prev.threadMap === "object" ? prev.threadMap : {};
      const msgs = data.messages
        .filter((m) => m && m.key)
        .slice(0, 60)
        .map((m) =>
          data.view === "atom" ? { ...m, key: tmap[String(m.key)] || m.key } : m,
        );
      // Backfill threads carry per-message `parts` (the print view's
      // table.message rows). Expand them so the ask/answer task logic sees a
      // real thread sequence, exactly like a multi-message view.
      /** @type {{m: any, items: import("../../core/contract.js").Item[]}[]} */
      const prod = [];
      for (const m of msgs) {
        const parts =
          Array.isArray(m.parts) && m.parts.length ? m.parts.slice(0, 20) : null;
        if (!parts) {
          prod.push({ m, items: [] });
          continue;
        }
        for (const part of parts) {
          prod.push({
            m: { ...m, ...part, key: m.key, url: m.url, subject: m.subject },
            items: [],
          });
        }
      }
      if (allowed) {
        for (const p of prod) {
          p.items = itemsFromMessage(p.m, {
            provider,
            now,
            termCode: termCodeFor(now),
            textDates: ctx.textDates || extractDates,
            courses: ctx.courses || [],
            settings,
            applications: /** @type {any} */ (ctx).applications,
            at,
          });
          items.push(...p.items);
        }
      }

      // Reply-needed / book-a-call tasks + their completion (sent-folder and
      // excluded-folder views still close open tasks).
      const tasks = taskItems(
        prod,
        { view: String(data.view), folder, allowed },
        prev,
        {
          provider,
          now,
          termCode: termCodeFor(now),
          textDates: ctx.textDates || extractDates,
          courses: ctx.courses || [],
          settings,
          applications: /** @type {any} */ (ctx).applications,
          at,
        },
      );
      items.push(...tasks.items);

      // One observation can see the same thing twice: an opened invite plus
      // a "meeting link sent" mail, or two threads about one deadline.
      const seenIds = new Set();
      const deduped = dedupeMailItems(items).filter((i) => {
        if (seenIds.has(i.id)) return false;
        seenIds.add(i.id);
        return true;
      });

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
      // replaced; a list view's scope matches no item, so nothing is
      // removed. The Atom feed scopes as `email:gmail:atom` — likewise no
      // item's seenIn scope ever matches it, so an entry leaving the unread
      // feed can never delete its item. Backfill batches scope as
      // `email:<provider>:backfill`; EVERY listed message in a sent batch
      // also re-reads its own `email:<provider>:<key>` scope, so a re-read
      // under current rules drops items/tasks it no longer produces. Those
      // per-message scopes go in `replaceScopes`, NOT `readOk`: readOk
      // entries land in scopeOkAt/scopeReadAt, which are capped at 50 per
      // source, and a 50-message batch would evict `email:<provider>:list`
      // and `email:<provider>:backfill` — the scopes the checklist rows
      // track. (A payload only ever contains fully processed rows — an
      // aborted page is never sent — and needsBody is deterministic per
      // row+settings, so a still-gated row got its body this pass too.)
      const keys = new Set(msgs.map((m) => String(m.key)));
      const scope =
        data.view === "atom"
          ? `email:${provider}:atom`
          : isBackfill
            ? `email:${provider}:backfill`
            : allowed && data.view === "message" && keys.size === 1
              ? `email:${provider}:${[...keys][0]}`
              : `email:${provider}:list`;
      const readOk = [scope];
      /** Extra scopes this read replaces. Pending W1: applyResult's "scope"
       * mode doesn't read `replaceScopes` yet, so until it does a backfill
       * re-read is additive (items a message no longer produces stay, like
       * the list/Atom reads); once wired, per-message scopes replace. */
      const replaceScopes = isBackfill
        ? [...new Set(msgs.map((m) => `email:${provider}:${String(m.key)}`))]
        : undefined;

      // Backfill bookkeeping: threadMap (lastMessageId -> threadId, newest
      // 2000) feeds the Atom id mapping; the `final` batch's marker becomes
      // state.backfill[provider], which the content script's scheduler and
      // the Setup status line both read.
      let threadMap = prev.threadMap;
      if (isBackfill && data.threadMap && typeof data.threadMap === "object") {
        const merged = { ...threadMap, ...data.threadMap };
        const ks = Object.keys(merged);
        if (ks.length > 2000) for (const k of ks.slice(0, ks.length - 2000)) delete merged[k];
        threadMap = merged;
      }
      /** @type {any} */
      let backfillState = prev.backfill;
      const bf = isBackfill ? data.backfill : null;
      // A replay (in-memory cache after a filter change) never touches
      // state.backfill — it would fake a fresh lookbackDays and retrigger
      // a full.
      if (bf && bf.final && !bf.replay) {
        const pb = ((prev.backfill || {})[provider] || {});
        // The cursor: the run's own newest receivedAt wins, else the prior
        // one stays; a first run that saw no mail at all seeds from the
        // run's START time (an empty 30 days is still "read").
        const markerNewest = Date.parse(bf.newestAt || "") || 0;
        const msgsNewest = msgs
          .map((m) => Date.parse(m.receivedAt || "") || 0)
          .reduce((a, b) => Math.max(a, b), 0);
        const prevNewest = Date.parse(pb.newestAt || "") || 0;
        const runStart = Date.parse(bf.runStartedAt || "") || 0;
        const resolved =
          Math.max(markerNewest, msgsNewest, prevNewest) ||
          prevNewest ||
          runStart ||
          Date.parse(at) ||
          0;
        backfillState = {
          ...(prev.backfill || {}),
          [provider]: {
            // v:2 — entries stamped by the old ruleset count as never-ran
            // (the content script's decideRun treats a missing v:2 like a
            // lookback increase: one full, still 6 h apart).
            v: 2,
            lastRunAt: at,
            lastFullAt: bf.full ? at : pb.lastFullAt || at,
            lookbackDays: bf.lookbackDays,
            checked: bf.checked,
            newestAt: new Date(resolved).toISOString(),
          },
        };
      }

      const state = {
        ...prev,
        lastSeenAt: at,
        counts: { ...(prev.counts || {}), [provider]: msgs.length },
        scanned,
        scanQueue,
        ...(Object.keys(tasks.replies).length ? { replies: tasks.replies } : {}),
        ...(Object.keys(tasks.bookings).length ? { bookings: tasks.bookings } : {}),
        ...(threadMap ? { threadMap } : {}),
        ...(backfillState ? { backfill: backfillState } : {}),
      };
      return {
        items: deduped,
        complete: true,
        readOk,
        scope,
        ...(replaceScopes ? { replaceScopes } : {}),
        // No session on a successful read: the scheduler only refreshes
        // lastOkAt/itemCount/complete when `session` is absent.
        state,
      };
    },
  },
};

export default adapter;
