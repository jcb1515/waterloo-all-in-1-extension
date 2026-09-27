// @ts-check
/*
  Background side of the discovery recorder. recorder.content.js sends
  redacted entries here; they accumulate per site under
  chrome.storage.local "discovery:<site>":

    { site, startedAt, updatedAt, extensionVersion,
      net:   { "<method> <endpoint> <status> <shapeHash>": {entry, count, firstAt, lastAt} },
      pages: { "<path> <outlineHash>":                     {entry, count, firstAt, lastAt} } }

  Capped at 500 net entries and 200 pages per site, evicting the stalest.
  The options page turns this into the downloadable discovery report.
*/

import { MSG } from "../core/contract.js";
import { hashString } from "./redact.js";

const NET_CAP = 500;
const PAGE_CAP = 200;

const nowIso = () => new Date().toISOString();

/** @typedef {{entry: any, count: number, firstAt: string, lastAt: string}} DiscoveryRecordEntry */
/**
 * @typedef {Object} DiscoveryRecord
 * @property {string} site
 * @property {string} startedAt
 * @property {string} [updatedAt]
 * @property {string} [extensionVersion]
 * @property {Record<string, DiscoveryRecordEntry>} net
 * @property {Record<string, DiscoveryRecordEntry>} pages
 */

/** Writes go through one queue so concurrent tabs can't clobber each other. */
let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

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
  enqueue(() => storeEntry(msg.site, msg.entry)).catch((e) => console.warn("[wa1] discovery store", e));
  return true;
}

/**
 * @param {string} site
 * @param {{kind: string, method?: string, endpoint?: string, status?: number, shape?: any, path?: string, outline?: any}} entry
 */
async function storeEntry(site, entry) {
  const key = `discovery:${site}`;
  const all = await chrome.storage.local.get(key);
  /** @type {DiscoveryRecord} */
  const data = /** @type {any} */ (all[key]) || { site, startedAt: nowIso(), net: {}, pages: {} };
  const now = nowIso();
  if (entry.kind === "net") {
    const k = `${entry.method} ${entry.endpoint} ${entry.status} ${hashString(JSON.stringify(entry.shape))}`;
    upsert(data.net, k, entry, now, NET_CAP);
  } else if (entry.kind === "page") {
    const k = `${entry.path} ${hashString(JSON.stringify(entry.outline))}`;
    upsert(data.pages, k, entry, now, PAGE_CAP);
  } else {
    return;
  }
  data.updatedAt = now;
  data.extensionVersion = chrome.runtime.getManifest().version;
  await chrome.storage.local.set({ [key]: data });
}

/**
 * @param {Record<string, DiscoveryRecordEntry>} map
 * @param {string} k
 * @param {any} entry
 * @param {string} now
 * @param {number} cap
 */
function upsert(map, k, entry, now, cap) {
  const cur = map[k];
  if (cur) {
    cur.entry = entry;
    cur.count += 1;
    cur.lastAt = now;
    return;
  }
  map[k] = { entry, count: 1, firstAt: now, lastAt: now };
  const keys = Object.keys(map);
  if (keys.length > cap) {
    let oldest = keys[0];
    for (const other of keys) if (map[other].lastAt < map[oldest].lastAt) oldest = other;
    delete map[oldest];
  }
}
