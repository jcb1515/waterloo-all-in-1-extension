// @ts-check
// Live DevTools console — READ-ONLY.
//
// Talks to the user's Edge over the DevTools protocol at 127.0.0.1:9222.
// Hard rules (see README):
//   * never Input.*, Page.navigate, clicks, scroll, or tab closing;
//   * only side-effect-free Runtime.evaluate + DOM reads;
//   * never automate Discord; one tab at a time; raw captures go to
//     captures/live/ (gitignored) and must stay outside git.
//
// Usage: npm run live -- <cmd>
//   tabs                          list page targets (id, host, path)
//   dump <urlSub> [--name x]      save document HTML to captures/live/
//   probe <urlSub>                dump + run the source's probe/parser
//   storage [key] [--source id] [--ext id]  read chrome.storage.local (SW)
//   watch [--source id] [--secs] [--ext id] poll storage, print changes
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
   * Runtime.evaluate — the ONLY protocol call this tool makes. Side-effect
   * free expressions only: document reads and chrome.storage.local.get.
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
  const full = (await listTargets()).find((t) => String(t.id) === target.id);
  if (!full || !full.webSocketDebuggerUrl) die(`Target ${target.id} has no websocket URL.`);
  const cdp = new Cdp(full.webSocketDebuggerUrl);
  await cdp.open();
  return cdp;
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
  dump <urlSub> [--name x]        save tab HTML to captures/live/
  probe <urlSub>                  dump + probe.js + DOM extraction counts
  storage [key] [--source id]     read chrome.storage.local (SW target)
  watch [--source id] [--secs n]  poll storage every 2s, print changes

  Both storage commands accept --ext <id> (or the WA1_EXT_ID env var) to pick
  one extension copy when more than one unpacked dist/ is loaded.

READ-ONLY: no Input.*, no navigate, no clicks, no closing tabs.`);
    return;
  }
  const rest = args.slice(1);
  switch (cmd) {
    case "tabs":
      return cmdTabs();
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
    default:
      die(`unknown command "${cmd}" — try: tabs, dump, probe, storage, watch`);
  }
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((e) => die(String((e && e.stack) || e), 1));
}
