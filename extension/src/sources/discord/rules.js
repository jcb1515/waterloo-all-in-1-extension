// @ts-check
// Discord watch rules — server config, channel scoring and the trigger /
// task vocabulary. Pure; no DOM, no chrome APIs.

/**
 * Design-team servers, matched by guild name (exact, case-insensitive,
 * after trim). `focus` biases channel scoring toward that subteam.
 * @type {{names: string[], team: string, focus?: string[]}[]}
 */
export const SERVERS = [
  { names: ["UWASIC"], team: "UWASIC" },
  { names: ["UWHPC"], team: "UWHPC" },
  { names: ["WATonomous"], team: "WATonomous", focus: ["electrical"] },
  {
    names: ["Waterloo Aerial Robotics Group", "WARG"],
    team: "WARG",
    focus: ["electrical"],
  },
  { names: ["ECE Waterloo '31"], team: "ECE '31" },
];

/**
 * Server config for a guild name — a SERVERS entry, or a settings.watched
 * key the user added themselves (team = guild name).
 * @param {string} guildName
 * @param {Record<string, {focus?: string[], channels?: string[]}>} [watched]
 * @returns {{team: string, focus: string[], settings?: {focus?: string[], channels?: string[]}}|null}
 */
export function serverFor(guildName, watched) {
  const name = String(guildName || "").trim();
  const lower = name.toLowerCase();
  for (const srv of SERVERS) {
    if (srv.names.some((n) => n.trim().toLowerCase() === lower)) {
      return {
        team: srv.team,
        focus: [...(srv.focus || [])],
        settings: watched ? findWatched(name, watched) : undefined,
      };
    }
  }
  const entry = watched ? findWatched(name, watched) : undefined;
  if (entry) {
    // A settings.watched guild that isn't a known server is watched too.
    return { team: name, focus: [...(entry.focus || [])], settings: entry };
  }
  return null;
}

/** Case-insensitive key lookup in a settings.watched map. */
function findWatched(guildName, watched) {
  const lower = guildName.trim().toLowerCase();
  for (const [key, entry] of Object.entries(watched || {})) {
    if (key.trim().toLowerCase() === lower) return entry;
  }
  return undefined;
}

/* Channel scoring ---------------------------------------------------- */

/** Name/category words worth watching. */
export const CHANNEL_POSITIVE = {
  announcements: 3, announcement: 3, events: 3, event: 3,
  meetings: 3, meeting: 3, schedule: 3, deadlines: 3, deadline: 3,
  tasks: 3, task: 3, todo: 3,
  general: 2,
};

/** Electrical subteam words (only when the guild focus includes it). */
export const ELECTRICAL_WORDS = [
  "electrical", "elec", "ee", "hardware", "hw", "pcb", "embedded",
  "firmware", "power", "analog", "digital", "circuits", "ecad", "altium",
];

/** Other-subteam words — pushed down for an electrical-focused guild. */
export const OTHER_SUBTEAM_WORDS = [
  "mechanical", "mech", "software", "sw", "perception", "controls",
  "autonomy", "business", "marketing", "sponsorship", "finance",
  "outreach", "media",
];

/** Never-worth-watching words. */
export const CHANNEL_NEGATIVE = [
  "off-topic", "offtopic", "memes", "random", "introductions",
  "introduction", "intro", "bots", "bot", "verify", "rules", "welcome",
  "faq", "music", "gaming", "voice-chat",
];

/** Channel types that are never suggested. */
export const NEVER_SUGGEST_TYPES = ["voice", "stage"];

const splitWords = (s) =>
  String(s || "").toLowerCase().split(/[-_\s]+/).filter(Boolean);

const intersects = (words, list) => words.some((w) => list.includes(w));

/**
 * Score a channel for watching. Voice/stage always return -Infinity
 * (never suggested). Higher = more likely to carry dated content.
 * @param {{name?: string, category?: string, type?: string}} channel
 * @param {string[]} focus  guild focus list, e.g. ["electrical"]
 */
export function channelScore(channel, focus = []) {
  const type = String(channel?.type || "").toLowerCase();
  if (NEVER_SUGGEST_TYPES.includes(type)) return -Infinity;
  const nameWords = splitWords(channel?.name);
  const catWords = splitWords(channel?.category);
  let score = 0;
  for (const w of nameWords) score += CHANNEL_POSITIVE[w] || 0;
  for (const w of catWords) score += CHANNEL_POSITIVE[w] || 0;
  if (focus.some((f) => f.toLowerCase() === "electrical")) {
    if (intersects(nameWords, ELECTRICAL_WORDS)) {
      score += 3;
      // The category matching too means the channel sits under an
      // electrical header — double the confidence.
      if (intersects(catWords, ELECTRICAL_WORDS)) score += 2;
    }
    if (intersects(nameWords, OTHER_SUBTEAM_WORDS)) score -= 2;
  }
  if (
    intersects(nameWords, CHANNEL_NEGATIVE) ||
    intersects(catWords, CHANNEL_NEGATIVE)
  ) {
    score -= 5;
  }
  return score;
}

/** Suggestion threshold / per-guild cap. */
export const SUGGEST_MIN = 3;
export const SUGGEST_CAP = 12;

/**
 * The channels to watch in a guild. A settings entry with a non-empty
 * `channels` list REPLACES suggestions (entries may be names or ids);
 * otherwise suggested = score >= 3, top 12 by score, ties by sidebar order.
 * @param {{channels?: Record<string, {name?: string, type?: string, category?: string, order?: number}>}} guild
 * @param {string[]} focus
 * @param {{channels?: string[]}} [settingsEntry]
 * @returns {{channelIds: string[], from: "settings"|"suggested"}}
 */
export function watchForGuild(guild, focus, settingsEntry) {
  const channels = guild?.channels || {};
  if (settingsEntry && Array.isArray(settingsEntry.channels) && settingsEntry.channels.length) {
    const wanted = new Set(
      settingsEntry.channels.map((c) => String(c).trim().toLowerCase())
    );
    const resolved = new Set();
    const ids = Object.entries(channels)
      .filter(([id, c]) => {
        const name = String(c?.name || "").toLowerCase();
        if (wanted.has(id) || wanted.has(name)) {
          resolved.add(id);
          resolved.add(name);
          return true;
        }
        return false;
      })
      .map(([id]) => id);
    // Entries that match no inventory channel are kept anyway — the user
    // named them explicitly.
    const unresolved = [...wanted].filter((w) => !resolved.has(w));
    return { channelIds: [...ids, ...unresolved], from: "settings" };
  }
  const scored = Object.entries(channels)
    .map(([id, c]) => ({ id, order: c?.order ?? 0, score: channelScore(c, focus) }))
    .filter((c) => c.score >= SUGGEST_MIN)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, SUGGEST_CAP)
    .map((c) => c.id);
  return { channelIds: scored, from: "suggested" };
}

/* Trigger vocabulary -------------------------------------------------- */

/** Words that make a dated message a meeting. */
export const MEETING_WORDS = [
  "meeting", "meet", "sync", "standup", "stand-up", "design review",
  "review session", "call", "huddle", "workshop", "session", "kickoff",
  "kick-off", "onboarding", "general meeting", "gm",
];

/** Words that make a dated message a deadline. */
export const DEADLINE_WORDS = [
  "due", "deadline", "submit", "submission", "tapeout", "tape-out",
  "order parts", "parts order", "bom",
];

/** Verbs that make a message a task — only when assigned to me. */
export const TASK_VERBS = [
  "can you", "could you", "please", "need you to", "assigned", "assign",
  "take care of", "take on", "handle", "finish", "complete", "make",
  "design", "route", "solder", "write", "update", "prepare",
  "look into", "own", "review",
];

/**
 * First word/phrase in `words` that appears in `text` on word boundaries
 * (case-insensitive). Multi-word phrases match with flexible inner space.
 * @param {string} text @param {string[]} words
 * @returns {string|null}
 */
export function wordTrigger(text, words) {
  const s = String(text || "");
  for (const w of words || []) {
    const flex = String(w)
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/[ -]+/g, "[\\s-]+");
    if (new RegExp(`\\b${flex}\\b`, "i").test(s)) return w;
  }
  return null;
}
