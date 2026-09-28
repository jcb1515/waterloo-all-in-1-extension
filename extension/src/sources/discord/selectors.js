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
  "^https://discord\\.com/api/v\\d+/users/@me/scheduled-events",
  "^https://discord\\.com/api/v\\d+/guilds/\\d+/messages/search",
];

/** REST endpoint shapes, matched in order (pins before the history rule). */
export const REST_ROUTES = [
  { kind: "pins", re: /\/api\/v\d+\/channels\/(\d+)\/messages\/pins(?:\?|$)/ },
  { kind: "channel", re: /\/api\/v\d+\/channels\/(\d+)\/messages(?:\?|$)/ },
  { kind: "mentions", re: /\/api\/v\d+\/users\/@me\/mentions(?:\?|$)/ },
  {
    kind: "rsvps",
    re: /\/api\/v\d+\/users\/@me\/scheduled-events(?:\?|$)/,
  },
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

/**
 * Question/request phrasing that turns a ping into a reply to-do
 * (a literal "?" in the text qualifies on its own).
 */
export const REPLY_REQUEST_RE =
  /\b(?:can you|could you|would you|can we|please|pls|plz|thoughts|what do you think|when are you free|are you free|are you available|let me know|lmk|any updates?|can someone|need you to)\b/i;

/** Reply text that closes an assigned task ("done", "shipped", …). */
export const DONE_RE =
  /\b(?:done|finished|merged|completed|shipped|fixed)\b/i;

/* Scheduled events modal -------------------------------------------------- */

/** The Events list modal and event detail modal render as a dialog. */
export const EVENT_DIALOG_SEL = '[role="dialog"]';
/** "4 Events" — the list modal's header line. */
export const EVENTS_HEADER_RE = /^\s*\d+\s+events?\s*$/im;
/** The detail modal's tab label (list modals don't have it). */
export const EVENT_DETAIL_MARK = "Event Info";
/** Button texts used to split cards / read RSVP state. */
export const EVENT_COPY_LINK_TEXT = "Copy Link";
export const EVENT_INTERESTED_TEXT = "Interested";
/** The Interested toggle when ON: aria-pressed/checked or a class hint. */
export const INTERESTED_ON_RE = /selected|active|green|filled|checked|on\b/i;
/**
 * Interested ON is a green filled button (Discord ≈ rgb(36,128,70) with a
 * checkmark); OFF is grey (≈ rgb(78,80,88)) with a bell. A non-transparent
 * computed background is decisive: ON when g >= minG, g-r >= dr, g-b >= db.
 */
export const INTERESTED_GREEN = { minG: 90, dr: 40, db: 25, minAlpha: 0.5 };
/** "Repeats every Tuesday" line. */
export const EVENT_REPEAT_RE = /^\s*repeats?\s+every\s+(.+)$/i;
/** The "Events in series" occurrences section heading. */
export const EVENT_SERIES_RE = /^\s*events?\s+in\s+series\s*$/i;
/** "/events/<guildId>/<eventId>" inside an href or attribute. */
export const EVENT_REF_RE = /\/events\/(\d+)\/(\d+)/;
/** "Created by <person>" — dropped at extraction; names never leave. */
export const EVENT_CREATED_BY_RE = /^\s*created\s+by\b/i;
/**
 * Best-guess rows of the "N Interested" member list — skipped at
 * extraction so attendee names never leave the page.
 */
export const EVENT_MEMBER_ROW_SEL =
  '[class*="member" i], [class*="avatar" i], [class*="participant" i], [class*="attendee" i], [class*="guest" i]';

/** UI chrome inside event cards that never carries event content. */
export const EVENT_UI_RES = [
  /^\s*\d+\s+events?\s*$/i, // "4 Events" header
  /^\s*\d+\s*$/, // bare interested-count number
  /^\s*\d+\s+interested\s*$/i, // "6 Interested" tab
  /^\s*\d+\s+people\s+are\s+interested\s*$/i,
  /^\s*copy\s+link\s*$/i,
  /^\s*interested\s*$/i,
  /^\s*event\s+info\s*$/i,
  /^\s*[…·•]\s*$/,
  /^\s*share\s*$/i,
  /^\s*start\s+event\s*$/i,
  /^\s*edit\s+event\s*$/i,
  /^\s*close\s*$/i,
  /^\s*view\s+(?:future|past)\s+events\s*$/i, // series pager link
  /^@[\w.]+$/, // stray handles (member lists)
];

/**
 * A location slot that only says TBD / TBA / "To be determined" /
 * "To be announced" (optional "Location" prefix) is no location at all.
 */
export const EVENT_LOCATION_TBD_RE =
  /^\s*(?:location\s*[:\-–]?\s*)?(?:tbd|tba|to\s+be\s+determined|to\s+be\s+announced)\s*$/i;

/** Lines that look like a place: room codes, links, venue words. */
export const EVENT_LOCATION_RE =
  /(?:\b[A-Za-z]{1,4}\s?-?\s?\d{3,4}\b)|(?:https?:\/\/)|(?:\b(?:room|hall|building|zoom|meet|teams|voice|stage|online|virtual|discord|gym|field|office|lounge|lab)\b)/i;

/**
 * An event date line: optional weekday, `Mon d[th][, yyyy]` or
 * today/tomorrow, then `·` / `,` / `at`, then `h:mm AM/PM`.
 * Groups: 1 weekday, 2 month, 3 day, 4 year, 5 today|tomorrow, 6 h, 7 mi,
 * 8 meridiem.
 */
export const EVENT_DATE_RE = new RegExp(
  "^\\s*(?:(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\\.?\\s+)?" +
    "(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?\\s+" +
    "(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s*(\\d{4})?|(today|tomorrow))" +
    "\\s*(?:·|•|,|at)\\s*" +
    "(\\d{1,2}):(\\d{2})\\s*(a\\.?m\\.?|p\\.?m\\.?)",
  "i"
);
/** The range separator between two date-times (" — ", " – ", " - ", to). */
export const EVENT_RANGE_SEP_RE = /^\s*(?:—|–|−|-|\bto\b)\s*/;
/** A bare "h:mm AM/PM" (a range tail with no second date). */
export const EVENT_TIME_ONLY_RE =
  /^\s*(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)/i;
