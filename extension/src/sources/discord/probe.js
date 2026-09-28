// @ts-check
// Read-only page probe for the "Check readers" screen — COUNTS ONLY.
// Never returns text, names or ids: counts tell the user whether the
// readers found the structure they expect on the open page. Pure DOM:
// no chrome APIs, no fetch, no Node imports (content-script safe).
// Never throws — an unreadable doc reports {page:"unknown"}.

import {
  readLocation,
  readGuilds,
  readChannels,
  readMessages,
  eventsDialog,
  eventsModalExtract,
} from "./dom.js";
import {
  CHANNEL_ITEM_SEL,
  EVENT_DATE_RE,
  EVENT_SERIES_RE,
  EVENT_COPY_LINK_TEXT,
  EVENT_INTERESTED_TEXT,
} from "./selectors.js";

/** @typedef {{page: string, counts: Record<string, number>, ok: boolean, hints: string[]}} ProbeResult */

const UNKNOWN = () => ({
  page: "unknown",
  counts: {},
  ok: false,
  hints: ["Open a Discord server channel, then run the check again."],
});

const textOf = (el) =>
  String(el?.textContent || "").replace(/\s+/g, " ").trim();

/** Buttons/links in `root` whose visible text is exactly `label`. */
const countButtons = (root, label) => {
  let n = 0;
  try {
    for (const el of root.querySelectorAll('button, [role="button"], a')) {
      if (textOf(el) === label) n++;
    }
  } catch {
    /* tolerate */
  }
  return n;
};

/**
 * Probe the open Discord page: what the DOM readers would see, as counts.
 * @param {any} doc  a Document (browser DOM or linkedom)
 * @param {string} [href]  the page URL
 * @returns {ProbeResult}
 */
export function probe(doc, href) {
  try {
    if (!doc || typeof doc.querySelectorAll !== "function") return UNKNOWN();
    if (!doc.querySelectorAll("*").length) return UNKNOWN();
    const loc = readLocation(href);
    const counts = { guildRail: readGuilds(doc).length };
    if (loc?.guildId === "@me") {
      // DM pages: rail count only — DM content is never read.
      return {
        page: "dm",
        counts,
        ok: false,
        hints: ["Open a server channel instead of DMs — DM content is never read."],
      };
    }
    const channels = readChannels(doc);
    counts.channelRows = channels.length;
    counts.categories = Math.max(
      0,
      doc.querySelectorAll(CHANNEL_ITEM_SEL).length - channels.length
    );
    counts.unreadChannels = channels.filter((c) => c.unread).length;
    const messages = readMessages(doc);
    counts.messageRows = messages.length;
    counts.messageTimes = messages.reduce(
      (n, m) => n + m.times.length + (m.timestamp ? 1 : 0),
      0
    );
    counts.messageContent = messages.filter((m) => m.content).length;
    counts.roleMentions = messages.reduce(
      (n, m) => n + m.roleMentions.length,
      0
    );

    // An open Events dialog rides on top of a channel page — report the
    // modal as the page and keep the channel counts alongside.
    const dlg = eventsDialog(doc);
    if (dlg) {
      counts.eventsDialog = 1;
      const extract = eventsModalExtract(doc, href || "");
      const cards = extract?.cards || [];
      counts.eventCards = cards.length;
      counts.dateLines = cards.reduce(
        (n, c) => n + c.lines.filter((l) => EVENT_DATE_RE.test(l.text)).length,
        0
      );
      counts.seriesSections = cards.reduce(
        (n, c) => n + c.lines.filter((l) => EVENT_SERIES_RE.test(l.text)).length,
        0
      );
      counts.interestedButtons = countButtons(
        dlg.dialog,
        EVENT_INTERESTED_TEXT
      );
      counts.copyLinkButtons = countButtons(dlg.dialog, EVENT_COPY_LINK_TEXT);
      const ok = counts.eventCards > 0;
      return {
        page: "events-modal",
        counts,
        ok,
        hints: ok ? [] : ["Open the server's Events list."],
      };
    }

    // A doc with no Discord chrome at all (empty page, or something else
    // entirely) isn't a half-read channel — it's unknown.
    if (
      counts.guildRail === 0 &&
      counts.channelRows === 0 &&
      counts.messageRows === 0
    ) {
      return UNKNOWN();
    }
    const hints = [];
    if (counts.channelRows === 0) {
      hints.push("Scroll the channel list so channels load.");
    }
    if (counts.messageRows === 0) {
      hints.push("Open a channel with recent messages.");
    }
    const page = loc ? "channel" : "other";
    const ok = !loc
      ? counts.channelRows > 0 || counts.messageRows > 0
      : counts.channelRows > 0 && counts.messageRows > 0;
    return { page, counts, ok, hints };
  } catch {
    return UNKNOWN();
  }
}

/**
 * Pages the "Check readers" flow asks the user to open.
 * `url` (when set) is a page the row's Open button can go to; `essential`
 * marks the rows onboarding insists on; `refreshDays` is how often the row
 * should see a fresh read.
 * @type {{id: string, label: string, how: string, url?: string,
 *   essential?: boolean, refreshDays?: number}[]}
 */
export const CHECKLIST = [
  {
    id: "channel",
    label: "A watched channel with recent messages",
    how: "Open the server, then a channel people post dates in",
    url: "https://discord.com/channels/@me",
    essential: true,
    refreshDays: 3,
  },
  {
    id: "timestamp",
    label: "A message with a Discord timestamp",
    how: "Find a message that shows a rendered date/time",
  },
  {
    id: "events",
    label: "The server's Events list",
    how: "Server dropdown → Events; mark one event Interested",
    url: "https://discord.com/channels/@me",
    essential: true,
    refreshDays: 7,
  },
  {
    id: "event-detail",
    label: "One event's details",
    how: "Click an event card in the Events list",
  },
  {
    id: "mentions",
    label: "Inbox → Mentions",
    how: "Open Discord's inbox on the Mentions tab",
  },
];
