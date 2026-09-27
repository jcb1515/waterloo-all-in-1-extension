// @ts-check
// Every Discord URL pattern, DOM selector and literal regex lives here —
// the adapter's behaviour is tuned in one place. Discord's markup is not
// public API; these selectors are best guesses from the discovery report
// plus accessibility attributes, and every reader tolerates misses.

/** REST responses the recorder forwards (GET only — see index.js). */
export const OBSERVE_URL_PATTERNS = [
  "^https://discord\\.com/api/v\\d+/channels/\\d+/messages(\\?|$)",
  "^https://discord\\.com/api/v\\d+/channels/\\d+/messages/pins",
  "^https://discord\\.com/api/v\\d+/users/@me/mentions",
  "^https://discord\\.com/api/v\\d+/guilds/\\d+/messages/search",
];

/** REST endpoint shapes, matched in order (pins before the history rule). */
export const REST_ROUTES = [
  { kind: "pins", re: /\/api\/v\d+\/channels\/(\d+)\/messages\/pins(?:\?|$)/ },
  { kind: "channel", re: /\/api\/v\d+\/channels\/(\d+)\/messages(?:\?|$)/ },
  { kind: "mentions", re: /\/api\/v\d+\/users\/@me\/mentions(?:\?|$)/ },
  { kind: "search", re: /\/api\/v\d+\/guilds\/(\d+)\/messages\/search(?:\?|$)/ },
];

/** /channels/<guildId|@me>/<channelId> — guildId "@me" means DMs. */
export const CHANNEL_PATH_RE = /^\/channels\/(\d+|@me)(?:\/(\d+))?/;

/* Sidebar inventory -------------------------------------------------- */

/** Guild icons in the server rail; id is the suffix after "guildsnav___". */
export const GUILD_ITEM_SEL = '[data-list-item-id^="guildsnav___"]';
export const GUILD_ITEM_PREFIX = "guildsnav___";
/**
 * Discord prepends unread state to the guild's aria-label, e.g.
 * "3 mentions, WATonomous" or "Unread messages, UWHPC" (both can appear).
 */
export const GUILD_LABEL_PREFIX_RE =
  /^(?:(\d+)\s+mentions?|unread messages?)(?:,\s*|\s+|$)/i;

/** Channel list rows; id is the suffix after "channels___". */
export const CHANNEL_ITEM_SEL = '[data-list-item-id^="channels___"]';
export const CHANNEL_ITEM_PREFIX = "channels___";
export const CHANNEL_LINK_SEL = 'a[href^="/channels/"]';
export const CHANNEL_HREF_RE = /^\/channels\/(\d+)\/(\d+)/;
/** Drag-and-drop name attribute Discord puts on channel/category rows. */
export const CHANNEL_DND_NAME_SEL = "[data-dnd-name]";
/** "… (text channel)" / "(voice channel)" / "(announcement channel)" … */
export const CHANNEL_TYPE_RE = /\(([\w ]+?)\s+channel\)/i;
export const CHANNEL_UNREAD_RE = /\bunread\b/i;
export const CHANNEL_MENTIONS_RE = /(\d+)\s+mentions?/i;
/** Screen-reader-only spans Discord uses for e.g. "Text (Limited)". */
export const VISUALLY_HIDDEN_SEL =
  '[class*="visuallyHidden" i], [class*="hiddenVisually" i], .visually-hidden';
export const LIMITED_RE = /\(limited\)/i;

/* Message list -------------------------------------------------------- */

export const MESSAGE_LIST_SEL = 'ol[data-list-id="chat-messages"]';
export const MESSAGE_LI_SEL = 'li[id^="chat-messages-"]';
/** li id is chat-messages-<channelId>-<messageId>. */
export const MESSAGE_LI_ID_RE = /^chat-messages-(\d+)-(\d+)$/;
export const MESSAGE_TIME_SEL = 'time[id^="message-timestamp-"]';
export const MESSAGE_CONTENT_PREFIX = "message-content-";
export const ROLE_MENTION_SEL = '[class*="roleMention" i]';
export const MENTIONED_RE = /mentioned/i;

/* Message markup ------------------------------------------------------ */

/** <t:1759507200> / <t:1759507200:R> — Discord's rendered timestamps. */
export const DISCORD_TS_RE = /<t:(\d{1,13})(?::([tTdDfFR]))?>/g;

/**
 * Markup stripped before text-date extraction: user/role/channel mentions,
 * <t:> markers (handled separately as exact dates), custom emoji, fenced
 * and inline code, and URLs.
 */
export const MARKUP_STRIP_RES = [
  /```[\s\S]*?```/g,
  /`[^`\n]*`/g,
  /<@!?\d+>/g,
  /<@&\d+>/g,
  /<#\d+>/g,
  /<t:\d{1,13}(?::[tTdDfFR])?>/g,
  /<a?:\w+:\d+>/g,
  /https?:\/\/[^\s<>"']+/g,
];

/** Meeting links that become an item's location. */
export const MEETING_URL_RE =
  /https?:\/\/[^\s<>"']*(?:meet\.google\.com|[\w.-]*zoom\.us|teams\.microsoft\.com|discord\.gg|discord\.com\/channels)[^\s<>"']*/i;

/** "by <the matched date>" is a deadline signal. */
export const BY_BEFORE_DATE_RE = /\bby\s*$/i;

/** "Time: 5:00 PM EST" / "when - 6pm" lines in announcement blocks. */
export const TIME_LINE_RE = /^\s*(?:time|when)\s*[:\-–]\s*(.+)$/im;

/** "Location: E5 3101" / "where: …" / "room: …" lines. */
export const LOCATION_LINE_RE =
  /^\s*(?:location|where|room|place)\s*[:\-–]\s*(.+)$/im;
