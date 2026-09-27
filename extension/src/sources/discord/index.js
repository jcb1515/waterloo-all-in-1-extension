// @ts-check
// Discord adapter (Window 3, co-op stream) — PASSIVE ONLY.
//
// Hard rules:
//   - NEVER send a request to Discord: no fetch/XHR/web-socket anywhere in
//     this source. All data arrives as ObservedPayloads (REST responses
//     forwarded by the recorder, DOM extracts from content.js).
//   - NEVER read or store the user's token: no page-storage/cookie access,
//     no webpack-module digging.
//   - Never navigate or click anything.
//   - Message bodies are never persisted — only ≤300-char snippets on
//     derived items. No author ids except the user's own inferred selfId.
//
// Everything funnels into state.lastGood.messages keyed per message id and
// is filtered to watched channels only at output time, so the adapter is
// authoritative under the single scope "discord".

import { OBSERVE_URL_PATTERNS } from "./selectors.js";
import {
  SERVERS,
  serverFor,
  watchForGuild,
  channelScore,
  MEETING_WORDS,
  wordTrigger,
} from "./rules.js";
import {
  SOURCE,
  SCOPE,
  normalizeRestBody,
  stripMarkup,
  candidatesForMessage,
  domMessageToRest,
} from "./messages.js";
import { inferIdentity } from "./identity.js";
import { meetingKey, textWeeklyHint, recurringSuggestions } from "./recurring.js";

/** @typedef {import("../../core/contract.js").SyncResult} SyncResult */
/** @typedef {import("../../core/contract.js").ObservedPayload} ObservedPayload */

const DAY_MS = 24 * 60 * 60 * 1000;
const MSG_AGE_DAYS = 45;
const MSG_CAP = 600;
const DM_CAP = 500;
const MEETING_LOG_CAP = 300;
const MEETING_LOG_AGE_DAYS = 120;
/** Items in a channel the inventory hasn't mapped yet expire quickly. */
const UNMAPPED_AGE_DAYS = 2;

const firstLine = (s) =>
  String(s || "").split("\n")[0].replace(/\s+/g, " ").trim();

const anchorMs = (item) =>
  Date.parse(item?.endAt || item?.startAt || item?.dueAt || "");

/** Snowflake range compare — Discord ids exceed 2^53, so BigInt. */
function snowflakeGT(a, b) {
  try {
    return BigInt(a) > BigInt(b);
  } catch {
    return String(a) > String(b);
  }
}
function snowflakeLT(a, b) {
  try {
    return BigInt(a) < BigInt(b);
  } catch {
    return String(a) < String(b);
  }
}

/**
 * channelId -> {guildId, channel} via the inventory index.
 * @param {Record<string, any>} state @param {string} channelId
 */
function locateChannel(state, channelId) {
  for (const [guildId, g] of Object.entries(state.guilds || {})) {
    const c = g?.channels?.[channelId];
    if (c) return { guildId, channel: c };
  }
  return null;
}

/**
 * Watched guilds: SERVERS matches plus settings.watched additions.
 * @returns {Record<string, {team: string, focus: string[], settings?: any}>}
 */
function watchedGuilds(state, settings) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [guildId, g] of Object.entries(state.guilds || {})) {
    const srv = serverFor(g?.name || "", settings?.watched);
    if (srv) out[guildId] = srv;
  }
  return out;
}

/** Guild's position in SERVERS order (unknown guilds sort last). */
function guildOrder(state, guildId) {
  const lower = String(state.guilds?.[guildId]?.name || "").trim().toLowerCase();
  const i = SERVERS.findIndex((s) =>
    s.names.some((n) => n.trim().toLowerCase() === lower)
  );
  return i === -1 ? SERVERS.length : i;
}

/**
 * Drop stale/capped items; unmapped-channel items expire fast.
 * @param {any[]} items @param {Record<string, any>} state @param {number} nowMs
 */
function pruneMessageItems(items, state, nowMs) {
  const stale = nowMs - MSG_AGE_DAYS * DAY_MS;
  const unmapped = nowMs - UNMAPPED_AGE_DAYS * DAY_MS;
  const kept = (items || []).filter((item) => {
    const anchor = anchorMs(item);
    if (!Number.isNaN(anchor) && anchor < stale) return false;
    const seenAt = Date.parse(item?.seenIn?.[0]?.at || "") || nowMs;
    if (
      !locateChannel(state, item?.meta?.channelId) &&
      !(item?.meta?.guildId && state.guilds?.[item.meta.guildId]) &&
      seenAt < unmapped
    ) {
      return false;
    }
    return true;
  });
  if (kept.length <= MSG_CAP) return kept;
  const ranked = kept
    .map((item, i) => ({ item, i, anchor: anchorMs(item) }))
    .sort((a, b) => a.anchor - b.anchor || a.i - b.i);
  const drop = new Set(ranked.slice(0, kept.length - MSG_CAP).map((r) => r.i));
  return kept.filter((_, i) => !drop.has(i));
}

/**
 * Fold fresh candidates into lastGood.messages: a re-read message replaces
 * its own items (edits), then prune/cap. The DOM path produces the same ids
 * as REST but weaker titles/snippets — a DOM read of a message that already
 * has REST-derived items only replaces them when the derived id set differs
 * (the date changed, i.e. an edit). REST always wins.
 */
function accumulateMessages(prevItems, freshItems, messageIds, state, nowMs, via) {
  const present = new Set((messageIds || []).filter(Boolean));
  /** @type {Map<string, Set<string>>} */
  const freshIdsByMsg = new Map();
  for (const item of freshItems || []) {
    const mid = String(item?.meta?.messageId || "");
    const set = freshIdsByMsg.get(mid) || new Set();
    set.add(item.id);
    freshIdsByMsg.set(mid, set);
  }
  // DOM reads that derive the identical ids leave REST items in place.
  const keepRest = new Set();
  const kept = (prevItems || []).filter((item) => {
    const mid = String(item?.meta?.messageId || "");
    if (!present.has(mid)) return true;
    if (via === "dom" && item?.meta?.via === "rest") {
      const oldIds = new Set(
        (prevItems || [])
          .filter((p) => String(p?.meta?.messageId || "") === mid)
          .map((p) => p.id)
      );
      const newIds = freshIdsByMsg.get(mid) || new Set();
      if (
        oldIds.size === newIds.size &&
        [...oldIds].every((id) => newIds.has(id))
      ) {
        keepRest.add(mid);
        return true;
      }
    }
    return false;
  });
  const combined = [
    ...kept,
    ...(freshItems || []).filter(
      (item) => !keepRest.has(String(item?.meta?.messageId || ""))
    ),
  ];
  return pruneMessageItems(combined, state, nowMs);
}

/**
 * Record channel read stats: messagesSeen counts snowflakes outside the
 * seen range, which then widens; datesFound counts produced items.
 */
function updateChannelStats(channelRec, messages, itemCount) {
  for (const m of messages || []) {
    const id = String(m?.id || m?.messageId || "");
    if (!/^\d+$/.test(id)) continue;
    if (
      channelRec.oldestSeenId === undefined ||
      channelRec.newestSeenId === undefined ||
      snowflakeLT(id, channelRec.oldestSeenId) ||
      snowflakeGT(id, channelRec.newestSeenId)
    ) {
      channelRec.messagesSeen = (channelRec.messagesSeen || 0) + 1;
      if (
        channelRec.oldestSeenId === undefined ||
        snowflakeLT(id, channelRec.oldestSeenId)
      ) {
        channelRec.oldestSeenId = id;
      }
      if (
        channelRec.newestSeenId === undefined ||
        snowflakeGT(id, channelRec.newestSeenId)
      ) {
        channelRec.newestSeenId = id;
      }
    }
  }
  channelRec.datesFound = (channelRec.datesFound || 0) + itemCount;
}

/**
 * Shared message pipeline for REST bodies and DOM message extracts.
 * @param {Record<string, any>} state
 * @param {any[]} messages REST-shaped messages (domMessageToRest output ok)
 * @param {{channelId?: string, guildId?: string, fromMentions?: boolean,
 *   via?: "rest"|"dom"}} src
 * @param {import("../../core/contract.js").SyncContext} ctx
 * @param {number} nowMs @param {string} nowIso @param {string} at
 */
function ingestMessages(state, messages, src, ctx, nowMs, nowIso, at) {
  const settings = ctx.settings || {};
  const selfId = settings.userId || state.identity?.selfId;
  const roleIds = [
    ...new Set([...(state.identity?.roleIds || []), ...(settings.roleIds || [])]),
  ];
  const dmSet = new Set(state.dmChannels || []);
  /** @type {any[]} */
  const fresh = [];
  const seenIds = [];
  /** @type {Map<string, {msgs: any[], items: number}>} */
  const stats = new Map();

  for (const msg of messages || []) {
    const channelId = String(msg?.channel_id || src.channelId || "");
    if (!channelId || !msg?.id) continue;
    if (dmSet.has(channelId)) continue; // DM channels: never stored
    seenIds.push(String(msg.id));

    const loc = locateChannel(state, channelId);
    const guildId = loc?.guildId || msg?.guild_id || src.guildId;
    const guild = guildId ? state.guilds?.[guildId] : null;
    const srv = guild ? serverFor(guild.name, settings.watched) : null;
    const watch = guildId ? state.watch?.[guildId] : null;
    const watched = Boolean(watch?.channelIds?.includes(channelId));

    const items = candidatesForMessage(msg, {
      extractDates: ctx.textDates,
      selfId,
      roleIds,
      keywords: settings.keywords,
      fromMentions: src.fromMentions === true,
      watched,
      guildId,
      channelId,
      channelName: loc?.channel?.name,
      team: srv?.team,
      via: src.via,
      nowIso,
    });
    fresh.push(...items);

    // Meeting cadence: log timed meeting items, plus explicit weekly hints.
    for (const item of items) {
      if (item.type === "meeting" && item.startAt && !item.allDay) {
        pushMeetingLog(state, {
          guildId, channelId,
          messageId: String(msg.id),
          key: meetingKey(item.title),
          startAt: item.startAt, endAt: item.endAt,
          url: item.url, at,
        });
      }
    }
    const stripped = stripMarkup(msg.content);
    if (wordTrigger(stripped, MEETING_WORDS)) {
      const hint = textWeeklyHint(stripped);
      if (hint) {
        pushMeetingLog(state, {
          guildId, channelId,
          messageId: String(msg.id),
          key: meetingKey(firstLine(stripped)),
          url: guildId
            ? `https://discord.com/channels/${guildId}/${channelId}/${msg.id}`
            : undefined,
          at,
          fromText: true,
          weekday: hint.weekday,
          hhmm: `${String(hint.h).padStart(2, "0")}:${String(hint.mi).padStart(2, "0")}`,
        });
      }
    }

    if (loc) {
      const s = stats.get(channelId) || { msgs: [], items: 0 };
      s.msgs.push(msg);
      s.items += items.length;
      stats.set(channelId, s);
    }
  }

  // Channel stats after the pass (keep counts whole per message).
  for (const [channelId, s] of stats) {
    const loc = locateChannel(state, channelId);
    if (loc) updateChannelStats(loc.channel, s.msgs, s.items);
  }

  // Purge anything ever produced from a DM channel.
  const prevItems = (state.lastGood.messages?.items || []).filter(
    (item) => !dmSet.has(String(item?.meta?.channelId || ""))
  );
  state.lastGood.messages = {
    items: accumulateMessages(prevItems, fresh, seenIds, state, nowMs, src.via || "rest"),
    at,
  };
}

/**
 * Append to meetingLog, replacing any earlier entry from the same message
 * (channelId + messageId + fromText) — re-reads and REST/DOM doubles don't
 * churn the cap. Entries older than MEETING_LOG_AGE_DAYS drop out.
 */
function pushMeetingLog(state, entry) {
  const cutoff = Date.parse(entry.at || "") - MEETING_LOG_AGE_DAYS * DAY_MS;
  const log = (state.meetingLog || []).filter(
    (e) =>
      (!Number.isFinite(cutoff) || Date.parse(e?.at || "") >= cutoff) &&
      !(
        entry.messageId &&
        e.channelId === entry.channelId &&
        e.messageId === entry.messageId &&
        Boolean(e.fromText) === Boolean(entry.fromText)
      )
  );
  log.push(entry);
  state.meetingLog = log.slice(-MEETING_LOG_CAP);
}

/**
 * Stored items -> output items: only watched-guild channels, and within a
 * guild only watched channels / messages that pinged me — or everything
 * while the guild has no channel inventory yet. guildId/url/org/location
 * are re-resolved from the current index.
 */
function outputItems(state, settings, nowMs, nowIso) {
  const watched = watchedGuilds(state, settings);
  const items = [];
  for (const item of state.lastGood?.messages?.items || []) {
    const chanId = String(item?.meta?.channelId || "");
    const loc = locateChannel(state, chanId);
    const guildId = loc?.guildId || item?.meta?.guildId;
    const guild = guildId ? state.guilds?.[guildId] : null;
    const srv = guildId ? watched[guildId] : null;
    if (!srv) continue; // unmapped or unwatched guild — hidden
    const watch = state.watch?.[guildId];
    const channelWatched = Boolean(watch?.channelIds?.includes(chanId));
    const noInventory = !guild?.lastInventoryAt;
    if (!channelWatched && !item.meta?.assignedToMe && !noInventory) continue;
    items.push({
      ...item,
      org: srv.team || item.org,
      url: guildId
        ? `https://discord.com/channels/${guildId}/${chanId}/${item.meta.messageId}`
        : item.url,
      location:
        item.location && !item.location.startsWith("#")
          ? item.location
          : loc?.channel?.name
            ? `#${loc.channel.name}`
            : item.location,
      meta: { ...item.meta, guildId },
    });
  }
  const recurring = recurringSuggestions(state.meetingLog || [], {
    nowMs,
    nowIso,
    teamOf: (gid) => watched[gid]?.team,
  });
  return items.concat(recurring);
}

/**
 * Recompute watch lists, sweep queue and unread summaries after an
 * inventory (or watch-relevant settings) change.
 */
function recomputeWatch(state, settings, nowIso) {
  if (!state.sweep) state.sweep = { startedAt: nowIso, done: {} };
  const watched = watchedGuilds(state, settings);
  /** @type {any[]} */
  const queue = [];
  /** @type {any[]} */
  const unreadWatched = [];
  /** @type {any[]} */
  const unreadGuilds = [];
  for (const [guildId, g] of Object.entries(state.guilds || {})) {
    const srv = watched[guildId];
    if (!srv) continue;
    const watch = watchForGuild(g, srv.focus, srv.settings);
    state.watch[guildId] = watch;
    g.team = srv.team;
    g.focus = srv.focus;
    if (g.unread || g.mentions) {
      unreadGuilds.push({ guildId, name: g.name, mentions: g.mentions || 0 });
    }
    const orderBase = guildOrder(state, guildId);
    for (const channelId of watch.channelIds) {
      const c = g.channels?.[channelId];
      const url = `https://discord.com/channels/${guildId}/${channelId}`;
      if (c && (c.unread || c.mentions)) {
        unreadWatched.push({
          guildId, guildName: g.name, channelId,
          name: c.name, url, mentions: c.mentions || 0,
        });
      }
      if (!state.sweep.done[channelId]) {
        queue.push({
          guildId, guildName: g.name, channelId,
          name: c?.name || channelId, url,
          order: orderBase,
          score: c ? channelScore(c, srv.focus) : 0,
          chOrder: c?.order ?? 0,
        });
      }
    }
  }
  queue.sort((a, b) => a.order - b.order || b.score - a.score || a.chOrder - b.chOrder);
  state.sweepQueue = queue.map(({ order, score, chOrder, ...rest }) => rest);
  state.unreadWatched = unreadWatched;
  state.unreadGuilds = unreadGuilds;
}

/**
 * Restart the reading sweep (all watched channels become "not done"). (all watched channels become "not done").
 * Pure helper for W1's future "Start sweep" button.
 * @param {Record<string, any>} state @param {Date|string} now
 */
export function resetSweep(state, now) {
  const iso = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  if (state) state.sweep = { startedAt: iso, done: {} };
  return state;
}

/**
 * The tuning report: what we see, what's watched, why. No people ids, no
 * message text.
 * @param {Record<string, any>} state
 */
export function inventoryReport(state) {
  const guilds = [];
  for (const [guildId, g] of Object.entries(state?.guilds || {})) {
    const watch = state?.watch?.[guildId];
    const focus = g?.focus || [];
    guilds.push({
      name: g?.name,
      team: g?.team || null,
      watchedFrom: watch?.from || null,
      channels: Object.entries(g?.channels || {}).map(([id, c]) => ({
        name: c?.name,
        category: c?.category,
        type: c?.type,
        limited: c?.limited || false,
        score: channelScore(c || {}, focus),
        suggested: watch?.from === "suggested" && watch.channelIds.includes(id),
        watched: Boolean(watch?.channelIds?.includes(id)),
        messagesSeen: c?.messagesSeen || 0,
        datesFound: c?.datesFound || 0,
      })),
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    guilds,
    identity: {
      selfIdKnown: Boolean(state?.identity?.selfId),
      roleCount: (state?.identity?.roleIds || []).length,
    },
  };
}

/** @type {import("../../core/contract.js").Adapter} */
export default {
  id: SOURCE,
  label: "Discord",
  origins: ["https://discord.com"],
  intervalMinutes: 0,
  syncOnTabOpen: false,

  /**
   * No requests to Discord — sync only returns the cached filtered union.
   * @param {import("../../core/contract.js").SyncContext} ctx
   */
  async sync(ctx) {
    const prev = ctx.state && typeof ctx.state === "object" ? ctx.state : {};
    const now = ctx.now || new Date();
    const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
    const nowIso = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const state = {
      ...prev,
      guilds: JSON.parse(JSON.stringify(prev.guilds || {})),
      lastGood: { ...prev.lastGood },
      watch: { ...prev.watch },
    };
    if (prev.sweep) {
      state.sweep = {
        startedAt: prev.sweep.startedAt,
        done: { ...(prev.sweep.done || {}) },
      };
    }
    // Settings may have changed since the last inventory — re-resolve watch.
    recomputeWatch(state, ctx.settings || {}, nowIso);
    const items =
      ctx.settings?.enabled === false
        ? []
        : outputItems(state, ctx.settings || {}, nowMs, nowIso);
    return { items, complete: false, session: "no-tab", state };
  },

  observe: {
    urlPatterns: [...OBSERVE_URL_PATTERNS],
    /**
     * @param {ObservedPayload} payload
     * @param {import("../../core/contract.js").SyncContext} ctx
     * @returns {Promise<SyncResult & {scope: string}>}
     */
    async parse(payload, ctx) {
      const prev = ctx.state && typeof ctx.state === "object" ? ctx.state : {};
      const settings = ctx.settings || {};
      const now = ctx.now || new Date();
      const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
      const nowIso = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
      /** @type {Record<string, any>} */
      const state = {
        ...prev,
        // Nested channel records get mutated (stats, inventory merge) — the
        // guilds map needs a real copy, not a shared reference.
        guilds: JSON.parse(JSON.stringify(prev.guilds || {})),
        lastGood: { ...(prev.lastGood || {}) },
        watch: { ...(prev.watch || {}) },
      };
      if (prev.sweep) {
        state.sweep = {
          startedAt: prev.sweep.startedAt,
          done: { ...(prev.sweep.done || {}) },
        };
      }
      state.lastSeenAt = payload.at;

      /** @type {SyncResult & {scope: string}} */
      const result = {
        items: [],
        complete: false,
        scope: SCOPE,
        state,
      };
      const finish = () => {
        // Settings (watched/userId/roleIds/keywords) can change between
        // payloads — re-resolve watch before filtering output. Existing
        // sweeps keep their startedAt.
        recomputeWatch(state, settings, nowIso);
        result.items =
          settings.enabled === false ? [] : outputItems(state, settings, nowMs, nowIso);
        return result;
      };

      if (settings.enabled === false) return finish();

      if (payload.kind === "net") {
        const method = String(payload.method || "GET").toUpperCase();
        if (method !== "GET") return finish();
        if (payload.status === 401) {
          state.signedOutAt = payload.at;
          result.session = "signed-out";
          return finish();
        }
        if (!(payload.status >= 200 && payload.status < 300)) return finish();
        const norm = normalizeRestBody(payload.url, payload.body);
        if (norm.kind === "mentions") {
          state.identity = inferIdentity(prev.identity, norm.messages, settings);
        }
        if (norm.kind === "channel" && norm.channelId) {
          // A history read after the sweep started closes that channel.
          if (!state.sweep) state.sweep = { startedAt: payload.at, done: {} };
          if (
            !state.sweep.done[norm.channelId] &&
            Date.parse(payload.at || "") >= Date.parse(state.sweep.startedAt || "")
          ) {
            state.sweep.done = {
              ...state.sweep.done,
              [norm.channelId]: payload.at,
            };
            recomputeWatch(state, settings, nowIso);
          }
        }
        ingestMessages(
          state,
          norm.messages,
          {
            channelId: norm.channelId,
            guildId: norm.guildId,
            fromMentions: norm.kind === "mentions",
            via: "rest",
          },
          ctx,
          nowMs,
          nowIso,
          payload.at
        );
        result.session = "signed-in";
        result.readOk = [SCOPE];
        return finish();
      }

      if (payload.kind === "dom") {
        let extract = null;
        try {
          extract = JSON.parse(String(payload.body || ""));
        } catch {
          extract = null;
        }
        if (!extract || typeof extract !== "object") return finish();
        const loc = extract.location || {};
        // Anything seen under /channels/@me is a DM channel — purge and
        // remember it so candidates from it are never stored again.
        if (loc.guildId === "@me" && loc.channelId) {
          const dm = new Set(state.dmChannels || []);
          dm.add(String(loc.channelId));
          state.dmChannels = [...dm].slice(-DM_CAP);
          state.lastGood.messages = {
            items: (state.lastGood.messages?.items || []).filter(
              (item) => String(item?.meta?.channelId || "") !== String(loc.channelId)
            ),
            at: state.lastGood.messages?.at || payload.at,
          };
        }
        if (extract.type === "inventory") {
          for (const g of extract.guilds || []) {
            const rec = (state.guilds[g.guildId] ||= { channels: {} });
            rec.name = g.name || rec.name;
            rec.unread = g.unread || false;
            rec.mentions = g.mentions || 0;
          }
          if (loc.guildId && loc.guildId !== "@me") {
            const rec = (state.guilds[loc.guildId] ||= { channels: {} });
            rec.lastInventoryAt = payload.at;
            rec.channels = { ...(rec.channels || {}) };
            for (const c of extract.channels || []) {
              if (!c?.channelId) continue;
              const prev_c = rec.channels[c.channelId] || {};
              rec.channels[c.channelId] = {
                ...prev_c,
                name: c.name ?? prev_c.name,
                type: c.type ?? prev_c.type,
                category: c.category ?? prev_c.category,
                limited: c.limited ?? prev_c.limited,
                unread: c.unread ?? false,
                mentions: c.mentions ?? 0,
                order: c.order ?? prev_c.order,
              };
            }
          }
          recomputeWatch(state, settings, nowIso);
        } else if (extract.type === "messages") {
          if (loc.guildId === "@me") {
            // Location only — DM content is never read.
          } else {
            ingestMessages(
              state,
              (extract.messages || []).map((m) => {
                const rest = domMessageToRest(
                  m,
                  m.channelId || loc.channelId
                );
                rest.guild_id = loc.guildId;
                return rest;
              }),
              { channelId: loc.channelId, guildId: loc.guildId, via: "dom" },
              ctx,
              nowMs,
              nowIso,
              payload.at
            );
          }
        }
        // TODO(events): extract.type === "events" folds scheduled-event
        // occurrences into state.meetingLog here (see recurring.js/dom.js).
        else if (extract.type === "location") {
          state.lastLocation = loc;
        }
        result.readOk = [SCOPE];
        return finish();
      }

      return finish();
    },
  },
};
