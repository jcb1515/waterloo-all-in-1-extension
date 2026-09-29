// @ts-check
/*
  Email adapter — passive observe only (T3). OWA needs a tokened API we never
  captured and Gmail was likewise structural-only, so there are no net
  urlPatterns at all; everything arrives as a serialised DOM extract from
  content.js. "outlook" and "gmail" payloads both land here (the registry maps
  them to this adapter id).
*/

import { extractDates, termCodeFor } from "../../lib/textdates/index.js";
import { CHECK_TIMEOUT_MS } from "../../core/messages.js";
import { dedupeMailItems, itemsFromMessage, SENT_FOLDERS, taskItems } from "./extract.js";

/* ---- REMINDER/FW subject-normalised merge ------------------------------- */

/**
 * A subject stripped of list tags and re/fw/reminder prefixes —
 * "[List] REMINDER - FW: Foo" and "Foo" normalise equal.
 * @param {any} s
 */
export const normMailSubject = (s) => {
  let t = String(s || "");
  for (;;) {
    const u = t
      .replace(/^\s*\[[^\]]*\]\s*/, "")
      .replace(/^\s*(?:re|fw|fwd|reminder)\b\s*[-:]?\s*/i, "");
    if (u === t) break;
    t = u;
  }
  return t.replace(/\s+/g, " ").trim().toLowerCase();
};

const MAIL_ID_RE = /:mail:/;
const mailInstant = (/** @type {any} */ i) => i.startAt || i.dueAt || null;

/** Newest 500 subjectDup entries per provider (by message receivedAt). */
const SUBJECT_DUP_CAP = 500;
const capSubjectDup = (/** @type {Record<string, any>} */ map) => {
  const ks = Object.keys(map);
  if (ks.length <= SUBJECT_DUP_CAP) return map;
  const recv = (k) => Date.parse(String((map[k] || {}).receivedAt || "")) || 0;
  for (const k of ks.sort((a, b) => recv(b) - recv(a)).slice(SUBJECT_DUP_CAP)) {
    delete map[k];
  }
  return map;
};

/**
 * One pass of the subject-normalised merge over one parse's items, with
 * the cross-payload `subjectDup` ledger. Two `:mail:` items merge only when
 * provider + type + resolved instant (startAt or dueAt, exactly) +
 * normalised source-message subject all agree; the earliest-received
 * message's item keeps its id and the losers' message keys land in
 * meta.mergedFrom. Returns {items, subjectDup, touched}.
 * @param {any[]} items
 * @param {Map<string, any>} msgByKey
 * @param {string} provider
 * @param {Record<string, {key: string, receivedAt?: string, type?: string, mergedFrom?: string[]}>} subjectDup
 * @param {string} at
 */
function mergeSubjectDups(items, msgByKey, provider, subjectDup, at) {
  /** @type {{entry: any, group: any[]|null}[]} */
  const rows = [];
  const groups = new Map();
  for (const it of items) {
    const mKey = String((it.meta && it.meta.messageKey) || "");
    const m = mKey ? msgByKey.get(mKey) : null;
    const inst = mailInstant(it);
    const norm = m ? normMailSubject(m.subject) : "";
    if (!it || !MAIL_ID_RE.test(String(it.id)) || !inst || !norm) {
      rows.push({ entry: it, group: null });
      continue;
    }
    const sig = `${it.type}|${norm}|${inst}`;
    let g = groups.get(sig);
    if (!g) groups.set(sig, (g = []));
    const e = {
      it,
      mKey,
      recv: Date.parse(String(m.receivedAt || "")) || Infinity,
      norm,
      inst,
    };
    g.push(e);
    rows.push({ entry: e, group: g });
  }
  /** Emit one item per group: the earliest-received message's item wins,
   * re-keyed under the ledger's canonical id when one already exists. */
  const emitGroup = (/** @type {any[]} */ g) => {
    const type = g[0].it.type;
    const inst = g[0].inst;
    const sigKey = `${g[0].norm}|${inst}`;
    const rec = subjectDup[sigKey];
    /** @type {string|null} */
    let canonKey = null;
    let canonRecv = Infinity;
    if (rec && (!rec.type || rec.type === type)) {
      canonKey = String(rec.key || "") || null;
      canonRecv = Date.parse(String(rec.receivedAt || "")) || Infinity;
    }
    for (const e of g) {
      if (e.recv < canonRecv) {
        canonKey = e.mKey;
        canonRecv = e.recv;
      }
    }
    const survE =
      g.find((e) => e.mKey === canonKey) ||
      [...g].sort((a, b) => a.recv - b.recv)[0];
    const surv = {
      ...survE.it,
      id: `${provider}:mail:${canonKey}:${inst}`,
      meta: { ...(survE.it.meta || {}) },
    };
    // The source subject rides on meta so a merged item still tells you
    // which message produced it.
    const survMsg = msgByKey.get(survE.mKey);
    if (survMsg && surv.meta.subject === undefined) {
      surv.meta.subject = String(survMsg.subject || "");
    }
    // Union every copy's seenIn (rewritten to the canonical id) plus the
    // canonical message's own scope, so a re-read of any one copy keeps
    // the merged item alive.
    const scopeSeen = new Set();
    /** @type {any[]} */
    const seen = [];
    const idKey = surv.id.replace(new RegExp(`^${provider}:`), "");
    for (const e of g) {
      for (const s of e.it.seenIn || []) {
        if (!s || !s.scope || scopeSeen.has(String(s.scope))) continue;
        scopeSeen.add(String(s.scope));
        seen.push({ ...s, key: idKey });
      }
    }
    const canonScope = `email:${provider}:${canonKey}`;
    if (!scopeSeen.has(canonScope)) {
      seen.push({ source: provider, key: idKey, scope: canonScope, at });
    }
    if (seen.length) surv.seenIn = seen;
    const mergedFrom = new Set(
      /** @type {any[]} */ ((survE.it.meta && survE.it.meta.mergedFrom) || []),
    );
    // The ledger's mergedFrom survives a later solo re-read of the
    // canonical message.
    for (const k of (rec && rec.mergedFrom) || []) {
      if (k !== canonKey) mergedFrom.add(k);
    }
    const threads = new Set([
      ...((surv.meta && surv.meta.threads) || []),
      surv.evidence && surv.evidence.url,
    ].filter(Boolean));
    for (const e of g) {
      if (e.mKey !== canonKey) mergedFrom.add(e.mKey);
      for (const k of (e.it.meta && e.it.meta.mergedFrom) || []) {
        if (k !== canonKey) mergedFrom.add(k);
      }
      for (const t of (e.it.meta && e.it.meta.threads) || []) threads.add(t);
      if (e.it.evidence && e.it.evidence.url) threads.add(e.it.evidence.url);
    }
    if (mergedFrom.size) surv.meta.mergedFrom = [...mergedFrom].sort();
    if (threads.size) surv.meta.threads = [...threads];
    const canonIso = Number.isFinite(canonRecv)
      ? new Date(canonRecv).toISOString()
      : undefined;
    if (
      canonKey &&
      (!rec ||
        rec.key !== canonKey ||
        rec.type !== type ||
        rec.receivedAt !== canonIso)
    ) {
      subjectDup[sigKey] = {
        key: canonKey,
        receivedAt: canonIso,
        type,
        ...(mergedFrom.size ? { mergedFrom: [...mergedFrom].sort() } : {}),
      };
      return { item: surv, touched: true };
    }
    return { item: surv, touched: false };
  };
  /** @type {any[]} */
  const out = [];
  const emitted = new Set();
  let touched = false;
  for (const r of rows) {
    if (!r.group) {
      out.push(r.entry);
      continue;
    }
    if (emitted.has(r.group)) continue;
    emitted.add(r.group);
    const { item, touched: t } = emitGroup(r.group);
    out.push(item);
    touched = touched || t;
  }
  return { items: out, touched };
}

/** @typedef {import("../../core/contract.js").SyncContext} SyncContext */
/** @typedef {import("../../core/contract.js").SyncResult} SyncResult */

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
      // a null folder is allowed. "search" is allowed too — the passive
      // reader still watches a search page the user opened themselves. A
      // "backfill" view is allowed whenever its folder passes the same list.
      const folders = settings.folders || ["inbox"];
      const folder = data.folder == null ? null : String(data.folder).toLowerCase();
      const inFolders =
        folder == null ||
        (Array.isArray(folders) && folders.some((f) => String(f).toLowerCase() === folder));
      const isBackfill = data.view === "backfill";
      // Sent folders only ever close reply tasks — never produce items.
      const allowed =
        !SENT_FOLDERS.has(folder || "") && (folder === "search" || inFolders);

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

      // A re-sent copy (REMINDER/FW/…) under a different message key is the
      // same thing: merge same provider+type+exact instant+normalised
      // subject, earliest-received message keeping the id. Runs before
      // dedupeMailItems (its titleScore winner can pick the later copy).
      // subjectDup[provider] carries the winner across payloads — a later
      // batch's copy is re-emitted under the canonical id.
      const msgByKey = new Map(msgs.map((m) => [String(m.key), m]));
      const subjectDup = {
        ...(((prev.subjectDup || {})[provider]) || {}),
      };
      const subj = mergeSubjectDups(items, msgByKey, provider, subjectDup, at);

      // One observation can see the same thing twice: an opened invite plus
      // a "meeting link sent" mail, or two threads about one deadline.
      const seenIds = new Set();
      const deduped = dedupeMailItems(subj.items).filter((i) => {
        if (seenIds.has(i.id)) return false;
        seenIds.add(i.id);
        return true;
      });

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
      // A bodySkipped row was re-derived from its preview only — its
      // per-message scope must NOT replace, or the items its last body
      // read produced would drop and (sig unchanged / budget cut) never
      // come back. Same additive treatment as list/Atom reads.
      const replaceScopes = isBackfill
        ? [
            ...new Set(
              msgs
                .filter((m) => !m.bodySkipped)
                .map((m) => `email:${provider}:${String(m.key)}`),
            ),
          ]
        : undefined;

      // Backfill bookkeeping: threadMap (lastMessageId -> threadId, newest
      // 2000) feeds the Atom id mapping; the `check` marker drives
      // state.check[provider] below.
      let threadMap = prev.threadMap;
      if (isBackfill && data.threadMap && typeof data.threadMap === "object") {
        const merged = { ...threadMap, ...data.threadMap };
        const ks = Object.keys(merged);
        if (ks.length > 2000) for (const k of ks.slice(0, ks.length - 2000)) delete merged[k];
        threadMap = merged;
      }
      // Body-read signatures: the thread/message revision each fetched
      // body was read at — the content script's next run skips a body
      // fetch while this matches (Gmail last-message-id, Outlook message
      // Id). Newest 2000 per provider, same cap shape as threadMap.
      let bodyRead = prev.bodyRead;
      if (isBackfill) {
        const cur = (((prev.bodyRead || {})[provider]) || {});
        /** @type {Record<string, string>} */
        const next = { ...cur };
        let touched = false;
        for (const m of msgs) {
          if (m && m.bodyFetched && m.sig) {
            next[String(m.key)] = String(m.sig);
            touched = true;
          }
        }
        if (touched) {
          const ks = Object.keys(next);
          if (ks.length > 2000) for (const k of ks.slice(0, ks.length - 2000)) delete next[k];
          bodyRead = { ...(prev.bodyRead || {}), [provider]: next };
        }
      }

      /** @type {any} */
      let checkState = prev.check;
      const chk = isBackfill ? data.check : null;
      // A replay (in-memory cache after a filter change) never touches
      // state.check — it re-extracts the same rows, not a real read.
      // Batches update `running` (Setup's "Checking… N so far"); the final
      // marker stamps {at, checked, ok, reason?} — the content script's
      // 30-min gate and the Setup status line both read `at`.
      if (chk && !chk.replay) {
        let cur = ((prev.check || {})[provider]) || {};
        // A `running` from a DIFFERENT, older-than-timeout run never
        // finished (stale tab, dead worker) — close it as a timeout
        // before this run's marker lands, keeping the last real result.
        const runSince = cur.running && String(cur.running.since || "");
        if (
          runSince &&
          runSince !== String(chk.since || "") &&
          now.getTime() - (Date.parse(runSince) || 0) > CHECK_TIMEOUT_MS
        ) {
          const { running: _running, ...rest } = cur;
          cur = { ...rest, ok: false, reason: "timeout" };
        }
        const next = chk.final
          ? {
              at,
              checked: Number(chk.checked) || 0,
              ok: chk.ok !== false,
              ...(chk.reason ? { reason: String(chk.reason) } : {}),
            }
          : {
              ...cur,
              running: {
                since: String(chk.since || at),
                checked: Number(chk.checked) || 0,
              },
            };
        checkState = { ...(prev.check || {}), [provider]: next };
      }

      /** @type {Record<string, any>} */
      const state = {
        ...prev,
        lastSeenAt: at,
        counts: { ...(prev.counts || {}), [provider]: msgs.length },
        ...(Object.keys(tasks.replies).length ? { replies: tasks.replies } : {}),
        ...(Object.keys(tasks.bookings).length ? { bookings: tasks.bookings } : {}),
        ...(threadMap ? { threadMap } : {}),
        ...(bodyRead ? { bodyRead } : {}),
        ...(checkState ? { check: checkState } : {}),
        ...(subj.touched || prev.subjectDup
          ? {
              subjectDup: {
                ...(prev.subjectDup || {}),
                [provider]: capSubjectDup(subjectDup),
              },
            }
          : {}),
      };
      // Dead state from the retired guided scan and the v:2 lookback
      // scheduler: dropped on the next write.
      delete state.scan;
      delete state.scanQueue;
      delete state.scanned;
      delete state.backfill;
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
