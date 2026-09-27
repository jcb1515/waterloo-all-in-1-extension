// @ts-check
// Discord message -> candidate item extraction. Pure: REST/normalised
// message objects in, contract Items out. Message bodies are never
// persisted anywhere — only the ≤300-char sentence around a hit lands on
// an item's evidence/details.

import { itemId } from "../../core/contract.js";
import { termCodeFor, zonedIso, zonedParts } from "../../lib/textdates/index.js";
import {
  REST_ROUTES,
  DISCORD_TS_RE,
  MARKUP_STRIP_RES,
  MEETING_URL_RE,
  BY_BEFORE_DATE_RE,
  TIME_LINE_RE,
  LOCATION_LINE_RE,
} from "./selectors.js";
import { parseTimeValue } from "./time.js";
import {
  MEETING_WORDS,
  DEADLINE_WORDS,
  TASK_VERBS,
  wordTrigger,
} from "./rules.js";

/** @typedef {import("../../core/contract.js").Item} Item */

export const SOURCE = "discord";
export const SCOPE = "discord";
const DAY_MS = 24 * 60 * 60 * 1000;
const TITLE_MAX = 100;
const SNIPPET_MAX = 300;
const MIN_CONFIDENCE = 0.6;
/** Task without a date -> follow up a week later. */
const UNDATED_TASK_MS = 7 * DAY_MS;
/** Message types we read: 0 default, 19 reply. */
const READABLE_TYPES = new Set([0, 19]);

/**
 * A forwarded REST body -> a uniform shape. Fail soft: unparseable JSON
 * yields an empty message list, never a throw.
 * @param {string} url @param {string} bodyText
 * @returns {{kind: string, channelId?: string, guildId?: string, messages: any[]}}
 */
export function normalizeRestBody(url, bodyText) {
  const route = REST_ROUTES.find((r) => r.re.test(String(url || "")));
  const kind = route?.kind || "unknown";
  const out = { kind, messages: [] };
  if (route) {
    const m = route.re.exec(String(url || ""));
    if (kind === "search") out.guildId = m?.[1];
    else if (m?.[1] && kind !== "mentions") out.channelId = m?.[1];
  }
  let body;
  try {
    body = JSON.parse(String(bodyText || ""));
  } catch {
    return out;
  }
  if (kind === "channel" || kind === "mentions") {
    out.messages = Array.isArray(body) ? body.filter(Boolean) : [];
  } else if (kind === "pins") {
    const list = Array.isArray(body) ? body : body?.items;
    out.messages = (Array.isArray(list) ? list : [])
      .map((row) => row?.message || row)
      .filter(Boolean);
  } else if (kind === "rsvps") {
    // GET /users/@me/scheduled-events — the events the user has RSVP'd to.
    // Only the event ids are kept; nothing else in the payload is read.
    const list = Array.isArray(body)
      ? body
      : Array.isArray(body?.scheduled_events)
        ? body.scheduled_events
        : [];
    out.eventIds = list
      .map((e) =>
        String(
          e?.guild_scheduled_event_id || e?.guild_scheduled_event?.id || e?.id || ""
        )
      )
      .filter(Boolean);
  } else if (kind === "search") {
    const groups = Array.isArray(body?.messages) ? body.messages : [];
    for (const group of groups) {
      if (!Array.isArray(group)) continue;
      const hits = group.filter((m) => m && m.hit === true);
      const picked = hits.length ? hits : group.slice(0, 1);
      for (const m of picked) if (m) out.messages.push(m);
    }
  }
  for (const m of out.messages) {
    if (!out.channelId && m.channel_id) out.channelId = String(m.channel_id);
    if (!out.guildId && m.guild_id) out.guildId = String(m.guild_id);
  }
  return out;
}

/**
 * Discord's rendered-timestamp markup -> exact date hits.
 * `<t:unix>` / `<t:unix:style>`; styles d/D mean all-day on the instant's
 * Toronto calendar day, everything else is a timed instant.
 * @param {string} content
 * @returns {{startAt: string, allDay: boolean, text: string, index: number,
 *   exact: true, style: string}[]}
 */
export function discordTimestamps(content) {
  const text = String(content || "");
  const hits = [];
  DISCORD_TS_RE.lastIndex = 0;
  let m;
  while ((m = DISCORD_TS_RE.exec(text))) {
    const raw = Number(m[1]);
    if (!Number.isFinite(raw)) continue;
    // Snowflake-width values are already milliseconds.
    const ms = raw > 1e11 ? raw : raw * 1000;
    const style = m[2] || "";
    if (/^[dD]$/.test(style)) {
      const p = zonedParts(new Date(ms));
      hits.push({
        startAt: zonedIso(p.y, p.m, p.d),
        allDay: true,
        text: m[0],
        index: m.index,
        exact: true,
        style,
      });
    } else {
      hits.push({
        startAt: new Date(ms).toISOString(),
        allDay: false,
        text: m[0],
        index: m.index,
        exact: true,
        style,
      });
    }
  }
  return hits;
}

/**
 * Content with Discord markup removed — what text-date extraction sees.
 * Newlines survive (the first line is the item title); other whitespace
 * collapses.
 */
export function stripMarkup(content) {
  let text = String(content || "");
  for (const re of MARKUP_STRIP_RES) text = text.replace(re, " ");
  return text
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n+ */g, "\n")
    .trim();
}

/**
 * The sentence of `text` containing `needle` (or the needle position),
 * whitespace-collapsed and capped at SNIPPET_MAX centred on the match.
 * @param {string} text @param {number} index @param {number} length
 */
export function snippetAround(text, index, length) {
  const s = String(text || "");
  if (!s) return "";
  let left = index;
  while (left > 0 && !/[.!?\n]/.test(s[left - 1])) left--;
  let right = index + length;
  while (right < s.length && !/[.!?\n]/.test(s[right])) right++;
  let sentence = s.slice(left, right + (right < s.length ? 1 : 0)).replace(/\s+/g, " ").trim();
  if (sentence.length > SNIPPET_MAX) {
    const mid = index - left + Math.floor(length / 2);
    const from = Math.max(
      0,
      Math.min(mid - Math.floor(SNIPPET_MAX / 2), sentence.length - SNIPPET_MAX)
    );
    sentence = sentence.slice(from, from + SNIPPET_MAX).trim();
  }
  return sentence.slice(0, SNIPPET_MAX);
}

const firstLine = (text) =>
  String(text || "").split("\n")[0].replace(/\s+/g, " ").trim();

/**
 * A DOM extract message -> the REST message shape the candidate extractor
 * reads. `times` (ISO datetimes from <time> elements) are re-inserted as
 * <t:unix> markers so exact-date extraction is identical on both paths.
 * @param {{messageId: string, timestamp?: string, content?: string,
 *   times?: string[], roleMentions?: string[], mentionsMe?: boolean}} dom
 * @param {string} channelId
 */
export function domMessageToRest(dom, channelId) {
  const markers = (dom?.times || [])
    .map((t) => {
      const ms = Date.parse(t);
      return Number.isFinite(ms) ? `<t:${Math.floor(ms / 1000)}>` : "";
    })
    .filter(Boolean)
    .join(" ");
  const content = `${String(dom?.content || "").trim()}${markers ? " " + markers : ""}`;
  // Discord highlights @everyone/@here the same as a personal ping (and
  // renders them with the roleMention class). A "mention" with no real
  // role left over is a broadcast — never counts as pinging me.
  const realRoles = (dom?.roleMentions || []).filter(
    (r) => !/^@(everyone|here)$/i.test(String(r).trim())
  );
  const everyoneOnly =
    realRoles.length === 0 && /@(everyone|here)\b/i.test(content);
  return {
    id: String(dom?.messageId || ""),
    channel_id: String(channelId || ""),
    content,
    timestamp: dom?.timestamp,
    edited_timestamp: null,
    mentions: [],
    mention_roles: [],
    mention_everyone: everyoneOnly,
    type: 0,
    // DOM can't tell who a message mentions; the highlighted style is the
    // only signal — treated as "this pinged me" unless it's @everyone.
    domMentionsMe: dom?.mentionsMe === true && !everyoneOnly,
    domRoleMentions: realRoles,
  };
}

/**
 * Message -> candidate Items. One item per message, anchored on its first
 * usable date hit; undated assigned tasks get a +7d follow-up.
 * @param {any} msg  normalised REST message (or domMessageToRest output)
 * @param {object} o
 * @param {(text: string, opts: {now: Date, termCode?: number, tz?: string}) => any[]} o.extractDates
 * @param {string} [o.selfId] @param {string[]} [o.roleIds]
 * @param {string[]} [o.keywords]  extra trigger words (settings)
 * @param {boolean} [o.fromMentions]  payload came from /users/@me/mentions
 * @param {boolean} [o.watched]  channel is watched (needed for the bare
 *   <t:> -> "event" rule)
 * @param {string} [o.guildId] @param {string} [o.channelId]
 * @param {string} [o.channelName] @param {string} [o.team]
 * @param {"rest"|"dom"} [o.via]  which read path produced this message
 * @param {string} o.nowIso
 * @returns {Item[]}
 */
export function candidatesForMessage(msg, o) {
  const type = Number(msg?.type ?? 0);
  if (!READABLE_TYPES.has(type)) return [];
  const content = String(msg?.content || "");
  const text = stripMarkup(content);
  if (!text) return [];

  const msgMs = Date.parse(msg?.timestamp || "");
  const msgDate = Number.isFinite(msgMs) ? new Date(msgMs) : new Date(o.nowIso);

  // --- date hits: exact <t:> markers plus textdates on stripped text ---
  /** @type {any[]} */
  const hits = [];
  for (const t of discordTimestamps(content)) {
    hits.push({ ...t, confidence: "exact" });
  }
  const cutoff = msgDate.getTime() - DAY_MS;
  if (typeof o.extractDates === "function") {
    for (const hit of o.extractDates(text, {
      now: msgDate,
      termCode: termCodeFor(msgDate),
    }) || []) {
      if (hit.confidence < MIN_CONFIDENCE) continue;
      const startMs = Date.parse(hit.startAt);
      if (Number.isNaN(startMs) || startMs < cutoff) continue;
      hits.push({
        startAt: hit.startAt,
        endAt: hit.endAt,
        allDay: Boolean(hit.allDay),
        text: hit.text,
        index: hit.index,
        exact: false,
        weekdayMismatch: Boolean(hit.weekdayMismatch),
        confidence: "tentative",
      });
    }
  }
  hits.sort((a, b) => a.index - b.index);
  // An exact <t:> and a text hit on the same instant collapse to one —
  // the exact marker upgrades the surviving hit's confidence.
  const deduped = [];
  for (const h of hits) {
    const dup = deduped.find((p) => p.startAt === h.startAt);
    if (dup) {
      if (h.exact && !dup.exact) {
        dup.exact = true;
        dup.confidence = "exact";
      }
      continue;
    }
    deduped.push(h);
  }

  // --- triggers ---
  const meetingTrig =
    wordTrigger(text, MEETING_WORDS) ||
    wordTrigger(text, o.keywords || []); // user keywords act as triggers
  const deadlineTrig =
    wordTrigger(text, DEADLINE_WORDS) ||
    (deduped.some(
      (h) => !h.exact && BY_BEFORE_DATE_RE.test(text.slice(0, h.index))
    )
      ? "by"
      : null);
  const taskTrig = wordTrigger(text, TASK_VERBS);

  // --- assigned to me? ---
  const mentions = Array.isArray(msg?.mentions) ? msg.mentions : [];
  const roles = Array.isArray(msg?.mention_roles) ? msg.mention_roles : [];
  const assignedToMe = Boolean(
    (o.selfId && mentions.some((m) => String(m?.id) === o.selfId)) ||
      (o.roleIds || []).some((r) => roles.includes(r)) ||
      (o.fromMentions &&
        !(
          msg?.mention_everyone &&
          mentions.length === 0 &&
          roles.length === 0
        )) ||
      msg?.domMentionsMe === true
  );

  // --- classification, first match wins ---
  /** @type {"task"|"deadline"|"meeting"|"event"|null} */
  let kind = null;
  let trigger = null;
  if (assignedToMe && taskTrig) {
    kind = "task";
    trigger = taskTrig;
  } else if (deadlineTrig) {
    kind = "deadline";
    trigger = deadlineTrig;
  } else if (meetingTrig) {
    kind = "meeting";
    trigger = meetingTrig;
  } else if (o.watched && deduped.some((h) => h.exact)) {
    kind = "event";
    trigger = "timestamp";
  }
  if (!kind) return [];

  const hit = deduped[0] || null;
  const channelId = String(o.channelId || msg?.channel_id || "");
  const guildId = o.guildId || msg?.guild_id || undefined;
  const messageId = String(msg?.id || "");
  if (!channelId || !messageId) return [];

  // Undated task: one follow-up item a week out.
  const undated = !hit;
  if (undated && kind !== "task") return [];
  const anchorIso = undated
    ? new Date(msgDate.getTime() + UNDATED_TASK_MS).toISOString()
    : hit.startAt;
  const key = `${channelId}:${messageId}:${undated ? "undated" : anchorIso}`;

  // For exact hits the marker's index is in the ORIGINAL content (the <t:>
  // was stripped from `text`), so the first line is the honest context.
  const snippet = hit
    ? hit.exact
      ? firstLine(text).slice(0, SNIPPET_MAX)
      : snippetAround(text, hit.index, String(hit.text || "").length)
    : trigger
      ? snippetAround(text, Math.max(0, text.toLowerCase().indexOf(trigger)), trigger.length)
      : firstLine(text).slice(0, SNIPPET_MAX);

  const link = MEETING_URL_RE.exec(content)?.[0];

  // Announcement blocks ("Date: / Time: / Location:" lines): an all-day
  // hit upgrades to a timed, located event. Timezone labels are ignored —
  // the value is always read as Toronto wall time.
  /** @type {{startAt: string, endAt?: string}|null} */
  let timed = null;
  if (hit?.allDay) {
    const tline = TIME_LINE_RE.exec(text);
    const range = tline ? parseTimeValue(tline[1]) : null;
    if (range) {
      const p = zonedParts(new Date(hit.startAt));
      const startAt = zonedIso(p.y, p.m, p.d, range.start.h, range.start.mi);
      let endAt;
      if (range.end) {
        let endMs = Date.parse(
          zonedIso(p.y, p.m, p.d, range.end.h, range.end.mi)
        );
        if (endMs <= Date.parse(startAt)) endMs += DAY_MS; // crosses midnight
        endAt = new Date(endMs).toISOString();
      }
      timed = { startAt, endAt };
    }
  }
  const locLine = LOCATION_LINE_RE.exec(text)?.[1]
    ?.replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);

  const titleBase = firstLine(text).slice(0, TITLE_MAX) || "Discord message";
  /** @type {Item} */
  const item = {
    id: itemId(SOURCE, key),
    source: SOURCE,
    type: kind,
    title: (kind === "task" ? `Task: ${titleBase}` : titleBase).slice(0, TITLE_MAX),
    org: o.team || undefined,
    url: guildId
      ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
      : undefined,
    status: "open",
    confidence: undated || !hit?.exact ? "tentative" : "exact",
    review: "pending",
    seenIn: [{ source: SOURCE, key, scope: SCOPE, at: o.nowIso }],
    location:
      link || locLine || (o.channelName ? `#${o.channelName}` : undefined),
    evidence: { snippet, url: guildId ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}` : undefined, method: "text" },
    details: snippet || undefined,
    meta: {
      guildId,
      channelId,
      messageId,
      assignedToMe,
      trigger,
      via: o.via === "dom" ? "dom" : "rest",
      undated: undated || undefined,
      weekdayMismatch: hit?.weekdayMismatch || undefined,
    },
  };
  if (undated) {
    item.dueAt = anchorIso;
    item.details = "No due date in the message; default follow-up in 7 days.";
  } else if (hit.allDay && !timed) {
    item.startAt = hit.startAt;
    item.allDay = true;
    if (hit.endAt) item.endAt = hit.endAt;
  } else if (timed && (kind === "deadline" || kind === "task")) {
    item.dueAt = timed.endAt || timed.startAt;
  } else if (timed) {
    item.startAt = timed.startAt;
    if (timed.endAt) item.endAt = timed.endAt;
  } else if (kind === "deadline" || kind === "task") {
    item.dueAt = hit.startAt;
  } else {
    item.startAt = hit.startAt;
    if (hit.endAt) item.endAt = hit.endAt;
  }
  return [item];
}
