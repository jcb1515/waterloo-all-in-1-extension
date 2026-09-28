// @ts-check
/*
  "Check readers" registry (W1): one entry per site source, each pairing the
  source's probe + CHECKLIST (written by the owning stream) or — for Learn
  and Portal, which have no DOM probe — a W1 checklist satisfied by
  readStats. Everything here is pure so the recorder, background and tests
  can share it.
*/

import { probe as emailProbe, CHECKLIST as EMAIL_CHECKLIST } from "./email/probe.js";
import { probe as outlineProbe, CHECKLIST as OUTLINE_CHECKLIST } from "./outline/probe.js";
import { probe as wwProbe, CHECKLIST as WW_CHECKLIST } from "./waterlooworks/probe.js";
import { probe as discordProbe, CHECKLIST as DISCORD_CHECKLIST } from "./discord/probe.js";
import { probe as gcalProbe, CHECKLIST as GCAL_CHECKLIST } from "./gcal/probe.js";

/**
 * @typedef {{page: string, counts: Record<string, number>, ok: boolean,
 *   hints: string[]}} ProbeResult
 * @typedef {{id: string, label: string, how: string, page?: string,
 *   url?: string, essential?: boolean, refreshDays?: number,
 *   stat?: {kind: "observe"|"sync", scope?: string, itemsMin?: number,
 *   maxAgeMin?: number}}} CheckRow
 *   - url        https page the "Open" button opens (deep stable link, no token)
 *   - essential  row joins the first-run "Get set up" checklist (1–3 per source)
 *   - refreshDays  last good read older than this earns a "Needs a visit" nudge
 * @typedef {{source: string, at: string, kind: "observe"|"sync",
 *   path?: string, scope?: string, items?: number, error?: string}} ReadStat
 */

/**
 * Portal's single checklist row: any open Portal page fetches schedule,
 * exams and term dates (W2's auto-fetch, sources/portal/content.js).
 * @type {CheckRow}
 */
export const PORTAL_OPEN_ROW = {
  id: "portal-open",
  label: "Open Portal once",
  how: "Open any Portal page — your schedule, exams and term dates are read while it's open.",
  url: "https://portal.uwaterloo.ca/",
  essential: true,
  refreshDays: 14,
  stat: { kind: "observe", scope: "portal:schedule", itemsMin: 1 },
};

/**
 * Learn/Portal have no content-script probe — their rows are satisfied by
 * readStats written from handleObserved/doSync.
 * @type {Record<string, {probe: ((doc: any, href: string) => ProbeResult) | null, checklist: CheckRow[]}>}
 */
export const CHECK_SOURCES = {
  learn: {
    probe: null,
    checklist: [
      {
        id: "learn-home",
        label: "Learn home",
        how: "Open learn.uwaterloo.ca — deadlines and courses read on the next sync.",
        url: "https://learn.uwaterloo.ca/d2l/home",
        essential: true,
        stat: { kind: "sync", itemsMin: 1, maxAgeMin: 30 },
      },
      {
        id: "learn-course",
        label: "A course page",
        how: "Open a course so its content can be read.",
        stat: { kind: "sync", itemsMin: 1, maxAgeMin: 30 },
      },
    ],
  },
  portal: {
    probe: null,
    checklist: [PORTAL_OPEN_ROW],
  },
  outline: { probe: outlineProbe, checklist: OUTLINE_CHECKLIST },
  waterlooworks: { probe: wwProbe, checklist: WW_CHECKLIST },
  discord: { probe: discordProbe, checklist: DISCORD_CHECKLIST },
  gcal: { probe: gcalProbe, checklist: GCAL_CHECKLIST },
  gmail: {
    probe: emailProbe,
    checklist: EMAIL_CHECKLIST.filter((r) => r.id.startsWith("gmail")),
  },
  outlook: {
    probe: emailProbe,
    checklist: EMAIL_CHECKLIST.filter((r) => r.id.startsWith("outlook")),
  },
};

/**
 * Checklist rows whose probe page kind doesn't equal row.id/row.page —
 * where a nearby page kind satisfies them.
 * @type {Record<string, Record<string, string>>}
 */
const PAGE_ALIAS = {
  waterlooworks: { "application-detail": "applications" },
  discord: {
    timestamp: "channel",
    events: "events-modal",
    "event-detail": "events-modal",
  },
};

/**
 * The probe-page key a checklist row reads — row.page, then a PAGE_ALIAS
 * entry, then row.id. Shared by the checklist and the onboarding model.
 * @param {string} source @param {CheckRow} row
 */
export function checkRowPage(source, row) {
  return row.page || (PAGE_ALIAS[source] && PAGE_ALIAS[source][row.id]) || row.id;
}

/** Extra count requirements for aliased rows (row must see this counter > 0). */
const COUNT_REQ = {
  discord: { timestamp: "messageTimes" },
  // "One open event" rides the gcal-week probe page; it only passes when a
  // detail popup was actually open.
  gcal: { "gcal-event": "detailPopup" },
};

/**
 * Probe-checklist rows with no probeable page (e.g. Discord's Inbox →
 * Mentions isn't a DOM page the recorder probes; it's read by the passive
 * sweep) are satisfied by a recent readStats entry instead.
 * @type {Record<string, Record<string, any>>}
 */
const ROW_STAT = {
  discord: {
    mentions: { kind: "observe", scope: "discord", itemsMin: 0, maxAgeMin: 30 },
  },
};

/**
 * The probe entry for a site (recorder.content.js runs it on the page).
 * @param {string} site
 */
export function probeFor(site) {
  const s = CHECK_SOURCES[site];
  return s && typeof s.probe === "function" ? s.probe : null;
}

const RECENT_STAT_MS = 10 * 60 * 1000;

/**
 * Does a readStats entry satisfy a checklist row's stat rule?
 * @param {ReadStat} st @param {any} rule @param {number} nowMs
 */
function statMatches(st, rule, nowMs) {
  if (!st || !rule) return false;
  if (st.error) return false;
  if (st.kind !== rule.kind) return false;
  if (rule.scope && st.scope !== rule.scope) return false;
  if ((st.items || 0) < (rule.itemsMin != null ? rule.itemsMin : 1)) return false;
  const at = Date.parse(st.at || "");
  if (Number.isNaN(at)) return false;
  return nowMs - at <= (rule.maxAgeMin != null ? rule.maxAgeMin : 30) * 60000;
}

/**
 * One checklist row's status.
 *   ok        the reader saw what it expects (probe.ok), or the stat rule hit
 *   fail      a probe ran and reported not-ok — its hints explain why
 *   unchecked nothing probed or read yet
 * @param {CheckRow} row
 * @param {Record<string, ProbeResult & {at?: string}>} probeByPage  probes[source]
 * @param {ReadStat[]} stats  readStats entries for this source
 * @param {Date|number} now
 * @param {string} source
 * @returns {{status: "ok"|"fail"|"unchecked", text: string,
 *   counts?: Record<string, number>, hints?: string[]}}
 */
export function checklistRowStatus(row, probeByPage = {}, stats = [], now = new Date(), source = "") {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const statRule = row.stat || ((ROW_STAT[source] || {})[row.id]);
  const stat = (Array.isArray(stats) ? stats : []).find((st) => statMatches(st, statRule, nowMs));
  // "· N items" comes from a recent read for this source — any kind — so a
  // probe-verified row can show what the ingest pulled in.
  const recent = (Array.isArray(stats) ? stats : []).find(
    (st) =>
      st &&
      !st.error &&
      (st.items || 0) > 0 &&
      nowMs - Date.parse(st.at || "") <= RECENT_STAT_MS
  );
  const pageKey = checkRowPage(source, row);
  const hit = probeByPage && probeByPage[pageKey];

  if (hit) {
    const reqCount = COUNT_REQ[source] && COUNT_REQ[source][row.id];
    const countOk = !reqCount || ((hit.counts || {})[reqCount] || 0) > 0;
    if (hit.ok && countOk) {
      const counts = hit.counts || {};
      const rowsN = counts.rows ?? counts.listRows ?? counts.messageRows ?? counts.scheduleRows ?? counts.eventCards ?? counts.eventChips;
      const parts = ["Read OK"];
      if (typeof rowsN === "number") parts.push(`${rowsN} row${rowsN === 1 ? "" : "s"}`);
      const items = (stat && stat.items) || (recent && recent.items);
      if (items) parts.push(`${items} item${items === 1 ? "" : "s"}`);
      return { status: "ok", text: parts.join(" · "), counts };
    }
    return {
      status: "fail",
      text: (hit.hints && hit.hints[0]) || "The reader didn't see what it expects here.",
      counts: hit.counts || {},
      hints: hit.hints || [],
    };
  }
  if (stat) {
    return {
      status: "ok",
      text: `Read OK · ${stat.items} item${stat.items === 1 ? "" : "s"} · recently`,
    };
  }
  return { status: "unchecked", text: "Not checked yet" };
}

/**
 * All of a source's checklist rows with their statuses.
 * @param {string} source
 * @param {Record<string, ProbeResult>} probeByPage
 * @param {ReadStat[]} stats
 * @param {Date|number} now
 */
export function checklistFor(source, probeByPage = {}, stats = [], now = new Date()) {
  const entry = CHECK_SOURCES[source];
  if (!entry) return [];
  return entry.checklist.map((row) => ({
    row,
    ...checklistRowStatus(row, probeByPage, stats, now, source),
  }));
}

/**
 * Fold a wa1:probe message into the stored probes map — keeps only the
 * latest result per page. Returns the next map.
 * @param {Record<string, Record<string, any>>} probes
 * @param {{source: string, page: string, counts?: any, ok?: boolean, hints?: string[], at?: string}} msg
 */
export function recordProbe(probes = {}, msg) {
  if (!msg || !msg.source || !msg.page) return probes;
  return {
    ...probes,
    [msg.source]: {
      ...(probes[msg.source] || {}),
      [msg.page]: {
        counts: msg.counts || {},
        ok: !!msg.ok,
        hints: Array.isArray(msg.hints) ? msg.hints : [],
        at: msg.at || new Date().toISOString(),
      },
    },
  };
}

/** readStats keeps the last 40 observe/sync results. */
export const READ_STATS_CAP = 40;

/**
 * @param {ReadStat[]} list
 * @param {ReadStat} entry
 * @returns {ReadStat[]} capped, newest last
 */
export function appendReadStat(list = [], entry) {
  return [...(Array.isArray(list) ? list : []), entry].slice(-READ_STATS_CAP);
}

/**
 * Recorder probe throttle: send at most once per `minIntervalMs` per tab,
 * and never repeat an unchanged result.
 * @param {{at: number, json: string}} last
 * @param {string} json  JSON of the parts that make a result "the same"
 * @param {number} nowMs
 * @param {number} [minIntervalMs]
 */
export function shouldSendProbe(last, json, nowMs, minIntervalMs = 5000) {
  if (!last || last.json === json) return false;
  return nowMs - (last.at || 0) >= minIntervalMs;
}

/**
 * The report the "Download check report" button writes: probes + readStats
 * + checklist statuses + the saved page structures. Counts and redacted
 * outlines only — never page text.
 * @param {object} p
 * @param {Record<string, Record<string, any>>} [p.probes]
 * @param {ReadStat[]} [p.readStats]
 * @param {Record<string, any>} [p.discovery]  discovery:<site> records
 * @param {Date|number} [p.now]
 */
export function checkReport({ probes = {}, readStats = [], discovery = {}, now = new Date() }) {
  /** @type {Record<string, any>} */
  const sources = {};
  for (const source of Object.keys(CHECK_SOURCES)) {
    const stats = (readStats || []).filter((s) => s && s.source === source);
    const rows = checklistFor(source, probes[source] || {}, stats, now);
    sources[source] = {
      rows: rows.map((r) => ({
        id: r.row.id,
        label: r.row.label,
        status: r.status,
        text: r.text,
      })),
      probes: probes[source] || {},
      readStats: stats.slice(-10),
    };
  }
  // Discovery records are already redacted; strip bulky variants' hashes.
  /** @type {Record<string, any>} */
  const structures = {};
  for (const [key, rec] of Object.entries(discovery || {})) {
    if (!key.startsWith("discovery:")) continue;
    const site = key.slice(10);
    const pages = Object.entries((rec && rec.pages) || {}).map(([path, p]) => ({
      path,
      count: p && p.count,
      lastAt: p && p.lastAt,
      note: p && p.note,
      variants: ((p && p.variants) || []).map((v) => ({
        count: v && v.count,
        lastAt: v && v.lastAt,
        outline: v && v.outline,
      })),
    }));
    if (pages.length) structures[site] = { pages };
  }
  return {
    kind: "waterloo-all-in-1-check",
    at: (now instanceof Date ? now : new Date(now)).toISOString(),
    sources,
    structures,
  };
}
