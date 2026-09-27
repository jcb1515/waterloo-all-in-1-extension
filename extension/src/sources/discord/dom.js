// @ts-check
// Pure DOM readers for Discord's rendered app. content.js calls these and
// serializes the result; tests call them on linkedom documents. Every read
// is tolerant: missing pieces are omitted, nothing throws.
//
// Selectors are best guesses — Discord's classes are generated and churn.
// They lean on stable-ish accessibility attributes (aria-label,
// data-list-item-id) and all live in selectors.js.

import {
  CHANNEL_PATH_RE,
  GUILD_ITEM_SEL,
  GUILD_ITEM_PREFIX,
  GUILD_LABEL_PREFIX_RE,
  CHANNEL_ITEM_SEL,
  CHANNEL_ITEM_PREFIX,
  CHANNEL_LINK_SEL,
  CHANNEL_HREF_RE,
  CHANNEL_DND_NAME_SEL,
  CHANNEL_TYPE_RE,
  CHANNEL_UNREAD_RE,
  CHANNEL_MENTIONS_RE,
  VISUALLY_HIDDEN_SEL,
  LIMITED_RE,
  MESSAGE_LI_SEL,
  MESSAGE_LI_ID_RE,
  MESSAGE_TIME_SEL,
  MESSAGE_CONTENT_PREFIX,
  ROLE_MENTION_SEL,
  MENTIONED_RE,
} from "./selectors.js";

/** /channels/<guild|@me>/<channel?> -> {guildId| "@me", channelId?} | null */
export function readLocation(href) {
  try {
    const m = CHANNEL_PATH_RE.exec(new URL(href).pathname);
    return m ? { guildId: m[1], channelId: m[2] } : null;
  } catch {
    return null;
  }
}

const textOf = (el) => String(el?.textContent || "").replace(/\s+/g, " ").trim();

/**
 * Element text with line structure preserved: <br> and block boundaries
 * become "\n", inline whitespace collapses to one space. Discord renders
 * message line breaks as <br> inside the content element; textContent
 * alone would flatten them (making "first line" mean the whole body).
 * @param {Element|null} el
 */
function textWithBreaks(el) {
  let out = "";
  /** @param {any} node */
  const walk = (node) => {
    for (const child of node?.childNodes || []) {
      if (child.nodeType === 3 /* TEXT_NODE */) {
        out += child.nodeValue || "";
      } else if (String(child.nodeName || "").toUpperCase() === "BR") {
        out += "\n";
      } else {
        const before = out.length;
        walk(child);
        // A block-level child that added text is a visual line break.
        if (
          out.length > before &&
          /^(DIV|P|LI|H[1-6]|SECTION|ARTICLE|TR|PRE|BLOCKQUOTE)$/.test(
            String(child.nodeName || "").toUpperCase()
          ) &&
          !out.endsWith("\n")
        ) {
          out += "\n";
        }
      }
    }
  };
  walk(el);
  return out
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n+ */g, "\n")
    .trim();
}

/**
 * The server rail -> [{guildId, name, unread, mentions}]. Discord prefixes
 * the aria-label with unread state ("3 mentions, X" / "Unread messages, X").
 * @param {Document} doc
 */
export function readGuilds(doc) {
  const guilds = [];
  try {
    for (const el of doc.querySelectorAll(GUILD_ITEM_SEL)) {
      const guildId = String(el.getAttribute("data-list-item-id") || "").slice(
        GUILD_ITEM_PREFIX.length
      );
      // "guildsnav___home" (DM rail) and folders aren't guilds.
      if (!/^\d+$/.test(guildId)) continue;
      let name = String(el.getAttribute("aria-label") || textOf(el)).trim();
      let unread = false;
      let mentions = 0;
      // Both prefixes may stack; strip them off the front repeatedly.
      let m;
      while ((m = GUILD_LABEL_PREFIX_RE.exec(name))) {
        if (m[1]) mentions += Number(m[1]);
        else unread = true;
        name = name.slice(m[0].length).trim();
      }
      guilds.push({ guildId, name, unread, mentions });
    }
  } catch {
    /* tolerate */
  }
  return guilds;
}

/**
 * One channel row's type/unread/mention flags from its anchor aria-label,
 * e.g. "unread, general (text channel)" or "1 mention, x (announcement
 * channel)". "Text (Limited)" in a visually-hidden span -> limited.
 * @param {Element} anchor @param {Element} row
 */
function channelFlags(anchor, row) {
  const label = String(anchor?.getAttribute("aria-label") || "");
  const type = (CHANNEL_TYPE_RE.exec(label)?.[1] || "text").toLowerCase();
  const mentions = Number(CHANNEL_MENTIONS_RE.exec(label)?.[1] || 0);
  const unread = CHANNEL_UNREAD_RE.test(label) || mentions > 0;
  let limited = false;
  try {
    for (const s of row.querySelectorAll(VISUALLY_HIDDEN_SEL)) {
      if (LIMITED_RE.test(textOf(s))) {
        limited = true;
        break;
      }
    }
  } catch {
    /* tolerate */
  }
  return { type, unread, mentions, limited };
}

/**
 * The channel sidebar -> [{channelId, guildId, name, type, category,
 * unread, mentions, limited, order}]. Rows with no channel anchor are
 * category headers — their text applies to the channels that follow.
 * @param {Document} doc
 */
export function readChannels(doc) {
  const channels = [];
  let category = "";
  let order = 0;
  try {
    for (const row of doc.querySelectorAll(CHANNEL_ITEM_SEL)) {
      const anchor = row.matches?.(CHANNEL_LINK_SEL)
        ? row
        : row.querySelector?.(CHANNEL_LINK_SEL);
      if (!anchor) {
        const header = textOf(row);
        if (header) category = header;
        continue;
      }
      const href = String(anchor.getAttribute("href") || "");
      const hm = CHANNEL_HREF_RE.exec(href);
      const channelId =
        hm?.[2] ||
        String(row.getAttribute("data-list-item-id") || "").slice(
          CHANNEL_ITEM_PREFIX.length
        );
      if (!channelId) continue;
      const dnd =
        row.querySelector?.(CHANNEL_DND_NAME_SEL)?.getAttribute("data-dnd-name") ||
        anchor.closest?.(CHANNEL_DND_NAME_SEL)?.getAttribute?.("data-dnd-name");
      const name = String(dnd || textOf(anchor)).trim();
      const flags = channelFlags(anchor, row);
      channels.push({
        channelId,
        guildId: hm?.[1],
        name,
        category: category || undefined,
        order: order++,
        ...flags,
      });
    }
  } catch {
    /* tolerate */
  }
  return channels;
}

/**
 * Rendered chat messages -> [{messageId, timestamp, content, times,
 * roleMentions, mentionsMe}]. `times` are the datetime attrs of <time>
 * elements inside the content (Discord renders <t:> markers as <time>).
 * @param {Document} doc
 */
export function readMessages(doc) {
  const messages = [];
  try {
    for (const li of doc.querySelectorAll(MESSAGE_LI_SEL)) {
      const im = MESSAGE_LI_ID_RE.exec(String(li.getAttribute("id") || ""));
      if (!im) continue;
      const contentEl =
        li.querySelector(`[id^="${MESSAGE_CONTENT_PREFIX}"]`) || null;
      const content = textWithBreaks(contentEl).slice(0, 4000);
      const timeEl = li.querySelector(MESSAGE_TIME_SEL);
      const timestamp = String(timeEl?.getAttribute("datetime") || "") || undefined;
      const times = [];
      try {
        for (const t of contentEl?.querySelectorAll("time") || []) {
          const dt = t.getAttribute("datetime");
          if (dt) times.push(String(dt));
        }
      } catch {
        /* tolerate */
      }
      const roleMentions = [];
      try {
        for (const r of contentEl?.querySelectorAll(ROLE_MENTION_SEL) || []) {
          const t = textOf(r);
          if (t) roleMentions.push(t);
        }
      } catch {
        /* tolerate */
      }
      const mentionsMe =
        MENTIONED_RE.test(String(li.getAttribute("class") || "")) ||
        MENTIONED_RE.test(
          String(li.firstElementChild?.getAttribute?.("class") || "")
        );
      messages.push({
        channelId: im[1],
        messageId: im[2],
        timestamp,
        content,
        times,
        roleMentions,
        mentionsMe,
      });
    }
  } catch {
    /* tolerate */
  }
  return messages;
}

/**
 * Sidebar extract for a guild page.
 * @param {Document} doc @param {string} href
 */
export function inventoryExtract(doc, href) {
  const location = readLocation(href) || { guildId: "", channelId: undefined };
  return {
    v: 1,
    type: "inventory",
    location,
    guilds: readGuilds(doc),
    channels: readChannels(doc),
  };
}

/**
 * Message-list extract for a channel page.
 * @param {Document} doc @param {string} href
 */
export function messagesExtract(doc, href) {
  const location = readLocation(href) || { guildId: "", channelId: undefined };
  return {
    v: 1,
    type: "messages",
    location,
    messages: readMessages(doc).filter(
      (m) => !location.channelId || m.channelId === location.channelId
    ),
  };
}

// TODO(events): a {v:1, type:"events", location, events:[...]} extract for
// the scheduled-events modal plugs in here once real captures exist —
// dom.js reads it, content.js sends it, index.js folds it into meetingLog.
