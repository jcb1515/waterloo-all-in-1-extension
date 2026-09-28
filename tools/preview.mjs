// Preview/screenshot tool for the UI redesign.
//
//   node tools/preview.mjs serve   — static-serve dist/ on http://127.0.0.1:5178
//   node tools/preview.mjs shots   — serve dist/, drive headless Edge over CDP,
//                                    capture the screenshot set, exit
//
// Screenshots land in ../captures/screenshots/<WA1_SHOT_DIR||phase1b>/ (outside git).
// CDP is used instead of --screenshot because repeated `msedge --screenshot`
// invocations get delegated to a running Edge instance and re-shoot the wrong
// page.

import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(REPO, "dist");
const SHOT_DIR = process.env.WA1_SHOT_DIR || "phase1b";
const OUT = path.join(REPO, "..", "captures", "screenshots", SHOT_DIR);
const HOST = "127.0.0.1";
const PORT = 5178;
const BASE = `http://${HOST}:${PORT}`;
const CDP_PORT = 9333;
const CDP = `http://${HOST}:${CDP_PORT}`;

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function serve() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", BASE);
      let file = path.join(DIST, decodeURIComponent(url.pathname));
      if (url.pathname === "/" || url.pathname.endsWith("/")) file = path.join(file, "index.html");
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
}

const SHOTS_2A = [
  { name: "options-calendar-empty-light", url: "/src/options/options.html?preview=1&cal=empty#calendar", size: [1280, 900] },
  { name: "options-calendar-published-light", url: "/src/options/options.html?preview=1&cal=published#calendar", size: [1280, 900] },
  { name: "options-calendar-split-dark", url: "/src/options/options.html?preview=1&cal=split#calendar", size: [1280, 900], dark: true },
  { name: "options-calendar-resubscribe-light", url: "/src/options/options.html?preview=1&cal=error#calendar", size: [1280, 900] },
  { name: "options-sources-imports-light", url: "/src/options/options.html?preview=1&imports=1#sources", size: [1280, 900] },
  { name: "panel-calendar-error-light", url: "/src/panel/panel.html?preview=1&cal=error", size: [400, 900] },
  { name: "options-welcome-light", url: "/src/options/options.html?preview=empty#welcome", size: [1280, 900] },
];

const SHOTS_2B = [
  { name: "panel-agenda-light", url: "/src/panel/panel.html?preview=1", size: [400, 900] },
  { name: "panel-review-light", url: "/src/panel/panel.html?preview=1&view=review", size: [400, 900] },
  { name: "panel-review-edit-light", url: "/src/panel/panel.html?preview=1&view=review&edit=1", size: [400, 900] },
  { name: "panel-updates-dark", url: "/src/panel/panel.html?preview=1&view=updates", size: [400, 900], dark: true },
  { name: "options-reminders-light", url: "/src/options/options.html?preview=1#reminders", size: [1280, 900] },
  { name: "options-calendar-published-light", url: "/src/options/options.html?preview=1&cal=published#calendar", size: [1280, 900] },
];

const SHOTS_2C = [
  { name: "panel-week-light", url: "/src/panel/panel.html?preview=1&tab=calendar", size: [400, 900] },
  { name: "panel-week-dark", url: "/src/panel/panel.html?preview=1&tab=calendar", size: [400, 900], dark: true },
  { name: "panel-month-light", url: "/src/panel/panel.html?preview=1&tab=calendar&view=month", size: [400, 900] },
  { name: "panel-coop-light", url: "/src/panel/panel.html?preview=1&tab=coop&prep=waterlooworks:int-acme", size: [400, 900] },
  { name: "panel-courses-light", url: "/src/panel/panel.html?preview=1&tab=courses", size: [400, 900] },
  { name: "panel-course-detail-light", url: "/src/panel/panel.html?preview=1&tab=courses&course=MATH%20117", size: [400, 900] },
  { name: "panel-sources-overlay-light", url: "/src/panel/panel.html?preview=1&view=sources", size: [400, 900] },
  { name: "panel-review-light", url: "/src/panel/panel.html?preview=1&view=review", size: [400, 900] },
  { name: "panel-week-360", url: "/src/panel/panel.html?preview=1&tab=calendar", size: [360, 900] },
];

const SHOTS_CP2 = [
  { name: "panel-sources-discord-light", url: "/src/panel/panel.html?preview=1&view=sources", size: [400, 900] },
  { name: "options-sources-discord-light", url: "/src/options/options.html?preview=1&adv=1&imports=1#sources", size: [1280, 900] },
  { name: "panel-agenda-cp2-light", url: "/src/panel/panel.html?preview=1", size: [400, 900] },
  { name: "panel-updates-cp2-light", url: "/src/panel/panel.html?preview=1&view=updates", size: [400, 900] },
  { name: "options-calendar-published-light", url: "/src/options/options.html?preview=1&cal=published#calendar", size: [1280, 900] },
  { name: "panel-week-light", url: "/src/panel/panel.html?preview=1&tab=calendar", size: [400, 900] },
];

const SHOTS_3A = [
  { name: "panel-item-sheet-light", url: "/src/panel/panel.html?preview=1&item=learn%3Aece105-quiz3", size: [400, 900] },
  { name: "panel-quickadd-light", url: "/src/panel/panel.html?preview=1&quickadd=1&q=" + encodeURIComponent("Team meeting tomorrow 6-7pm E7 2324"), size: [400, 900] },
  { name: "panel-teams-light", url: "/src/panel/panel.html?preview=1&tab=teams", size: [400, 900] },
  { name: "panel-teams-dark", url: "/src/panel/panel.html?preview=1&tab=teams", size: [400, 900], dark: true },
  { name: "panel-sources-light", url: "/src/panel/panel.html?preview=1&view=sources", size: [400, 900] },
  { name: "panel-agenda-light", url: "/src/panel/panel.html?preview=1", size: [400, 900] },
  { name: "options-general-hidden-light", url: "/src/options/options.html?preview=1#general", size: [1280, 900] },
  { name: "options-about-backup-light", url: "/src/options/options.html?preview=1&backup=import#about", size: [1280, 900] },
  { name: "panel-tabs-360", url: "/src/panel/panel.html?preview=1", size: [360, 900] },
];

const SHOTS_3B = [
  { name: "panel-header-360", url: "/src/panel/panel.html?preview=1", size: [360, 520] },
  { name: "panel-header-400", url: "/src/panel/panel.html?preview=1", size: [400, 520] },
  { name: "panel-header-480", url: "/src/panel/panel.html?preview=1", size: [480, 520] },
  { name: "panel-item-sheet-light", url: "/src/panel/panel.html?preview=1&item=learn%3Aece105-quiz3", size: [400, 900] },
  { name: "panel-sources-permission-light", url: "/src/panel/panel.html?preview=1&view=sources&noperms=discord", size: [400, 900] },
  { name: "options-sources-permission-light", url: "/src/options/options.html?preview=1&noperms=discord#sources", size: [1280, 900] },
  { name: "options-calendar-download-light", url: "/src/options/options.html?preview=1&cal=published#calendar", size: [1280, 900] },
];

const SHOTS_CP3 = [
  { name: "panel-agenda-light", url: "/src/panel/panel.html?preview=1", size: [400, 900] },
  { name: "panel-agenda-dark", url: "/src/panel/panel.html?preview=1", size: [400, 900], dark: true },
  { name: "panel-sources-light", url: "/src/panel/panel.html?preview=1&view=sources", size: [400, 900] },
  { name: "options-sources-email-light", url: "/src/options/options.html?preview=1&adv=1#sources", size: [1280, 900] },
  { name: "panel-course-instructors-light", url: "/src/panel/panel.html?preview=1&tab=courses&course=MATH%20117", size: [400, 900] },
  { name: "panel-coop-linked-light", url: "/src/panel/panel.html?preview=1&tab=coop", size: [400, 900] },
];

const SHOTS_POST3 = [
  { name: "panel-todo-light", url: "/src/panel/panel.html?preview=1&tab=todo", size: [400, 900] },
  { name: "panel-todo-dark", url: "/src/panel/panel.html?preview=1&tab=todo", size: [400, 900], dark: true },
  { name: "panel-agenda-light", url: "/src/panel/panel.html?preview=1", size: [400, 900] },
  { name: "panel-projects-light", url: "/src/panel/panel.html?preview=1&tab=projects", size: [400, 900] },
  { name: "panel-projects-dark", url: "/src/panel/panel.html?preview=1&tab=projects", size: [400, 900], dark: true },
  { name: "panel-project-detail-light", url: "/src/panel/panel.html?preview=1&tab=projects&project=proj_communihacks", size: [400, 900] },
  { name: "panel-project-new-light", url: "/src/panel/panel.html?preview=1&tab=projects&newproject=1", size: [400, 900] },
  { name: "panel-tabs-360", url: "/src/panel/panel.html?preview=1", size: [360, 900] },
  { name: "options-general-todos-light", url: "/src/options/options.html?preview=1#general", size: [1280, 900], scroll: "#todos" },
  { name: "options-general-tabs-light", url: "/src/options/options.html?preview=1#general", size: [1280, 900], scroll: "#panel-tabs" },
  { name: "options-sources-mailscan-light", url: "/src/options/options.html?preview=1&mailscan=outlook#sources", size: [1280, 900] },
  { name: "panel-sources-mailscan-light", url: "/src/panel/panel.html?preview=1&mailscan=1&view=sources", size: [400, 900] },
];

const SHOTS =
  process.env.WA1_SHOT_DIR === "post3" ? SHOTS_POST3 :
  process.env.WA1_SHOT_DIR === "cp3" ? SHOTS_CP3 :
  process.env.WA1_SHOT_DIR === "phase3b" ? SHOTS_3B :
  process.env.WA1_SHOT_DIR === "phase3a" ? SHOTS_3A :
  process.env.WA1_SHOT_DIR === "cp2" ? SHOTS_CP2 :
  process.env.WA1_SHOT_DIR === "phase2c" ? SHOTS_2C :
  process.env.WA1_SHOT_DIR === "phase2b" ? SHOTS_2B :
  process.env.WA1_SHOT_DIR === "phase2a" ? SHOTS_2A : [
  { name: "panel-light", url: "/src/panel/panel.html?preview=1", size: [400, 900] },
  { name: "panel-light-360", url: "/src/panel/panel.html?preview=1", size: [360, 900] },
  { name: "panel-dark", url: "/src/panel/panel.html?preview=1", size: [400, 900], dark: true },
  { name: "panel-compact-light", url: "/src/panel/panel.html?preview=1&density=compact", size: [400, 900] },
  { name: "panel-sources", url: "/src/panel/panel.html?preview=1&tab=sources", size: [400, 900] },
  { name: "options-welcome-light", url: "/src/options/options.html?preview=empty#welcome", size: [1280, 900] },
  { name: "options-general-light", url: "/src/options/options.html#general", size: [1280, 900] },
  { name: "options-sources-dark", url: "/src/options/options.html#sources", size: [1280, 900], dark: true },
  { name: "options-privacy-light", url: "/src/options/options.html#privacy", size: [1280, 900] },
];

/* ------------------------------ tiny CDP client ----------------------------- */

async function waitForEndpoint(url, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`endpoint ${url} never came up`);
}

/** Minimal CDP connection over the built-in WebSocket. */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  /** @type {string[]} */
  const consoleErrors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (
      msg.method === "Runtime.exceptionThrown" ||
      (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") ||
      (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error")
    ) {
      consoleErrors.push(JSON.stringify(msg.params).slice(0, 300));
    }
  };
  const ready = new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ready, send, consoleErrors, close: () => ws.close() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------- shots ----------------------------------- */

async function shots() {
  await mkdir(OUT, { recursive: true });
  const server = serve();
  await new Promise((r) => server.listen(PORT, HOST, r));

  const profile = await mkdtemp(path.join(tmpdir(), "wa1-cdp-"));
  const edge = spawn(
    EDGE,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--force-device-scale-factor=1",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${CDP_PORT}`,
      "--remote-allow-origins=*",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );

  try {
    await waitForEndpoint(`${CDP}/json/version`);
    const targets = await waitForEndpoint(`${CDP}/json/list`);
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("no page target");
    const cdp = connect(page.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");

    for (const s of SHOTS) {
      const [w, h] = s.size;
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: w,
        height: h,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await cdp.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: s.dark ? "dark" : "light" }],
      });
      await cdp.send("Page.navigate", { url: `${BASE}${s.url}` });
      await sleep(1500); // module load + preact render + fonts
      if (s.scroll) {
        await cdp.send("Runtime.evaluate", {
          expression: `document.querySelector(${JSON.stringify(s.scroll)})?.scrollIntoView({block:"start"})`,
        });
        await sleep(250);
      }
      const stats = await cdp.send("Runtime.evaluate", {
        returnByValue: true,
        expression: `JSON.stringify({
          title: document.title,
          rows: document.querySelectorAll(".item-row").length,
          groups: document.querySelectorAll(".agenda-group").length,
          cards: document.querySelectorAll(".card").length,
          overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          badges: document.querySelectorAll(".badge").length,
          priHigh: document.querySelectorAll(".pri-high").length,
          summaryLines: document.querySelectorAll(".summary-extra, .summary-nextup").length,
          iconBadges: document.querySelectorAll(".icon-badge").length,
          reviewCards: document.querySelectorAll(".review-card").length,
          updateRows: document.querySelectorAll(".update-row").length,
          leadRows: document.querySelectorAll(".lead-row").length,
          calBlocks: document.querySelectorAll(".cal-block").length,
          calNarrow: document.querySelectorAll(".cal-block.narrow .cal-block-num").length,
          calCells: document.querySelectorAll(".cal-cell").length,
          prepCards: document.querySelectorAll(".prep-card").length,
          appCards: document.querySelectorAll(".app-card").length,
          courseCards: document.querySelectorAll(".course-card").length,
          marks: document.querySelectorAll("mark").length,
          discordCtrls: document.querySelectorAll(".discord-controls button").length,
          numInputs: document.querySelectorAll("input[type=number]").length,
          teamCards: document.querySelectorAll(".team-card").length,
          sheetFacts: document.querySelectorAll(".sheet-fact").length,
          hiddenRows: document.querySelectorAll(".hidden-row").length,
          backupSummary: document.querySelectorAll(".backup-summary").length,
          tabs: document.querySelectorAll(".tabs .tab, .segmented button").length,
          needsPerm: document.body.innerText.includes("Needs permission"),
          text: document.body.innerText.slice(0, 120)
        })`,
      });
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      const out = path.join(OUT, `${s.name}.png`);
      await writeFile(out, Buffer.from(shot.data, "base64"));
      console.log(`${s.name}.png  ${stats.result.value}`);
      if (cdp.consoleErrors.length) {
        console.log(`  console errors: ${cdp.consoleErrors.join(" | ")}`);
        cdp.consoleErrors.length = 0;
      }
    }
    await writeFile(
      path.join(OUT, "manifest.json"),
      JSON.stringify({ takenAt: new Date().toISOString(), shots: SHOTS }, null, 2)
    );
    cdp.close();
    // Politely shut the whole headless browser down — msedge.exe is a stub
    // launcher, so process-tree kills can't reach the real browser.
    try {
      const ver = await (await fetch(`${CDP}/json/version`)).json();
      const browser = connect(ver.webSocketDebuggerUrl);
      await browser.ready;
      await browser.send("Browser.close");
    } catch {
      /* already gone */
    }
  } finally {
    edge.kill();
    server.close();
    rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  const mode = process.argv[2] || "serve";
  if (mode === "serve") {
    serve().listen(PORT, HOST, () => console.log(`serving dist/ on ${BASE}`));
    return;
  }
  if (mode === "shots") return shots();
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
