// @ts-check
// Offline verification harness ("audit support"): run every adapter over
// every redacted fixture in test/fixtures/**, fold the results through the
// real core — applyResult -> recompute -> linkEmailItems -> deriveTodos
// (optional) -> buildFeedPayload — and write captures/verify-report.md.
//
//   node tools/verify.mjs          # full run, writes the report
//   node tools/verify.mjs --check  # no report; prints a one-line JSON summary
//
// Exit code 1 when the report counts any suspected duplicates, invalid
// dates, or adapter throws.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  applyResult,
  mergeApplications,
  linkEmailItems,
  recompute,
  titleSimilarity,
} from "../extension/src/core/merge.js";
import { normCourseCode } from "../extension/src/core/contract.js";
import { buildFeedPayload } from "../extension/src/calendar/payload.js";

import learnDriver from "./verify/drivers/learn.mjs";
import outlineDriver from "./verify/drivers/outline.mjs";
import portalDriver from "./verify/drivers/portal.mjs";
import emailDriver from "./verify/drivers/email.mjs";
import waterlooworksDriver from "./verify/drivers/waterlooworks.mjs";
import discordDriver from "./verify/drivers/discord.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_DIR = path.join(ROOT, "test", "fixtures");
const REPORT_PATH = path.join(ROOT, "..", "captures", "verify-report.md");

export const DEFAULT_NOW = new Date("2026-09-27T16:00:00.000Z");
export const DRIVERS = [
  learnDriver,
  outlineDriver,
  portalDriver,
  emailDriver,
  waterlooworksDriver,
  discordDriver,
];

const DAY_MS = 24 * 60 * 60 * 1000;
const DUP_WINDOW_MS = 5 * 60 * 1000;
const DUP_TITLE_SIM = 0.5;
const COURSE_CODE_RE = /^[A-Z]{2,8} \d{3}[A-Z]{0,2}$/;

/** @param {string} dir @returns {string[]} */
function listFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listFiles(p));
    else if (ent.isFile()) out.push(p);
  }
  return out;
}

/**
 * Duplicate-pair org rule (the equivalent of merge.js's org compatibility):
 * equal after normCourseCode, either empty, compact containment >= 3 chars,
 * or org similarity >= 0.5. Two *different* course codes are never
 * duplicates — same-hour lectures of two courses are a clash, not a dupe.
 * @param {unknown} orgA @param {unknown} orgB
 */
export function orgsCompatible(orgA, orgB) {
  const a = String(orgA || "").trim();
  const b = String(orgB || "").trim();
  if (!a || !b) return true;
  const ca = normCourseCode(a);
  const cb = normCourseCode(b);
  const aCode = COURSE_CODE_RE.test(ca);
  const bCode = COURSE_CODE_RE.test(cb);
  if (aCode && bCode) return ca === cb;
  if (ca === cb) return true;
  const ka = ca.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const kb = cb.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (ka.length >= 3 && kb.includes(ka)) return true;
  if (kb.length >= 3 && ka.includes(kb)) return true;
  return titleSimilarity(a, undefined, b, undefined) >= 0.5;
}

/**
 * Suspected duplicates among feed events: starts within ±5 minutes,
 * titleSimilarity >= 0.5, and compatible orgs.
 * @param {any[]} events
 * @returns {{a: any, b: any}[]}
 */
export function findSuspectedDuplicates(events) {
  /** @type {{ev: any, start: number}[]} */
  const evs = [];
  for (const ev of events || []) {
    if (!ev || typeof ev !== "object") continue;
    const start = Date.parse(ev.startAt || ev.dueAt || "");
    if (Number.isFinite(start)) evs.push({ ev, start });
  }
  /** @type {{a: any, b: any}[]} */
  const pairs = [];
  for (let i = 0; i < evs.length; i++) {
    for (let j = i + 1; j < evs.length; j++) {
      const a = evs[i];
      const b = evs[j];
      if (Math.abs(a.start - b.start) > DUP_WINDOW_MS) continue;
      if (
        titleSimilarity(a.ev.title, a.ev.org, b.ev.title, b.ev.org) <
        DUP_TITLE_SIM
      )
        continue;
      if (!orgsCompatible(a.ev.org, b.ev.org)) continue;
      pairs.push({
        a: {
          id: a.ev.id,
          title: a.ev.title,
          org: a.ev.org ?? null,
          start: a.ev.startAt || a.ev.dueAt,
        },
        b: {
          id: b.ev.id,
          title: b.ev.title,
          org: b.ev.org ?? null,
          start: b.ev.startAt || b.ev.dueAt,
        },
      });
    }
  }
  return pairs;
}

/**
 * Invalid dates on canonical items: unparseable dueAt/startAt/endAt,
 * endAt < startAt, or any date more than 365 days after `now`.
 * @param {Record<string, any>} items @param {Date|string} now
 */
export function findInvalidDates(items, now) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  /** @type {{id: string, field: string, value: string, reason: string}[]} */
  const bad = [];
  for (const it of Object.values(items || {})) {
    if (!it || !it.id) continue;
    for (const f of ["dueAt", "startAt", "endAt"]) {
      const v = it[f];
      if (v == null || v === "") continue;
      const ms = Date.parse(v);
      if (!Number.isFinite(ms)) {
        bad.push({ id: it.id, field: f, value: String(v), reason: "unparseable" });
      } else if (ms > nowMs + 365 * DAY_MS) {
        bad.push({ id: it.id, field: f, value: String(v), reason: ">365 days after NOW" });
      }
    }
    const s = Date.parse(it.startAt);
    const e = Date.parse(it.endAt);
    if (Number.isFinite(s) && Number.isFinite(e) && e < s) {
      bad.push({ id: it.id, field: "endAt", value: String(it.endAt), reason: "endAt < startAt" });
    }
  }
  return bad;
}

const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0);

/** @param {any} entry per-source fold entry */
function sourceStats(entry) {
  const items = (entry.raw && entry.raw.items) || [];
  /** @type {Record<string, number>} */
  const byType = {};
  let dates = 0;
  let locations = 0;
  let facts = 0;
  let urls = 0;
  let pending = 0;
  let auto = 0;
  for (const it of items) {
    if (!it) continue;
    const t = String(it.type || "?");
    byType[t] = (byType[t] || 0) + 1;
    if (it.dueAt || it.startAt || it.endAt) dates++;
    if (it.location) locations++;
    if (it.meta && Array.isArray(it.meta.facts) && it.meta.facts.length) facts++;
    if (it.url) urls++;
    if (it.review === "pending") pending++;
    else if (it.review === "auto") auto++;
  }
  return { items, byType, dates, locations, facts, urls, pending, auto };
}

/**
 * @param {{check?: boolean, now?: Date|string, drivers?: any[],
 *   fixturesRoot?: string}} [opts]
 * @returns {Promise<{report: string, summary: any, failures: any}>}
 */
export async function runVerify(opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now || DEFAULT_NOW);
  const drivers = Array.isArray(opts.drivers) ? opts.drivers : DRIVERS;
  const fixturesRoot = opts.fixturesRoot || FIXTURES_DIR;
  const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

  /** @type {Map<any, any>} */
  const byDriver = new Map();
  /** @type {string[]} */
  const unmapped = [];
  let matchedFiles = 0;

  for (const file of listFiles(fixturesRoot).sort()) {
    const drv = drivers.find((d) => {
      try {
        return !!(d && typeof d.match === "function" && d.match(file));
      } catch {
        return false;
      }
    });
    if (!drv) {
      unmapped.push(rel(file));
      continue;
    }
    matchedFiles++;
    const source = String(drv.source || "?");
    let e = byDriver.get(drv);
    if (!e) {
      const dNow = drv.now instanceof Date ? drv.now : now;
      e = {
        source,
        now: dNow,
        env: { now: dNow, at: dNow.toISOString(), state: {} },
        fixtures: [],
        raw: null,
        throws: [],
      };
      byDriver.set(drv, e);
    }
    e.fixtures.push(rel(file));
    try {
      const res = await drv.run(file, e.env);
      if (res && typeof res === "object") {
        const scope = res.scope;
        e.raw = applyResult(e.raw, res, {
          mode: scope ? "scope" : "sync",
          scope,
        });
      }
    } catch (err) {
      e.throws.push({
        fixture: rel(file),
        message: String((err && err.message) || err),
      });
    }
  }

  // -- Core pipeline ------------------------------------------------------
  /** @type {Record<string, any>} */
  const raws = {};
  for (const e of byDriver.values()) if (e.raw) raws[e.source] = e.raw;
  const applications = mergeApplications(raws);
  const rec = recompute({
    raws,
    prevItems: {},
    links: {},
    uidMap: {},
    userState: {},
    applications,
    now,
  });
  const linked = linkEmailItems(rec.items || {}, applications);
  const items = linked.items;
  const itemList = Object.values(items).filter((i) => i && i.id);

  // deriveTodos lives in W1's line of work — optional on this branch.
  /** @type {{status: string, count?: number, byAuto?: Record<string, number>}} */
  let todos = { status: "deriveTodos: not on this branch — skipped" };
  try {
    const mod = await import(
      pathToFileURL(path.join(ROOT, "extension", "src", "core", "todos.js")).href
    ).catch(() => null);
    const fn = mod && typeof mod === "object" && /** @type {any} */ (mod).deriveTodos;
    if (typeof fn === "function") {
      const out = fn({ items, now, applications });
      const list = Array.isArray(out)
        ? out
        : Array.isArray(out && out.todos)
          ? out.todos
          : out && typeof out === "object"
            ? Object.values(out)
            : [];
      /** @type {Record<string, number>} */
      const byAuto = {};
      for (const t of list) {
        const k = String((t && t.meta && t.meta.auto) ?? "unknown");
        byAuto[k] = (byAuto[k] || 0) + 1;
      }
      todos = { status: "ok", count: list.length, byAuto };
    }
  } catch (err) {
    todos = { status: `error: ${String((err && err.message) || err)}` };
  }

  const cal = {
    enabled: true,
    include: { classes: true, tentative: true, completed: true, termDates: true },
    alarms: false,
  };
  const feed = buildFeedPayload(items, {}, cal, now, { acceptPending: false });
  const feedAll = buildFeedPayload(items, {}, cal, now, { acceptPending: true });
  const feedJson = JSON.stringify(feed.payload);
  const feedAllJson = JSON.stringify(feedAll.payload);

  // Duplicates are checked against the pending-inclusive payload: pending
  // items don't publish, but a pending/exact pair becomes a duplicate the
  // moment the pending item is accepted.
  const duplicates = findSuspectedDuplicates(feedAll.payload.events || []);
  const invalidDates = findInvalidDates(items, now);
  const throws = [];
  for (const e of byDriver.values()) {
    for (const t of e.throws) throws.push({ source: e.source, ...t });
  }

  // Cross-source merges: canonical items seen in more than one source.
  const merged = [];
  for (const it of itemList) {
    const sources = [
      ...new Set(
        (it.seenIn || []).map((s) => s && s.source).filter(Boolean),
      ),
    ];
    if (sources.length > 1) {
      merged.push({ sources, type: it.type, title: it.title });
    }
  }

  const perSource = {};
  for (const e of byDriver.values()) {
    const s = sourceStats(e);
    perSource[e.source] = {
      fixtures: e.fixtures.length,
      items: s.items.length,
      byType: s.byType,
      dates: pct(s.dates, s.items.length),
      locations: pct(s.locations, s.items.length),
      facts: pct(s.facts, s.items.length),
      urls: pct(s.urls, s.items.length),
    };
  }

  const failures = {
    duplicates: duplicates.length,
    invalidDates: invalidDates.length,
    throws: throws.length,
  };
  const summary = {
    now: now.toISOString(),
    fixtures: matchedFiles,
    unmapped: unmapped.length,
    sources: Object.fromEntries(
      Object.entries(perSource).map(([k, v]) => [
        k,
        { fixtures: v.fixtures, items: v.items },
      ]),
    ),
    items: itemList.length,
    applications: Object.keys(applications).length,
    events: feed.count,
    eventsPendingIncluded: feedAll.count,
    bytes: feedJson.length,
    trimmed: feed.trimmed,
    duplicates: duplicates.length,
    invalidDates: invalidDates.length,
    throws: throws.length,
    todos: todos.status === "ok" ? todos.count : todos.status,
  };

  // -- Report -------------------------------------------------------------
  /** @type {string[]} */
  const md = [];
  md.push("# Offline verification report");
  md.push("");
  md.push(`Generated ${new Date().toISOString()} · NOW = ${now.toISOString()}`);
  md.push("");
  md.push(
    "Duplicate rule: starts within ±5 min AND `titleSimilarity(title, org)` " +
      ">= 0.5 AND orgs compatible (equal after normCourseCode / either empty / " +
      "compact containment ≥ 3 chars / org similarity ≥ 0.5 — two different " +
      "course codes are never duplicates). Checked on the pending-inclusive " +
      "feed payload.",
  );
  md.push("");
  md.push("## Per source");
  for (const e of byDriver.values()) {
    const s = sourceStats(e);
    md.push("");
    md.push(
      `### ${e.source} — ${e.fixtures.length} fixtures, ${s.items.length} items` +
        (e.now.getTime() !== now.getTime()
          ? ` (driver NOW ${e.now.toISOString()})`
          : ""),
    );
    md.push("");
    md.push("- fixtures: " + e.fixtures.map((f) => `\`${f}\``).join(", "));
    const types = Object.entries(s.byType)
      .map(([t, n]) => `${t}: ${n}`)
      .join(", ");
    md.push(`- items by type: ${types || "none"}`);
    md.push(
      `- with dates: ${pct(s.dates, s.items.length)}% · locations: ` +
        `${pct(s.locations, s.items.length)}% · meta.facts: ` +
        `${pct(s.facts, s.items.length)}% · urls: ${pct(s.urls, s.items.length)}%`,
    );
    md.push(
      `- review: pending ${s.pending}, auto ${s.auto}, other ${
        s.items.length - s.pending - s.auto
      }`,
    );
    if (e.throws.length) {
      for (const t of e.throws) {
        md.push(`- THROW on \`${t.fixture}\`: ${t.message}`);
      }
    }
  }

  md.push("");
  md.push("## Cross-source merges");
  if (merged.length) {
    for (const m of merged) {
      md.push(`- ${m.sources.join(" + ")} · ${m.type} · ${m.title}`);
    }
  } else {
    md.push("- none");
  }

  md.push("");
  md.push(`## Suspected duplicates — ${duplicates.length} (must be 0)`);
  for (const d of duplicates) {
    md.push(
      `- ${JSON.stringify(d.a.title)} (${d.a.org || "—"}, ${d.a.start}) ↔ ` +
        `${JSON.stringify(d.b.title)} (${d.b.org || "—"}, ${d.b.start})`,
    );
  }

  md.push("");
  md.push(`## Invalid dates — ${invalidDates.length}`);
  for (const b of invalidDates) {
    md.push(`- ${b.id} ${b.field}=${b.value} (${b.reason})`);
  }

  md.push("");
  md.push("## To-dos");
  if (todos.status === "ok") {
    const parts = Object.entries(todos.byAuto || {})
      .map(([k, n]) => `${k}: ${n}`)
      .join(", ");
    md.push(`- derived ${todos.count} to-dos (meta.auto — ${parts || "none"})`);
  } else {
    md.push(`- ${todos.status}`);
  }

  md.push("");
  md.push("## Feed payload");
  md.push(
    `- events: ${feed.count} (acceptPending: false) / ${feedAll.count} ` +
      `(acceptPending: true)`,
  );
  md.push(
    `- JSON bytes: ${feedJson.length} / ${feedAllJson.length}; trimmed: ${feed.trimmed}`,
  );

  md.push("");
  md.push(`## Adapter throws — ${throws.length}`);
  for (const t of throws) md.push(`- ${t.source} \`${t.fixture}\`: ${t.message}`);

  md.push("");
  md.push(`## Unmapped fixtures — ${unmapped.length}`);
  for (const f of unmapped) md.push(`- \`${f}\``);
  md.push("");

  return {
    report: md.join("\n"),
    summary,
    failures,
  };
}

/* ------------------------------ CLI ------------------------------ */

const invoked =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invoked) {
  const check = process.argv.includes("--check");
  const { report, summary, failures } = await runVerify({ check });
  if (!check) {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, report, "utf8");
    console.log(`report: ${REPORT_PATH}`);
  }
  console.log(JSON.stringify(summary));
  const bad = failures.duplicates + failures.invalidDates + failures.throws;
  process.exit(bad > 0 ? 1 : 0);
}
