// @ts-check
/*
  Background side of the discovery recorder. recorder.content.js sends
  redacted entries here; they are batched per site (flush every 2 s or at 50
  pending) and accumulate under chrome.storage.local "discovery:<site>":

    { site, startedAt, updatedAt, extensionVersion,
      net:   { "<method> <endpoint> <status>":
                 {method, endpoint, status, contentType, size,
                  count, firstAt, lastAt,
                  variants: [{hash, shape, count, lastAt}]} },
      pages: { "<path>":
                 {path, title, count, firstAt, lastAt,
                  variants: [{hash, outline, count, lastAt}]} } }

  Each record keeps at most 3 shape/outline variants (lowest count evicts,
  ties by oldest lastAt). Capped at 500 net records and 200 page records per
  site, evicting the stalest. Shapes larger than MAX_SHAPE_CHARS are stored
  as a truncation marker with their top-level keys. The options page turns
  this into the downloadable discovery report.
*/

import { MSG } from "../core/contract.js";
import { hashString } from "./redact.js";

const NET_CAP = 500;
const PAGE_CAP = 200;
const MAX_VARIANTS = 3;
const MAX_SHAPE_CHARS = 150000;
const FLUSH_MS = 2000;
const FLUSH_AT = 50;

const nowIso = () => new Date().toISOString();

/** @typedef {{hash: string, count: number, lastAt: string} & Record<string, any>} Variant */

/**
 * @typedef {Object} NetRecord
 * @property {string} method
 * @property {string} endpoint
 * @property {number|string} status
 * @property {string} contentType
 * @property {number} size
 * @property {number} count
 * @property {string} firstAt
 * @property {string} lastAt
 * @property {Variant[]} variants
 */

/**
 * @typedef {Object} PageRecord
 * @property {string} path
 * @property {string} title
 * @property {number} count
 * @property {string} firstAt
 * @property {string} lastAt
 * @property {string} [note]
 * @property {Variant[]} variants
 */

/**
 * @typedef {Object} DiscoveryRecord
 * @property {string} site
 * @property {string} startedAt
 * @property {string} [updatedAt]
 * @property {string} [extensionVersion]
 * @property {Record<string, NetRecord>} net
 * @property {Record<string, PageRecord>} pages
 */

/**
 * The value to store for a variant's shape/outline: itself, or a truncation
 * marker when its JSON is too large to be useful.
 * @param {any} shape
 */
function storedShape(shape) {
  const json = JSON.stringify(shape);
  if (json.length <= MAX_SHAPE_CHARS) return { hash: hashString(json), stored: shape };
  const topKeys = shape && typeof shape === "object" && !Array.isArray(shape)
    ? Object.keys(shape).slice(0, 50)
    : [];
  return { hash: hashString(json), stored: { truncated: true, chars: json.length, topKeys } };
}

/**
 * Adds a variant to a record, merging by hash and capping at MAX_VARIANTS
 * (evicts the lowest count, ties by oldest lastAt).
 * @param {Variant[]} variants
 * @param {string} field "shape" or "outline"
 * @param {any} shape
 * @param {string} now
 */
function addVariant(variants, field, shape, now) {
  const { hash, stored } = storedShape(shape);
  const v = variants.find((x) => x.hash === hash);
  if (v) {
    v.count += 1;
    v.lastAt = now;
    return;
  }
  variants.push({ hash, [field]: stored, count: 1, lastAt: now });
  if (variants.length > MAX_VARIANTS) {
    let worst = 0;
    for (let i = 1; i < variants.length; i++) {
      const a = variants[i];
      const b = variants[worst];
      if (a.count < b.count || (a.count === b.count && a.lastAt < b.lastAt)) worst = i;
    }
    variants.splice(worst, 1);
  }
}

/**
 * Keeps a record map at or below `cap` by evicting the stalest entries.
 * @param {Record<string, {lastAt: string}>} map
 * @param {number} cap
 */
function capRecords(map, cap) {
  const keys = Object.keys(map);
  if (keys.length <= cap) return;
  keys.sort((a, b) => (map[a].lastAt < map[b].lastAt ? -1 : map[a].lastAt > map[b].lastAt ? 1 : 0));
  for (const k of keys.slice(0, keys.length - cap)) delete map[k];
}

/**
 * Merges a batch of discovery entries into a site's stored record. Pure —
 * no chrome APIs — so tests can drive it directly.
 * @param {DiscoveryRecord} data
 * @param {Array<any>} entries
 * @param {string} now ISO timestamp used for this batch
 * @returns {DiscoveryRecord}
 */
export function mergeEntries(data, entries, now) {
  if (!data.net || typeof data.net !== "object") data.net = {};
  if (!data.pages || typeof data.pages !== "object") data.pages = {};
  for (const entry of entries || []) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.kind === "net") {
      const k = `${entry.method} ${entry.endpoint} ${entry.status}`;
      /** @type {NetRecord} */
      const rec = data.net[k] || (data.net[k] = {
        method: entry.method,
        endpoint: entry.endpoint,
        status: entry.status,
        contentType: "",
        size: 0,
        count: 0,
        firstAt: now,
        lastAt: now,
        variants: [],
      });
      rec.count += 1;
      rec.lastAt = now;
      rec.contentType = entry.contentType || rec.contentType;
      rec.size = entry.size || rec.size;
      addVariant(rec.variants, "shape", entry.shape, now);
      capRecords(data.net, NET_CAP);
    } else if (entry.kind === "page") {
      /** @type {PageRecord} */
      const rec = data.pages[entry.path] || (data.pages[entry.path] = {
        path: entry.path,
        title: "",
        count: 0,
        firstAt: now,
        lastAt: now,
        variants: [],
      });
      rec.count += 1;
      rec.lastAt = now;
      rec.title = entry.title || rec.title;
      if (typeof entry.note === "string" && entry.note) rec.note = entry.note;
      addVariant(rec.variants, "outline", entry.outline, now);
      capRecords(data.pages, PAGE_CAP);
    }
  }
  return data;
}

/* --------------------------- background I/O --------------------------- */

/** Writes go through one queue so concurrent flushes can't clobber each other. */
let queue = Promise.resolve();
/**
 * @param {() => Promise<any>} fn
 */
function enqueue(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

/** @type {Map<string, {entries: any[], timer: ReturnType<typeof setTimeout> | null}>} */
const pending = new Map();

/**
 * Handles wa1:discovery and wa1:tab-ready messages.
 * @returns {boolean} true if this module claimed the message.
 */
export function handleDiscoveryMessage(msg) {
  if (!msg || (msg.type !== MSG.DISCOVERY && msg.type !== MSG.TAB_READY)) return false;
  if (msg.type === MSG.TAB_READY) {
    console.log(`[wa1] tab ready: ${msg.source} ${msg.url || ""}`);
    return true;
  }
  if (!msg.site || !msg.entry || !msg.entry.kind) return true;
  const site = String(msg.site);
  let buf = pending.get(site);
  if (!buf) {
    buf = { entries: [], timer: null };
    pending.set(site, buf);
  }
  buf.entries.push(msg.entry);
  if (buf.entries.length >= FLUSH_AT) {
    flushSite(site);
  } else if (!buf.timer) {
    buf.timer = setTimeout(() => flushSite(site), FLUSH_MS);
  }
  return true;
}

/** Moves a site's pending entries into the write queue. */
function flushSite(site) {
  const buf = pending.get(site);
  if (!buf) return;
  pending.delete(site);
  if (buf.timer) clearTimeout(buf.timer);
  if (!buf.entries.length) return;
  const entries = buf.entries;
  enqueue(() => flushNow(site, entries)).catch((e) => console.warn("[wa1] discovery store", e));
}

/**
 * One get/merge/set per flush.
 * @param {string} site
 * @param {any[]} entries
 */
async function flushNow(site, entries) {
  const key = `discovery:${site}`;
  const all = await chrome.storage.local.get(key);
  const now = nowIso();
  /** @type {DiscoveryRecord} */
  const data = /** @type {any} */ (all[key]) || { site, startedAt: now, net: {}, pages: {} };
  mergeEntries(data, entries, now);
  data.updatedAt = now;
  try {
    data.extensionVersion = chrome.runtime.getManifest().version;
  } catch {
    /* context invalidated */
  }
  await chrome.storage.local.set({ [key]: data });
}
