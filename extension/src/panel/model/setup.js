// @ts-check
/*
  Pure model for the panel's setup controls: the Discord channel picker and
  the patch builders that write the whole-map settings tables
  (channelTargets, outline urls, profile sections/groups). The store replaces
  those tables wholesale, so every helper here returns the FULL next map —
  callers pass it straight to saveSettings. No DOM, no chrome.*.
*/

import { normCourseCode } from "../../core/contract.js";
import {
  compareGuildNames,
  watchConfig,
  watchForGuild,
  NEVER_SUGGEST_TYPES,
} from "../../sources/discord/rules.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/* ------------------------------- Discord ------------------------------- */

/**
 * Per-guild channel-picker rows: watched guilds only, channels sorted by
 * category then sidebar order, voice/stage excluded. `checked` comes from
 * `watchForGuild` with the resolved settings (targets or the watched entry's
 * channels), `suggested` from a bare `watchForGuild` — both computed live,
 * never from the possibly-stale `state.watch`.
 * @param {any} discordState  sourceState.discord.state
 * @param {any} discordSettings  settings.sources.discord
 * @returns {{
 *   guildId: string, name: string, mode: "auto"|"custom", noInventory: boolean,
 *   channels: {id: string, name: string, category: string, checked: boolean, suggested: boolean}[]
 * }[]}
 */
export function channelPicker(discordState, discordSettings) {
  const guilds = isObj(discordState?.guilds) ? discordState.guilds : {};
  const watched = isObj(discordSettings?.watched) ? discordSettings.watched : {};
  const targets = isObj(discordSettings?.channelTargets)
    ? discordSettings.channelTargets
    : {};
  const cmp = compareGuildNames(watched);
  const out = [];
  for (const [guildId, g] of Object.entries(guilds)) {
    const cfg = watchConfig(g?.name || "", watched, targets);
    if (!cfg) continue; // an exclusive watched list dropped this guild
    const all = Object.entries(isObj(g?.channels) ? g.channels : {});
    const channels = all
      .filter(
        ([, c]) =>
          !NEVER_SUGGEST_TYPES.includes(String(c?.type || "").toLowerCase())
      )
      .sort(
        (a, b) =>
          String(a[1]?.category || "").localeCompare(String(b[1]?.category || "")) ||
          (a[1]?.order ?? 0) - (b[1]?.order ?? 0)
      );
    const checked = new Set(watchForGuild(g, cfg.focus, cfg.settings).channelIds);
    const suggested = new Set(watchForGuild(g, cfg.focus).channelIds);
    out.push({
      guildId,
      name: g?.name || cfg.team || guildId,
      mode: cfg.settings?.channels?.length ? "custom" : "auto",
      noInventory: !g?.lastInventoryAt,
      channels: channels.map(([id, c]) => ({
        id,
        name: c?.name || id,
        category: c?.category || "",
        checked: checked.has(id),
        suggested: suggested.has(id),
      })),
    });
  }
  out.sort((a, b) => cmp(a.name, b.name));
  return out;
}

/**
 * Tick/untick one channel for a guild -> the full next `channelTargets` map.
 * In auto mode the list is seeded from what's checked now; in custom mode
 * the stored entries are kept (they may be names or ids) minus anything that
 * resolves to this channel. An emptied list is dropped from the map, which
 * returns the guild to automatic mode.
 * @param {any} discordSettings  settings.sources.discord
 * @param {ReturnType<typeof channelPicker>[number]} pickerGuild
 * @param {string} channelId
 * @param {boolean} checked
 * @returns {Record<string, string[]>}
 */
export function toggleChannelPatch(discordSettings, pickerGuild, channelId, checked) {
  const targets = {
    ...(isObj(discordSettings?.channelTargets) ? discordSettings.channelTargets : {}),
  };
  const gname = String(pickerGuild?.name || "").trim();
  const lower = gname.toLowerCase();
  const key = Object.keys(targets).find(
    (k) => k.trim().toLowerCase() === lower
  );
  const cid = String(channelId);
  const ch = Array.isArray(pickerGuild?.channels)
    ? pickerGuild.channels.find((c) => String(c?.id) === cid)
    : null;
  // An entry "resolves to" this channel when it names its id or its name.
  const resolvesHere = (/** @type {any} */ entry) => {
    const e = String(entry).trim().toLowerCase();
    return e === cid.toLowerCase() || (!!ch && e === String(ch.name || "").toLowerCase());
  };
  /** @type {string[]} */
  let list;
  if (key != null && Array.isArray(targets[key])) {
    // Custom via channelTargets: keep stored entries, drop this channel's.
    list = targets[key].map(String).filter((e) => !resolvesHere(e));
  } else if (pickerGuild?.mode === "custom") {
    // Custom via a watched entry's channels: carry those entries over so
    // stored names (incl. unresolved ones) survive the move to targets.
    const wkey = Object.keys(
      isObj(discordSettings?.watched) ? discordSettings.watched : {}
    ).find((k) => k.trim().toLowerCase() === lower);
    const entryList = wkey != null ? discordSettings.watched[wkey]?.channels : null;
    list = (Array.isArray(entryList) ? entryList : [])
      .map(String)
      .filter((e) => !resolvesHere(e));
  } else {
    // Automatic: seed from the currently checked channels, then toggle.
    list = (Array.isArray(pickerGuild?.channels) ? pickerGuild.channels : [])
      .filter((c) => c.checked && String(c.id) !== cid)
      .map((c) => String(c.id));
  }
  if (checked && !list.some((e) => e.trim().toLowerCase() === cid.toLowerCase())) {
    list.push(cid);
  }
  if (list.length) targets[key ?? gname] = list;
  else if (key != null) delete targets[key];
  return targets;
}

/**
 * Remove a guild's channel targets -> the full next `channelTargets` map.
 * The guild returns to automatic suggestions.
 * @param {any} discordSettings
 * @param {string} guildName
 */
export function resetChannelsPatch(discordSettings, guildName) {
  const targets = {
    ...(isObj(discordSettings?.channelTargets) ? discordSettings.channelTargets : {}),
  };
  const lower = String(guildName || "").trim().toLowerCase();
  for (const k of Object.keys(targets)) {
    if (k.trim().toLowerCase() === lower) delete targets[k];
  }
  return targets;
}

/* ------------------------------- outlines ------------------------------ */

/**
 * Set/remove one course's outline URL -> the full next `urls` map.
 * @param {any} settings
 * @param {string} code  course code (normalised)
 * @param {string | null} url  null/empty removes the entry
 */
export function outlineUrlPatch(settings, code, url) {
  const urls = {
    ...(isObj(settings?.sources?.outline?.urls) ? settings.sources.outline.urls : {}),
  };
  const key = normCourseCode(code);
  const v = url == null ? "" : String(url).trim();
  if (!key) return urls;
  if (v) urls[key] = v;
  else delete urls[key];
  return urls;
}

/* ---------------------------- sections/groups --------------------------- */

/**
 * "lec 002, tut 104" -> the full next `profile.sections` map with
 * {code: ["LEC 002", "TUT 104"]} (uppercase, single spaces). Empty text
 * removes the course's entry.
 * @param {any} settings
 * @param {string} code
 * @param {string} text
 */
export function sectionsPatch(settings, code, text) {
  const sections = {
    ...(isObj(settings?.profile?.sections) ? settings.profile.sections : {}),
  };
  const key = normCourseCode(code);
  const list = String(text || "")
    .split(",")
    .map((s) => s.trim().replace(/\s+/g, " ").toUpperCase())
    .filter(Boolean);
  if (!key) return sections;
  if (list.length) sections[key] = list;
  else delete sections[key];
  return sections;
}

/**
 * Set/remove one course's group label -> the full next `profile.groups` map.
 * @param {any} settings
 * @param {string} code
 * @param {string} value  empty removes the entry
 */
export function groupPatch(settings, code, value) {
  const groups = {
    ...(isObj(settings?.profile?.groups) ? settings.profile.groups : {}),
  };
  const key = normCourseCode(code);
  const v = String(value ?? "").trim();
  if (!key) return groups;
  if (v) groups[key] = v;
  else delete groups[key];
  return groups;
}

/* --------------------------------- term -------------------------------- */

const TERM_NAMES = /** @type {Record<number, string>} */ ({
  1: "Winter",
  5: "Spring",
  9: "Fall",
});

/** 1269 -> "Fall 2026 (1269)" */
export function termLabel(code) {
  const s = String(code);
  if (s.length !== 4) return String(code);
  const yy = Number(s.slice(1, 3));
  const mm = Number(s[3]);
  const name = TERM_NAMES[mm] || `Term ${mm}`;
  return `${name} ${2000 + yy} (${code})`;
}
