// @ts-check
// Live DevTools console — navigation allowed, no actions.
//
// Talks to the user's Edge over the DevTools protocol at 127.0.0.1:9222.
// Hard rules (see README):
//   * `open` creates NEW tabs only, for allowlisted pages only — it never
//     takes over, navigates, or closes the user's own tabs;
//   * `close`/`scroll` only touch tabs this tool opened (recorded in
//     captures/live/.opened.json);
//   * no input events, clicks, typing or form submits anywhere;
//   * never anything on discord.com — the user opens Discord pages;
//   * raw captures go to captures/live/ (gitignored), outside git.
//
// Usage: npm run live -- <cmd>
//   tabs                          list page targets (id, host, path)
//   open <url|source:rowId>       new tab for an allowlisted page
//   close <targetId|all-mine>     close only tabs this tool opened
//   scroll <targetId> [px]        scroll a tool-opened tab (default 1200)
//   dump <urlSub> [--name x]      save document HTML to captures/live/
//   probe <urlSub>                dump + run the source's probe/parser
//   storage [key] [--source id] [--ext id]  read chrome.storage.local (SW)
//   watch [--source id] [--secs] [--ext id] poll storage, print changes
//   reload-ext [--ext id]                   chrome.runtime.reload() in our own SW
//   screenshot <extPath> [--width n] [--height n] [--name x] [--ext id]
//                                           PNG of an extension page -> captures/live/
//   (WA1_EXT_ID selects a copy too — two unpacked dists can be loaded)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseHTML } from "linkedom";
import { SITE_BY_HOST } from "../../extension/src/core/contract.js";

const DEBUGGER = process.env.WA1_CDP || "http://127.0.0.1:9222";
const EXT_NAME = "Waterloo All-in-1";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIVE_DIR = path.join(ROOT, "captures", "live");
const SETUP_HINT =
  "Launch the dedicated debug profile (see tools/live/README.md): " +
  '& "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" ' +
  '--remote-debugging-port=9222 --user-data-dir="$env:LOCALAPPDATA\\wa1-edge-debug" ' +
  "— Edge ignores the port flag on the default profile since Chromium 136.";

/* ------------------------------- pure parts ------------------------------ */

/** Page targets only, described as {id, host, path} — query strings dropped. */
export function pageTargets(targets) {
  return (Array.isArray(targets) ? targets : [])
    .filter((t) => t && t.type === "page" && typeof t.url === "string")
    .map((t) => {
      let u = null;
      try {
        u = new URL(t.url);
      } catch {
        /* ignore malformed */
      }
      return {
        id: String(t.id || ""),
        url: t.url,
        title: String(t.title || ""),
        host: u ? u.host : "",
        path: u ? u.pathname.replace(/\/+$/, "") || "/" : "",
      };
    });
}

/** First page target whose URL contains `sub` (case-insensitive). */
export function pickPage(targets, sub) {
  const want = String(sub || "").toLowerCase();
  return pageTargets(targets).find((t) => t.url.toLowerCase().includes(want)) || null;
}

/** hostname -> SourceId via the contract map. */
export function sourceForUrl(url) {
  try {
    return SITE_BY_HOST[new URL(url).hostname] || null;
  } catch {
    return null;
  }
}

/** Items attributed to a source — canonical `source` or a `seenIn` entry. */
export function filterBySource(items, sourceId) {
  const want = String(sourceId || "");
  return Object.values(items || {}).filter(
    (it) =>
      it &&
      (it.source === want ||
        (Array.isArray(it.seenIn) && it.seenIn.some((s) => s && s.source === want))),
  );
}

/** Count items by type. */
export function countByType(items) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const it of items || []) {
    const t = String((it && it.type) || "?");
    out[t] = (out[t] || 0) + 1;
  }
  return out;
}

const TORONTO_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Toronto",
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** Full Toronto date+time, or "-" when the item carries none. */
export function fmtWhen(item) {
  const iso = item && (item.startAt || item.dueAt || item.endAt || item.date);
  const ms = iso ? Date.parse(String(iso)) : NaN;
  return Number.isFinite(ms) ? TORONTO_FMT.format(new Date(ms)) : "-";
}

/** `type | full Toronto date+time | title truncated to 40`. */
export function fmtRow(item) {
  const title = String((item && item.title) || "?").replace(/\s+/g, " ").trim();
  return `${item?.type || "?"} | ${fmtWhen(item)} | ${title.slice(0, 40)}`;
}

/** chrome-extension service-worker candidates (manifest verified separately). */
export function serviceWorkerTargets(targets) {
  return (Array.isArray(targets) ? targets : []).filter(
    (t) =>
      t &&
      t.type === "service_worker" &&
      typeof t.url === "string" &&
      t.url.startsWith("chrome-extension://"),
  );
}

/** The extension id a service-worker target belongs to ("" if malformed). */
export function swExtId(target) {
  try {
    return new URL(String(target && target.url)).host;
  } catch {
    return "";
  }
}

/**
 * Non-service-worker targets under an extension id — an offscreen document
 * or an open extension page that can wake a sleeping/dead MV3 worker.
 * @param {any[]} targets @param {string} extId
 */
export function extPageTargets(targets, extId) {
  const prefix = `chrome-extension://${String(extId || "").toLowerCase()}/`;
  return (Array.isArray(targets) ? targets : []).filter(
    (t) =>
      t &&
      t.type !== "service_worker" &&
      typeof t.url === "string" &&
      t.url.toLowerCase().startsWith(prefix),
  );
}

/**
 * Narrow service-worker candidates by an extension-id selector
 * (--ext <id> / WA1_EXT_ID). No selector keeps them all; a selector must
 * match at least one or the caller reports the miss.
 * @returns {{candidates: any[]} | {error: string}}
 */
export function pickServiceWorker(targets, extId) {
  const sws = Array.isArray(targets) ? targets : [];
  if (!extId) return { candidates: sws };
  const hit = sws.filter((sw) => swExtId(sw) === extId);
  return hit.length
    ? { candidates: hit }
    : { error: `no service worker with extension id "${extId}"` };
}

/* ---------------------------- open allowlist ------------------------------ */

const DISCORD_HOSTS = ["discord.com", "discordapp.com", "discord.gg"];
const DISCORD_MSG =
  "discord.com is never opened by the tool; ask the user to open Discord pages.";

/** A discord host or any subdomain of one. */
function isDiscordHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return DISCORD_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}

/**
 * Every page `open` may target, built at runtime — never hard-coded:
 * the `url` of every CHECK_SOURCES checklist row, plus each adapter's
 * home page (`origins[0]/`).
 * @returns {{url: string, source: string, rowId: string}[]}
 */
export function buildAllowlist(checkSources, adapters) {
  const out = [];
  for (const [source, def] of Object.entries(checkSources || {})) {
    for (const row of (def && def.checklist) || []) {
      if (row && row.id && row.url) {
        out.push({ url: String(row.url), source, rowId: String(row.id) });
      }
    }
  }
  for (const a of adapters || []) {
    const origin = a && a.origins && a.origins[0];
    if (origin) {
      out.push({ url: `${String(origin).replace(/\/+$/, "")}/`, source: a.id, rowId: "home" });
    }
  }
  return out;
}

/** origin + pathname, trailing slashes stripped — query and hash ignored. */
function urlKey(u) {
  const p = u.pathname.replace(/\/+$/, "");
  return `${u.origin}${p || "/"}`;
}

/** The `source:rowId` choices for an error message (discord never listed). */
function allowlistOptions(allowlist, source) {
  const opts = (allowlist || [])
    .filter((e) => e.source !== "discord" && (!source || e.source === source))
    .map((e) => `${e.source}:${e.rowId}`);
  return opts.length ? `\nAllowlisted: ${opts.join(", ")}` : "";
}

/**
 * Resolve an `open` argument to an allowlisted page.
 * `<source>:<rowId>` (or `<source>:home`) looks the row's url up; a raw
 * URL must be https: and its origin+pathname must equal an allowlisted
 * entry — the entry's clean url is what gets opened, so no user-typed
 * query string is ever smuggled in. Anything discord is refused before
 * either lookup.
 * @returns {{ok: true, url: string, source: string, rowId: string} | {ok: false, reason: string}}
 */
export function resolveTarget(arg, allowlist) {
  const input = String(arg || "").trim();
  if (!input) return { ok: false, reason: "usage: open <url|source:rowId>" };

  if (!/^https?:\/\//i.test(input)) {
    const i = input.indexOf(":");
    const source = i >= 0 ? input.slice(0, i) : input;
    const rowId = i >= 0 ? input.slice(i + 1) : "";
    if (source === "discord") return { ok: false, reason: DISCORD_MSG };
    const entry = (allowlist || []).find((e) => e.source === source && e.rowId === rowId);
    if (!entry) {
      return {
        ok: false,
        reason: `no allowlisted page "${source}:${rowId}"` + allowlistOptions(allowlist, source),
      };
    }
    return { ok: true, url: entry.url, source: entry.source, rowId: entry.rowId };
  }

  let u;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, reason: `"${input}" is not a URL.` };
  }
  if (isDiscordHost(u.hostname)) return { ok: false, reason: DISCORD_MSG };
  if (u.protocol !== "https:") {
    return { ok: false, reason: `only https: pages can be opened (got ${u.protocol}//${u.host})` };
  }
  const key = urlKey(u);
  const entry = (allowlist || []).find((e) => {
    try {
      return urlKey(new URL(e.url)) === key;
    } catch {
      return false;
    }
  });
  if (!entry) {
    return {
      ok: false,
      reason:
        `${u.origin}${u.pathname} is not on the open allowlist.` +
        allowlistOptions(allowlist, sourceForUrl(input)),
    };
  }
  return { ok: true, url: entry.url, source: entry.source, rowId: entry.rowId };
}

/** True only when `targetId` is one the tool recorded in .opened.json. */
export function canTouch(targetId, opened) {
  const id = String(targetId || "");
  return (
    !!id && (Array.isArray(opened) ? opened : []).some((e) => e && String(e.targetId) === id)
  );
}

/**
 * checkRuns[source] entry for `runId`, only once it reaches a terminal
 * state — null while the run is still in flight or a different/stale run
 * occupies the slot.
 * @param {any} checkRuns @param {string} source @param {string} runId
 */
export function checkRunDone(checkRuns, source, runId) {
  const r = (checkRuns && checkRuns[source]) || null;
  if (!r || r.runId !== runId || r.status === "running") return null;
  return r;
}

/* ---------------------------- extension pages ---------------------------- */

const EXT_ID_RE = /^[a-p]{32}$/;

/**
 * Build `chrome-extension://<id>/<extPath>` for our own pages only.
 * extPath must be a relative path inside that origin: no absolute or
 * scheme URLs, no backslashes, no `..` segments and no %2e encodings.
 * Returns the absolute URL, or null when anything escapes the origin.
 * @param {string} extId @param {string} extPath
 * @returns {string|null}
 */
export function extPageUrl(extId, extPath) {
  const id = String(extId || "").toLowerCase();
  const raw = String(extPath || "").trim();
  if (raw.startsWith("//")) return null;
  const p = raw.replace(/^\/+/, "");
  if (!EXT_ID_RE.test(id)) return null;
  if (!p || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p)) return null;
  if (p.includes("\\") || /%2e/i.test(p)) return null;
  const bare = p.split(/[?#]/, 1)[0];
  if (!bare || bare.split("/").some((seg) => seg === "..")) return null;
  let u;
  try {
    u = new URL(`chrome-extension://${id}/${p}`);
  } catch {
    return null;
  }
  return u.protocol === "chrome-extension:" && u.host === id ? u.href : null;
}

/* ------------------------------- CDP client ------------------------------ */

async function listTargets() {
  let res;
  try {
    res = await fetch(`${DEBUGGER}/json/list`);
  } catch (e) {
    die(
      `Cannot reach the DevTools endpoint at ${DEBUGGER} (${String(
        (e && e.cause && e.cause.code) || e,
      )}).\n${SETUP_HINT}`,
    );
  }
  if (!res.ok) die(`DevTools endpoint returned HTTP ${res.status}.\n${SETUP_HINT}`);
  return res.json();
}

class Cdp {
  /** @param {string} wsUrl */
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    /** @type {Map<number, {resolve: Function, reject: Function}>} */
    this.pending = new Map();
  }

  async open() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WebSocket connect timeout")), 8000);
      this.ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve();
      });
      this.ws.addEventListener("error", (e) => {
        clearTimeout(t);
        reject(new Error(`WebSocket error: ${/** @type {any} */ (e).message || "failed"}`));
      });
    });
    this.ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const p = msg && this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || "CDP error"));
      else p.resolve(msg.result);
    });
  }

  /** @param {string} method @param {any} [params] */
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Runtime.evaluate — used for document reads, chrome.storage.local.get
   * and (on tool-opened tabs only) window.scrollBy. Tab lifecycle goes
   * through Target.createTarget/Target.closeTarget on the browser
   * websocket.
   * @param {string} expression @param {{awaitPromise?: boolean}} [opts]
   */
  async eval(expression, opts = {}) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: !!opts.awaitPromise,
    });
    if (res && res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(
        (d.exception && (d.exception.description || d.exception.value)) ||
          d.text ||
          "evaluation failed",
      );
    }
    return res && res.result ? res.result.value : undefined;
  }

  close() {
    try {
      this.ws && this.ws.close();
    } catch {
      /* ok */
    }
  }
}

/* --------------------------------- helpers ------------------------------- */

function die(msg, code = 2) {
  console.error(msg);
  process.exit(code);
}

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

function ts() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, 19);
}

async function connectTab(target) {
  return connectTabById(target.id);
}

/** Connect to a target by id, polling /json/list until its ws URL shows. */
async function connectTabById(targetId) {
  for (let i = 0; i < 40; i++) {
    const full = (await listTargets()).find((t) => String(t.id) === String(targetId));
    if (full && full.webSocketDebuggerUrl) {
      const cdp = new Cdp(full.webSocketDebuggerUrl);
      await cdp.open();
      return cdp;
    }
    await sleep(250);
  }
  die(`Target ${targetId} never appeared in /json/list.`);
}

/** The browser-level websocket — Target.* calls live there, not on a page. */
async function browserCdp() {
  let ver;
  try {
    const res = await fetch(`${DEBUGGER}/json/version`);
    if (!res.ok) die(`DevTools endpoint returned HTTP ${res.status}.\n${SETUP_HINT}`);
    ver = await res.json();
  } catch (e) {
    die(
      `Cannot reach the DevTools endpoint at ${DEBUGGER} (${String(
        (e && e.cause && e.cause.code) || e,
      )}).\n${SETUP_HINT}`,
    );
  }
  if (!ver || !ver.webSocketDebuggerUrl) die("The endpoint has no browser websocket URL.");
  const cdp = new Cdp(ver.webSocketDebuggerUrl);
  await cdp.open();
  return cdp;
}

/* ------------------------------ opened tabs ------------------------------- */

const OPENED_FILE = path.join(LIVE_DIR, ".opened.json");

function readOpened() {
  try {
    const list = JSON.parse(fs.readFileSync(OPENED_FILE, "utf8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeOpened(list) {
  fs.mkdirSync(LIVE_DIR, { recursive: true });
  fs.writeFileSync(OPENED_FILE, JSON.stringify(list, null, 2));
}

/** Drop recorded ids that no longer exist as live targets. */
function pruneOpened(opened, targets) {
  const live = new Set((targets || []).map((t) => String(t.id)));
  return (opened || []).filter((e) => e && e.targetId && live.has(String(e.targetId)));
}

function hostPathOf(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return String(url);
  }
}

/** The live allowlist — imported lazily so `tabs`/`dump` stay cheap. */
async function loadAllowlist() {
  const dir = (...p) => pathToFileURL(path.join(ROOT, "extension", "src", ...p)).href;
  const [{ CHECK_SOURCES }, { ADAPTERS }] = await Promise.all([
    import(dir("sources", "probes.js")),
    import(dir("core", "registry.js")),
  ]);
  return buildAllowlist(CHECK_SOURCES, ADAPTERS);
}

/** Dump the matching tab's HTML; returns {path, html, target}. */
async function dumpTab(sub, name) {
  const targets = await listTargets();
  const target = pickPage(targets, sub);
  if (!target) {
    const pages = pageTargets(targets);
    die(
      `No open tab matches "${sub}".\nOpen tabs:\n` +
        (pages.map((t) => `  ${t.id}  ${t.host}${t.path}`).join("\n") || "  (none)"),
    );
  }
  const cdp = await connectTab(target);
  try {
    const html = await cdp.eval("document.documentElement.outerHTML");
    if (typeof html !== "string" || !html.length) die("Read an empty document.");
    fs.mkdirSync(LIVE_DIR, { recursive: true });
    const safe = (name || target.host || "page").replace(/[^a-z0-9._-]+/gi, "-");
    const out = path.join(LIVE_DIR, `${safe}-${ts()}.html`);
    fs.writeFileSync(out, html, "utf8");
    return { path: out, html, target };
  } finally {
    cdp.close();
  }
}

/**
 * Locate the extension's service worker and eval a storage.get(key).
 * The worker is identified by asking it — Node can't fetch
 * chrome-extension:// URLs, so manifest.json can't be fetched. Two unpacked
 * copies may be loaded (main + W2's); --ext/WA1_EXT_ID picks one.
 * @param {string|null} key @param {string|null} [extId]
 */
async function storageGet(key, extId) {
  const targets = await listTargets();
  const wanted = extId || process.env.WA1_EXT_ID || null;
  const pick = pickServiceWorker(serviceWorkerTargets(targets), wanted);
  if ("error" in pick) die(`${pick.error} (from --ext/WA1_EXT_ID).`);

  /** @type {{sw: any, cdp: Cdp}[]} */
  const matches = [];
  for (const sw of pick.candidates) {
    const cdp = new Cdp(sw.webSocketDebuggerUrl);
    try {
      await cdp.open();
      const name = await cdp.eval("chrome.runtime.getManifest().name");
      if (name === EXT_NAME) matches.push({ sw, cdp });
      else cdp.close();
    } catch {
      cdp.close();
    }
  }
  if (!matches.length) {
    die(`No "${EXT_NAME}" service worker found — is the extension loaded in that Edge?`);
  }
  if (matches.length > 1) {
    const list = matches.map((m) => `  ${swExtId(m.sw)}\t${m.sw.url}`).join("\n");
    for (const m of matches) m.cdp.close();
    die(
      `More than one "${EXT_NAME}" copy is loaded. Pick one with --ext <id> or WA1_EXT_ID:\n${list}`,
      3,
    );
  }
  const cdp = matches[0].cdp;
  try {
    const expr = key
      ? `chrome.storage.local.get(${JSON.stringify(String(key))})`
      : "chrome.storage.local.get(null)";
    return await cdp.eval(expr, { awaitPromise: true });
  } finally {
    cdp.close();
  }
}

/* ------------------------------ probe recipes ---------------------------- */

/** Sources whose probe.js exists (email's serves both providers). */
const PROBE_MOD = {
  waterlooworks: "waterlooworks/probe.js",
  discord: "discord/probe.js",
  outline: "outline/probe.js",
  gcal: "gcal/probe.js",
  gmail: "email/probe.js",
  outlook: "email/probe.js",
};

/**
 * DOM extracts -> observe.parse payloads, same recipes the verify drivers
 * use. learn/portal observe API traffic only — no DOM path.
 * @returns {Promise<any[]>}
 */
async function extractsFor(source, doc, href, html, ctxNow) {
  const dir = (...p) => pathToFileURL(path.join(ROOT, "extension", "src", ...p)).href;
  switch (source) {
    case "gcal": {
      const { gcalExtract } = await import(dir("sources", "gcal", "dom.js"));
      return [
        {
          source: "gcal",
          kind: "dom",
          url: href,
          body: JSON.stringify(gcalExtract(doc, href, { now: ctxNow })),
        },
      ];
    }
    case "gmail":
    case "outlook": {
      const { extractFor } = await import(dir("sources", "email", "dom.js"));
      const ex = extractFor(doc, href);
      if (!ex) return [];
      return [{ source: ex.provider || source, kind: "dom", url: href, body: JSON.stringify(ex) }];
    }
    case "discord": {
      const { inventoryExtract, messagesExtract, eventsModalExtract } = await import(
        dir("sources", "discord", "dom.js")
      );
      const out = [];
      const push = (ex) =>
        ex && out.push({ source: "discord", kind: "dom", url: href, body: JSON.stringify(ex) });
      push(inventoryExtract(doc, href));
      const msgs = messagesExtract(doc, href);
      if (msgs && Array.isArray(msgs.messages) && msgs.messages.length) push(msgs);
      push(eventsModalExtract(doc, href));
      return out;
    }
    case "waterlooworks":
      // WW observe.parse consumes the page body as a "net" capture.
      return [{ source: "waterlooworks", kind: "net", url: href, body: html }];
    case "outline":
      return [{ source: "outline", kind: "dom", url: href, body: html }];
    default:
      return [];
  }
}

const ADAPTER_MOD = {
  gmail: "email",
  outlook: "email",
};

async function runSource(source, doc, href, html, now) {
  const dir = (...p) => pathToFileURL(path.join(ROOT, "extension", "src", ...p)).href;
  const adapterId = ADAPTER_MOD[source] || source;
  const adapter = (await import(dir("sources", adapterId, "index.js"))).default;
  const { extractDates } = await import(dir("lib", "textdates", "index.js"));
  const { parseOutline } = await import(dir("sources", "outline", "parsers.js"));
  const wwParsers = await import(dir("sources", "waterlooworks", "parsers.js"));

  const ctx = {
    now,
    settings: {},
    state: {},
    courses: [],
    terms: [],
    log() {},
    textDates: extractDates,
    fetch: async () => ({ status: 0 }),
    relay: async () => ({ status: 0 }),
    /** @param {string} docHtml @param {string} name @param {any} [opts] */
    parseHtml: async (docHtml, name, opts) => {
      const fn = String(name).split("/")[1];
      if (fn === "parseOutline") return parseOutline(parseHTML(String(docHtml)).document);
      const p = /** @type {any} */ (wwParsers)[fn];
      return typeof p === "function"
        ? p(parseHTML(String(docHtml)).document, opts)
        : null;
    },
  };

  const at = new Date().toISOString();
  /** @type {Map<string, any>} */
  const items = new Map();
  const payloads = await extractsFor(source, doc, href, html, now);
  for (const p of payloads) {
    const res = await adapter.observe.parse({ ...p, at }, ctx).catch((e) => ({
      items: [],
      error: String((e && e.message) || e),
    }));
    if (res && res.state) ctx.state = res.state;
    for (const it of (res && res.items) || []) items.set(it.id || JSON.stringify(it), it);
  }
  return { items: [...items.values()], parsed: payloads.length };
}

/* -------------------------------- commands ------------------------------- */

async function cmdTabs() {
  const pages = pageTargets(await listTargets());
  if (!pages.length) return void console.log("No page targets.");
  for (const t of pages) console.log(`${t.id}\t${t.host}${t.path}`);
}

/**
 * Open an allowlisted page in a NEW tab (Target.createTarget on the
 * browser websocket — it never reuses or navigates an existing tab),
 * record it in captures/live/.opened.json, then wait for load.
 */
async function cmdOpen(arg) {
  const res = resolveTarget(arg, await loadAllowlist());
  if (!res.ok) die(res.reason);
  const browser = await browserCdp();
  let targetId;
  try {
    const created = await browser.send("Target.createTarget", { url: res.url });
    targetId = created && created.targetId;
  } finally {
    browser.close();
  }
  if (!targetId) die("Target.createTarget returned no tab id.");
  writeOpened([
    ...readOpened(),
    {
      targetId: String(targetId),
      url: res.url,
      source: res.source,
      rowId: res.rowId,
      openedAt: new Date().toISOString(),
    },
  ]);

  const cdp = await connectTabById(targetId);
  let state = "timeout";
  try {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const rs = await cdp.eval("document.readyState").catch(() => "");
      if (rs === "complete") {
        state = "complete";
        break;
      }
      if (rs) state = rs;
      await sleep(500);
    }
  } finally {
    cdp.close();
  }
  console.log(`${targetId}\t${hostPathOf(res.url)}\t${state}`);
}

/** Close tabs — only ids this tool recorded; "all-mine" closes them all. */
async function cmdClose(arg) {
  if (!arg) die("usage: close <targetId|all-mine>");
  const targets = await listTargets();
  const before = readOpened();
  const opened = pruneOpened(before, targets);
  const dropped = before.length - opened.length;
  writeOpened(opened);

  if (arg === "all-mine") {
    if (!opened.length) {
      console.log(
        `No tool-opened tabs${dropped ? ` (${dropped} stale record${dropped === 1 ? "" : "s"} pruned)` : ""}.`,
      );
      return;
    }
    const browser = await browserCdp();
    const left = [];
    try {
      for (const e of opened) {
        try {
          await browser.send("Target.closeTarget", { targetId: e.targetId });
          console.log(`closed ${e.targetId}\t${hostPathOf(e.url)}`);
        } catch (err) {
          left.push(e);
          console.log(`could not close ${e.targetId}: ${String((err && err.message) || err)}`);
        }
      }
    } finally {
      browser.close();
    }
    writeOpened(left);
    return;
  }

  if (!canTouch(arg, opened)) {
    die(
      `"${arg}" is not a tab this tool opened. Tool-opened ids: ` +
        (opened.map((e) => e.targetId).join(", ") || "(none)") +
        ' — "close all-mine" clears them all.',
    );
  }
  const entry = opened.find((e) => String(e.targetId) === String(arg));
  const browser = await browserCdp();
  try {
    await browser.send("Target.closeTarget", { targetId: entry.targetId });
  } finally {
    browser.close();
  }
  writeOpened(opened.filter((e) => String(e.targetId) !== String(arg)));
  console.log(`closed ${arg}\t${hostPathOf(entry.url)}`);
}

/** window.scrollBy on a tool-opened tab only — N clamped to 1..20000. */
async function cmdScroll(targetId, px) {
  let n = Math.round(Number(px));
  if (!Number.isFinite(n)) n = 1200;
  n = Math.min(20000, Math.max(1, n));
  const opened = pruneOpened(readOpened(), await listTargets());
  writeOpened(opened);
  if (!canTouch(targetId, opened)) {
    die(
      `"${targetId}" is not a tab this tool opened` +
        (opened.length ? ` (ids: ${opened.map((e) => e.targetId).join(", ")})` : " — none recorded") +
        "; scroll only reaches tabs from `open`.",
    );
  }
  const cdp = await connectTabById(targetId);
  try {
    const pos = await cdp.eval(
      `(window.scrollBy(0, ${n}), ({scrollY: window.scrollY, scrollHeight: document.documentElement.scrollHeight}))`,
    );
    console.log(
      `${targetId}\tscrollY=${pos ? pos.scrollY : "?"}\tscrollHeight=${pos ? pos.scrollHeight : "?"}`,
    );
  } finally {
    cdp.close();
  }
}

async function cmdDump(sub, name) {
  const { path: out, html, target } = await dumpTab(sub, name);
  console.log(`${target.id}  ${target.host}${target.path}`);
  console.log(`${out}  (${fs.statSync(out).size} bytes)`);
}

async function cmdProbe(sub) {
  const { path: out, html, target } = await dumpTab(sub, `probe-${sub.replace(/[^a-z0-9]+/gi, "-")}`);
  console.log(`dump  ${out} (${fs.statSync(out).size} bytes)`);
  const source = sourceForUrl(target.url);
  if (!source) {
    return void console.log(`No source mapped for host ${target.host} (SITE_BY_HOST).`);
  }
  const doc = parseHTML(html).document;
  const now = new Date();

  // 1. probe.js counts (where the source has one).
  const mod = PROBE_MOD[source];
  if (mod) {
    const { probe } = await import(
      pathToFileURL(path.join(ROOT, "extension", "src", "sources", ...mod.split("/"))).href
    );
    const p = probe(doc, target.url);
    console.log(`probe ${source}.${p.page}: ok=${p.ok} counts=${JSON.stringify(p.counts)}`);
    for (const h of p.hints || []) console.log(`  hint: ${h}`);
  } else {
    console.log(`probe: ${source} has no probe.js (passive API source)`);
  }

  // 2. DOM extract -> observe.parse.
  const { items, parsed } = await runSource(source, doc, target.url, html, now);
  if (!parsed) console.log("No DOM extraction for this page.");
  const counts = countByType(items);
  console.log(`items: ${items.length} ${JSON.stringify(counts)}`);
  for (const it of items.slice(0, 5)) console.log(`  ${fmtRow(it)}`);
}

async function cmdStorage(key, sourceId, extId) {
  const all = await storageGet(key || null, extId);
  const snap = key ? { [key]: all && all[key] } : all || {};
  if (key && snap[key] === undefined) {
    console.log(`storage key "${key}" is not set.`);
    return;
  }

  if (!key) {
    const items = snap.items || {};
    console.log(`keys: ${Object.keys(snap).length}  items: ${Object.keys(items).length}`);
    for (const k of Object.keys(snap)) {
      const v = snap[k];
      const size = JSON.stringify(v ?? null).length;
      console.log(`  ${k}  ${size} bytes`);
    }
  }
  if (snap.sourceState) {
    console.log("sourceState:");
    for (const [id, st] of Object.entries(snap.sourceState)) {
      const s = /** @type {any} */ (st) || {};
      console.log(
        `  ${id.padEnd(14)} ${String(s.status || "-").padEnd(8)} lastOk=${s.lastOkAt || "-"} lastRun=${s.lastRunAt || "-"} items=${s.itemCount ?? "-"} ${s.error ? "err=" + s.error : ""}`,
      );
    }
  }
  if (snap.items || (key === "items" && snap.items)) {
    const items = sourceId ? filterBySource(snap.items, sourceId) : Object.values(snap.items || {});
    const counts = countByType(items);
    console.log(`items${sourceId ? ` [${sourceId}]` : ""}: ${items.length} ${JSON.stringify(counts)}`);
    for (const it of items.slice(0, 5)) console.log(`  ${fmtRow(it)}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Close a tool-owned tab, ignoring failures; drop its .opened.json entry. */
async function closeTargetQuiet(targetId) {
  try {
    const browser = await browserCdp();
    try {
      await browser.send("Target.closeTarget", { targetId });
    } finally {
      browser.close();
    }
  } catch {
    /* already gone */
  }
  writeOpened(readOpened().filter((e) => String(e.targetId) !== String(targetId)));
}

/** Poll /json/list until a service worker for `id` appears (10 s). */
async function waitForServiceWorker(id) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const sw = serviceWorkerTargets(await listTargets()).find((t) => swExtId(t) === id);
    if (sw) return sw;
    await sleep(250);
  }
  return null;
}

/**
 * Reload our own extension: chrome.runtime.reload() evaluated inside its
 * service worker (the socket drops — that is success), then poll for the
 * new worker. A sleeping worker is woken first — via a runtime message in
 * any live extension page, else by loading the panel in a tool-owned tab
 * that is closed once the worker answers. Only that one extension id's
 * targets are touched.
 * @param {string|null} extId
 */
async function cmdReloadExt(extId) {
  const id = String(extId || process.env.WA1_EXT_ID || "");
  if (!id) die("usage: reload-ext [--ext <id>] — or set WA1_EXT_ID.");
  let sw = serviceWorkerTargets(await listTargets()).find((t) => swExtId(t) === id);
  let wakeTabId = null;
  if (!sw) {
    const page = extPageTargets(await listTargets(), id)[0];
    if (page && page.webSocketDebuggerUrl) {
      const w = new Cdp(page.webSocketDebuggerUrl);
      try {
        await w.open();
        await w.eval('chrome.runtime.sendMessage({type:"wa1:ping"}).catch(()=>{})').catch(() => {});
      } finally {
        w.close();
      }
    } else {
      const url = extPageUrl(id, "src/panel/panel.html");
      if (!url) die(`cannot build a wake page for extension "${id}".`);
      const browser = await browserCdp();
      try {
        const created = await browser.send("Target.createTarget", { url });
        wakeTabId = created && created.targetId;
      } finally {
        browser.close();
      }
      if (wakeTabId) {
        writeOpened([
          ...readOpened(),
          {
            targetId: String(wakeTabId),
            url,
            source: "extension",
            rowId: "page",
            openedAt: new Date().toISOString(),
          },
        ]);
      }
    }
    sw = await waitForServiceWorker(id);
    if (!sw) {
      if (wakeTabId) await closeTargetQuiet(wakeTabId);
      die(`extension "${id}" never spawned a service worker — is it loaded in that Edge?`);
    }
  }
  let err = null;
  try {
    // Connect + verify the manifest name. An eval failure means the worker
    // is mid-restart — wait 1 s, re-list targets and retry once on whatever
    // worker target exists then. A *wrong* name dies immediately.
    let cdp = null;
    let name = null;
    for (let attempt = 0; attempt < 2 && !cdp; attempt++) {
      if (attempt) {
        await sleep(1000);
        sw = (await waitForServiceWorker(id)) || sw;
      }
      const cand = new Cdp(sw.webSocketDebuggerUrl);
      try {
        await cand.open();
        name = await cand.eval("chrome.runtime.getManifest().name");
        cdp = cand;
      } catch {
        cand.close();
      }
    }
    if (!cdp) throw new Error(`service worker for "${id}" did not answer the manifest check.`);
    try {
      if (name !== EXT_NAME) throw new Error(`extension "${id}" is not "${EXT_NAME}".`);
      await cdp.eval("chrome.runtime.reload()").catch(() => {});
    } finally {
      cdp.close();
    }
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await sleep(250);
      const again = (await listTargets()).find(
        (t) =>
          t.type === "service_worker" && swExtId(t) === id && String(t.id) !== String(sw.id),
      );
      if (again) {
        console.log(`reloaded ${id}\t${again.id}\t${again.url}`);
        return;
      }
    }
    throw new Error(`service worker for "${id}" did not reappear within 10s.`);
  } catch (e) {
    err = e;
  } finally {
    if (wakeTabId) await closeTargetQuiet(wakeTabId);
  }
  die(String((err && err.message) || err));
}

/**
 * Screenshot one of the extension's own pages in a NEW tab: open, wait for
 * load + 1.5 s, resize the viewport, capture a PNG into captures/live/,
 * then close the tab it opened.
 * @param {string} extPath @param {{ext?: string|null, width: number, height: number, name?: string|null}} opts
 */
async function cmdScreenshot(extPath, opts = {}) {
  const id = String(opts.ext || process.env.WA1_EXT_ID || "");
  if (!id) die("usage: screenshot <extPath> [--ext <id>] — or set WA1_EXT_ID.");
  const url = extPageUrl(id, extPath);
  if (!url) {
    die(`"${extPath}" is not a path inside chrome-extension://${id}/ (rel path only, no ..)`);
  }
  const browser = await browserCdp();
  let targetId;
  try {
    const created = await browser.send("Target.createTarget", { url });
    targetId = created && created.targetId;
  } finally {
    browser.close();
  }
  if (!targetId) die("Target.createTarget returned no tab id.");
  writeOpened([
    ...readOpened(),
    {
      targetId: String(targetId),
      url,
      source: "extension",
      rowId: "page",
      openedAt: new Date().toISOString(),
    },
  ]);

  const cdp = await connectTabById(targetId);
  try {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const rs = await cdp.eval("document.readyState").catch(() => "");
      if (rs === "complete") break;
      await sleep(500);
    }
    await sleep(1500);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: opts.width,
      height: opts.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(300);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    if (!shot || !shot.data) die("Page.captureScreenshot returned no data.");
    fs.mkdirSync(LIVE_DIR, { recursive: true });
    const safe = (opts.name || `shot-${ts()}`).replace(/[^a-z0-9._-]+/gi, "-");
    const out = path.join(LIVE_DIR, `${safe}.png`);
    fs.writeFileSync(out, Buffer.from(String(shot.data), "base64"));
    console.log(`${out}\t${opts.width}x${opts.height}\t${url}`);
  } finally {
    cdp.close();
    const browser2 = await browserCdp();
    try {
      await browser2.send("Target.closeTarget", { targetId });
    } catch {
      /* closing the tab we opened is best-effort */
    } finally {
      browser2.close();
    }
    writeOpened(readOpened().filter((e) => String(e.targetId) !== String(targetId)));
  }
}

/**
 * check-now: fire UI.CHECK_NOW through runtime.sendMessage from one of our
 * OWN extension pages (a page wakes the MV3 worker; sendMessage from the
 * service worker itself never loops back to it). If no extension page is
 * live, the panel is opened in a tool-owned tab and closed afterwards.
 * Then polls checkRuns[source] until the run terminates or 100 s pass.
 * @param {string} source @param {string|null} extId
 */
async function cmdCheckNow(source, extId) {
  const id = String(extId || process.env.WA1_EXT_ID || "");
  if (!id) die("usage: check-now <source> [--ext <id>] — or set WA1_EXT_ID.");
  const src = String(source || "");

  const targets = await listTargets();
  let page = extPageTargets(targets, id).find((t) => t.webSocketDebuggerUrl);
  let wakeTabId = null;
  if (!page) {
    const url = extPageUrl(id, "src/panel/panel.html");
    if (!url) die(`cannot build a wake page for extension "${id}".`);
    const browser = await browserCdp();
    try {
      const created = await browser.send("Target.createTarget", { url });
      wakeTabId = created && created.targetId;
    } finally {
      browser.close();
    }
    if (!wakeTabId) die("Target.createTarget returned no tab id.");
    writeOpened([
      ...readOpened(),
      {
        targetId: String(wakeTabId),
        url,
        source: "extension",
        rowId: "page",
        openedAt: new Date().toISOString(),
      },
    ]);
    console.log(`wake tab ${wakeTabId}\t${hostPathOf(url)} (closing after)`);
  }

  const cdp = await connectTabById(page ? page.id : wakeTabId);
  const started = Date.now();
  try {
    // A freshly created tab lists as a target before the page has loaded
    // chrome.* — wait for the API before messaging.
    for (let i = 0; i < 30; i++) {
      const ready = await cdp
        .eval('typeof chrome !== "undefined" && !!(chrome.runtime && chrome.runtime.id)')
        .catch(() => false);
      if (ready === true) break;
      if (i === 29) die("wake page never exposed chrome.runtime.");
      await sleep(300);
    }
    const res = await cdp.eval(
      `chrome.runtime.sendMessage({ type: "wa1:check-now-request", source: ${JSON.stringify(src)} })`,
      { awaitPromise: true },
    );
    if (!res || res.accepted !== true) {
      console.log(
        `${src}\trejected\t${JSON.stringify(res && res.reason ? res.reason : res ?? "no answer")}`,
      );
      return;
    }
    console.log(`${src}\taccepted\trunId=${res.runId}`);
    const deadline = Date.now() + 100000;
    for (;;) {
      const got = await cdp
        .eval('chrome.storage.local.get("checkRuns")', { awaitPromise: true })
        .catch(() => null);
      const done = checkRunDone(got && got.checkRuns, src, res.runId);
      if (done) {
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        console.log(
          `${src}\t${done.status}${done.reason ? `\t${done.reason}` : ""}` +
            `\tchecked=${done.checked ?? "-"}\tnewItems=${done.newItems ?? "-"}\t${secs}s`,
        );
        return;
      }
      if (Date.now() >= deadline) {
        console.log(`${src}\tno result within 100s (checkRuns may still say running)`);
        return;
      }
      await sleep(1000);
    }
  } finally {
    cdp.close();
    if (wakeTabId) await closeTargetQuiet(wakeTabId);
  }
}

async function cmdWatch(sourceId, secs, extId) {
  const until = Date.now() + secs * 1000;
  /** @type {string|null} */
  let lastState = null;
  let lastCount = -1;
  console.log(`watching storage every 2s for ${secs}s${sourceId ? ` (source ${sourceId})` : ""} …`);
  while (Date.now() < until) {
    try {
      const snap = await storageGet(null, extId);
      const states = (snap && snap.sourceState) || {};
      const view = {};
      for (const [id, st] of Object.entries(states)) {
        const s = /** @type {any} */ (st) || {};
        view[id] = {
          status: s.status,
          lastOkAt: s.lastOkAt,
          lastRunAt: s.lastRunAt,
          itemCount: s.itemCount,
          error: s.error,
        };
      }
      const cur = JSON.stringify(sourceId ? { [sourceId]: view[sourceId] } : view);
      if (cur !== lastState) {
        const t = new Date().toLocaleTimeString("en-CA", { timeZone: "America/Toronto" });
        console.log(`${t} sourceState changed:`);
        for (const [id, s] of Object.entries(sourceId ? { [sourceId]: view[sourceId] } : view)) {
          if (s) console.log(`  ${id}: ${JSON.stringify(s)}`);
        }
        lastState = cur;
      }
      const items = sourceId
        ? filterBySource(snap.items, sourceId)
        : Object.values((snap && snap.items) || {});
      if (items.length !== lastCount) {
        const t = new Date().toLocaleTimeString("en-CA", { timeZone: "America/Toronto" });
        console.log(`${t} items${sourceId ? ` [${sourceId}]` : ""}: ${lastCount < 0 ? "" : lastCount + " -> "}${items.length} ${JSON.stringify(countByType(items))}`);
        lastCount = items.length;
      }
    } catch (e) {
      console.log(`poll error: ${String((e && e.message) || e)}`);
    }
    await sleep(2000);
  }
}

/* ---------------------------------- main --------------------------------- */

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(`npm run live -- <cmd>

  tabs                            list page targets (id, host, path)
  open <url|source:rowId>         new tab for an allowlisted page only
  close <targetId|all-mine>       close only tabs this tool opened
  scroll <targetId> [px]          scroll a tool-opened tab (default 1200)
  dump <urlSub> [--name x]        save tab HTML to captures/live/
  probe <urlSub>                  dump + probe.js + DOM extraction counts
  storage [key] [--source id]     read chrome.storage.local (SW target)
  watch [--source id] [--secs n]  poll storage every 2s, print changes
  reload-ext [--ext id]           reload our own extension (its SW only)
  check-now <source> [--ext id]   wa1:check-now-request, then poll checkRuns
  screenshot <extPath> [opts]     PNG of an extension page -> captures/live/
                                  opts: --width 360 --height 900 --name x --ext id

  Both storage commands accept --ext <id> (or the WA1_EXT_ID env var) to pick
  one extension copy when more than one unpacked dist/ is loaded.

No actions: no input events, clicks, forms; open only creates NEW tabs;
close/scroll only reach tool-opened tabs; discord.com is always refused.`);
    return;
  }
  const rest = args.slice(1);
  switch (cmd) {
    case "tabs":
      return cmdTabs();
    case "open":
      if (!rest[0]) die("usage: open <url|source:rowId>");
      return cmdOpen(rest[0]);
    case "close":
      return cmdClose(rest[0]);
    case "scroll":
      if (!rest[0]) die("usage: scroll <targetId> [px]");
      return cmdScroll(rest[0], rest[1]);
    case "dump":
      if (!rest[0]) die("usage: dump <urlSubstring> [--name x]");
      return cmdDump(rest[0], argValue(rest, "--name"));
    case "probe":
      if (!rest[0]) die("usage: probe <urlSubstring>");
      return cmdProbe(rest[0]);
    case "storage":
      return cmdStorage(
        rest[0] && !rest[0].startsWith("--") ? rest[0] : null,
        argValue(rest, "--source"),
        argValue(rest, "--ext"),
      );
    case "watch":
      return cmdWatch(
        argValue(rest, "--source"),
        Number(argValue(rest, "--secs")) || 120,
        argValue(rest, "--ext"),
      );
    case "reload-ext":
      return cmdReloadExt(argValue(rest, "--ext"));
    case "check-now":
      if (!rest[0] || rest[0].startsWith("--")) die("usage: check-now <source> [--ext id]");
      return cmdCheckNow(rest[0], argValue(rest, "--ext"));
    case "screenshot":
      if (!rest[0] || rest[0].startsWith("--")) {
        die("usage: screenshot <extPath> [--width n] [--height n] [--name x] [--ext id]");
      }
      return cmdScreenshot(rest[0], {
        ext: argValue(rest, "--ext"),
        width: Number(argValue(rest, "--width")) || 360,
        height: Number(argValue(rest, "--height")) || 900,
        name: argValue(rest, "--name"),
      });
    default:
      die(`unknown command "${cmd}" — try: tabs, open, close, scroll, dump, probe, storage, watch, reload-ext, check-now, screenshot`);
  }
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((e) => die(String((e && e.stack) || e), 1));
}
