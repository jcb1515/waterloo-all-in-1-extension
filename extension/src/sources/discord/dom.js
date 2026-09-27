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
  EVENT_DIALOG_SEL,
  EVENTS_HEADER_RE,
  EVENT_DETAIL_MARK,
  EVENT_COPY_LINK_TEXT,
  EVENT_INTERESTED_TEXT,
  INTERESTED_ON_RE,
  INTERESTED_GREEN,
  EVENT_REF_RE,
  EVENT_CREATED_BY_RE,
  EVENT_MEMBER_ROW_SEL,
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

/* Scheduled events modal ----------------------------------------------------
 * TODO(events): the real DOM markup for Discord's Events modals is still
 * unknown — this reader is intentionally text-driven. Card boundaries are
 * found via each card's "Copy Link" button; everything else is line order
 * + heading/icon hints. Verify against a saved capture at CP2.
 */

const ELEMENT_NODE = 1;

/** True when `root` contains `el` (linkedom-safe). */
function containsEl(root, el) {
  try {
    if (typeof root?.contains === "function") return root.contains(el);
  } catch {
    /* tolerate */
  }
  for (let e = el; e; e = e.parentElement) if (e === root) return true;
  return false;
}

/** Inside an h1–h4 or [role=heading]? (climbs past `stopAt` harmlessly) */
function inHeading(el) {
  for (let e = el; e && e.nodeType === ELEMENT_NODE; e = e.parentElement) {
    const tag = String(e.nodeName || "").toUpperCase();
    if (/^H[1-4]$/.test(tag)) return true;
    try {
      if (
        String(e.getAttribute?.("role") || "") === "heading" ||
        e.getAttribute?.("aria-level") != null
      ) {
        return true;
      }
    } catch {
      /* tolerate */
    }
  }
  return false;
}

/** The line's element (or its previous sibling) contains an svg. */
function hasIcon(el) {
  try {
    if (el?.querySelector?.("svg")) return true;
    const prev = el?.previousElementSibling;
    if (prev) {
      if (String(prev.nodeName || "").toUpperCase() === "SVG") return true;
      if (prev.querySelector?.("svg")) return true;
    }
  } catch {
    /* tolerate */
  }
  return false;
}

/** Best-guess member/avatar rows (the "N Interested" tab) are skipped. */
function isMemberRow(root, el) {
  try {
    const hit = el?.closest?.(EVENT_MEMBER_ROW_SEL) || null;
    return Boolean(hit && containsEl(root, hit));
  } catch {
    return false;
  }
}

/**
 * A dialog's text as ordered lines: [{text, heading, icon, el}]. <br> and
 * block boundaries (incl. buttons/links) split lines; "Created by …" and
 * member-list rows are dropped here so names never leave the page.
 * @param {Element} root
 */
function collectLines(root) {
  /** @type {{text: string, heading: boolean, icon: boolean, el: any}[]} */
  const lines = [];
  let buf = "";
  /** @type {any} */
  let bufEl = null;
  const flush = () => {
    const t = buf.replace(/[^\S\n]+/g, " ").replace(/\n+/g, " ").trim();
    buf = "";
    const el = bufEl;
    bufEl = null;
    if (!t || EVENT_CREATED_BY_RE.test(t)) return;
    lines.push({ text: t, heading: inHeading(el), icon: hasIcon(el), el });
  };
  /** @param {any} node */
  const walk = (node) => {
    for (const child of node?.childNodes || []) {
      if (child.nodeType === 3 /* TEXT_NODE */) {
        if (!buf) bufEl = child.parentElement || child.parentNode || node;
        buf += child.nodeValue || "";
        continue;
      }
      const tag = String(child.nodeName || "").toUpperCase();
      if (tag === "SVG" || tag === "IMG") continue;
      if (isMemberRow(root, child)) continue;
      if (tag === "BR") {
        flush();
        continue;
      }
      const block =
        /^(DIV|P|LI|H[1-6]|SECTION|ARTICLE|TR|PRE|BLOCKQUOTE|BUTTON|A|HEADER|FOOTER|UL|OL)$/.test(
          tag
        );
      if (block) flush();
      walk(child);
      if (block) flush();
    }
  };
  walk(root);
  flush();
  return lines;
}

/**
 * The element's computed background-color parsed to {r,g,b,a}, or null
 * when getComputedStyle is unavailable (linkedom tests) or the color
 * isn't an rgb()/rgba() string.
 */
function computedBg(el) {
  try {
    const g = globalThis.getComputedStyle;
    if (typeof g !== "function") return null;
    const m = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(
      String(g(el)?.backgroundColor || "")
    );
    if (!m) return null;
    let a = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (/%$/.test(m[4] || "")) a /= 100;
    return { r: +m[1], g: +m[2], b: +m[3], a: Number.isFinite(a) ? a : 1 };
  } catch {
    return null;
  }
}

/** Interested toggle state: true / false / null (no such button). */
function interestedState(root) {
  try {
    for (const el of root.querySelectorAll(
      'button, [role="button"], [role="switch"], a'
    )) {
      if (textOf(el) !== EVENT_INTERESTED_TEXT) continue;
      if (
        el.getAttribute?.("aria-pressed") === "true" ||
        el.getAttribute?.("aria-checked") === "true"
      ) {
        return true;
      }
      // Confirmed from a live screenshot: ON = green filled background
      // (≈ rgb(36,128,70), checkmark), OFF = grey (≈ rgb(78,80,88), bell).
      // A visible computed color decides; transparent/missing falls back
      // to the class heuristic.
      const bg = computedBg(el);
      if (bg && bg.a > INTERESTED_GREEN.minAlpha) {
        return (
          bg.g >= INTERESTED_GREEN.minG &&
          bg.g - bg.r >= INTERESTED_GREEN.dr &&
          bg.g - bg.b >= INTERESTED_GREEN.db
        );
      }
      return INTERESTED_ON_RE.test(String(el.getAttribute?.("class") || ""));
    }
  } catch {
    /* tolerate */
  }
  return null;
}

/** "/events/<guildId>/<eventId>" from any attribute inside the card. */
function eventRefOf(root) {
  const scan = (el) => {
    try {
      for (const attr of Array.from(el.attributes || [])) {
        const m = EVENT_REF_RE.exec(String(attr.value ?? attr.nodeValue ?? ""));
        if (m) return `events/${m[1]}/${m[2]}`;
      }
    } catch {
      /* tolerate */
    }
    return null;
  };
  try {
    const own = scan(root);
    if (own) return own;
    for (const el of root.querySelectorAll("*")) {
      const hit = scan(el);
      if (hit) return hit;
    }
  } catch {
    /* tolerate */
  }
  return null;
}

/**
 * The Events list modal / event detail modal -> a DOM extract.
 * Card split: each card is the largest dialog subtree containing exactly
 * one "Copy Link" control; with none, the whole dialog is one card and the
 * parser splits on top-level date lines. Dialog lines outside any card
 * (e.g. an "Events in series" block rendered as a sibling) attach to the
 * previous card.
 * @param {Document} doc @param {string} href
 */
export function eventsModalExtract(doc, href) {
  try {
    /** @type {any} */
    let dialog = null;
    /** @type {"list"|"detail"|null} */
    let modal = null;
    for (const el of doc.querySelectorAll(EVENT_DIALOG_SEL)) {
      const t = textWithBreaks(el);
      if (EVENTS_HEADER_RE.test(t)) {
        dialog = el;
        modal = "list";
        break;
      }
      if (t.includes(EVENT_DETAIL_MARK)) {
        dialog = el;
        modal = "detail";
        break;
      }
    }
    if (!dialog) return null;

    const location = readLocation(href) || { guildId: "", channelId: undefined };
    const guildName =
      readGuilds(doc).find((g) => g.guildId === location.guildId)?.name ||
      undefined;

    const lines = collectLines(dialog);
    /** Card roots = largest single-"Copy Link" subtrees of the dialog. */
    const copyEls = [];
    for (const el of dialog.querySelectorAll('button, [role="button"], a')) {
      if (textOf(el) === EVENT_COPY_LINK_TEXT) copyEls.push(el);
    }
    const roots =
      copyEls.length > 1
        ? copyEls.map((el) => {
            let root = el;
            for (
              let p = el.parentElement;
              p && p !== dialog;
              p = p.parentElement
            ) {
              if (copyEls.filter((o) => containsEl(p, o)).length !== 1) break;
              root = p;
            }
            return root;
          })
        : [dialog]; // one (or no) "Copy Link": the dialog is one card

    const cardLines = roots.map(() => /** @type {any[]} */ ([]));
    let cur = -1;
    for (const ln of lines) {
      const idx = roots.findIndex((r) => ln.el && containsEl(r, ln.el));
      if (idx !== -1) cur = idx;
      if (cur === -1) continue; // dialog chrome before the first card
      cardLines[cur].push(ln);
    }

    let tz;
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      /* tolerate */
    }
    return {
      v: 1,
      type: "events",
      location,
      tz: tz || "America/Toronto",
      modal,
      guildName,
      cards: roots.map((root, i) => ({
        lines: cardLines[i].map(({ text, heading, icon }) => ({
          text,
          heading,
          icon,
        })),
        interested: interestedState(root),
        eventRef: eventRefOf(root),
      })),
    };
  } catch {
    return null;
  }
}
