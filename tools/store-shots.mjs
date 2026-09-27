// Store listing screenshots — repo tooling, not shipped.
//
//   node tools/store-shots.mjs
//
// Serves dist/ plus an in-memory "frame" page that shows the preview panel
// at 400 px beside a headline + caption on the brand background, then shoots
// five 1280×800 PNGs into store/screenshots/ plus the 440×280 promo tile and
// a copy of the 128 px icon. Preview fixtures only — never real data.

import { createServer } from "node:http";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(REPO, "dist");
const EXTENSION = path.join(REPO, "extension");
const OUT = path.join(REPO, "store", "screenshots");
const HOST = "127.0.0.1";
const PORT = 5189;
const BASE = `http://${HOST}:${PORT}`;
const CDP_PORT = 9344;
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
  ".txt": "text/plain",
};

const SHOTS = [
  {
    name: "01-agenda",
    iframe: "/src/panel/panel.html?preview=1",
    headline: "Every deadline, one glance",
    caption:
      "Learn, outlines, Portal, WaterlooWorks and your own notes merge into today, this week and what changed.",
  },
  {
    name: "02-calendar-week",
    iframe: "/src/panel/panel.html?preview=1&tab=calendar",
    headline: "Your week, mapped",
    caption:
      "Classes, labs and due dates on a real week grid — clashes outlined, loaded days shaded.",
  },
  {
    name: "03-coop",
    iframe: "/src/panel/panel.html?preview=1&tab=coop&prep=waterlooworks%3Aint-acme",
    headline: "Co-op, minus the hunt",
    caption:
      "Interview prep checklists, application status and deadlines picked up from WaterlooWorks as you browse.",
  },
  {
    name: "04-courses-grades",
    iframe: "/src/panel/panel.html?preview=1&tab=courses&course=MATH%20117",
    headline: "Know where you stand",
    caption:
      "Per-course grading schemes, assessment timelines and a needed-on-remaining calculator.",
  },
  {
    name: "05-settings-calendar",
    iframe: "/src/options/options.html?preview=1&cal=published#calendar",
    wide: true,
    headline: "One private feed",
    caption:
      "Publish to a single Google Calendar subscription — or download a one-off .ics file.",
  },
];

/** The 1280×800 frame page: panel at 400 px left, headline + caption right. */
function framePage(s) {
  const w = s.wide ? 520 : 400;
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="/icons/icon.svg"><style>
    html,body { margin:0; height:100%; }
    body {
      font-family: "Segoe UI", system-ui, sans-serif;
      background: linear-gradient(150deg, #faf6ec 0%, #f3ead2 55%, #eadfc2 100%);
    }
    .wrap { display:flex; height:100%; align-items:center; gap:56px; padding:0 64px; box-sizing:border-box; }
    .frame {
      width:${w}px; height:716px; flex:none; border-radius:18px; overflow:hidden;
      border:1px solid #d9cba3; background:#fff;
      box-shadow: 0 28px 70px rgba(74,58,16,.30), 0 4px 14px rgba(74,58,16,.18);
    }
    iframe { width:100%; height:100%; border:0; display:block; }
    .copy { max-width:600px; min-width:0; }
    .brand {
      font-size:13px; font-weight:700; letter-spacing:.22em; text-transform:uppercase;
      color:#8a6d1c; margin-bottom:18px;
      display:flex; align-items:center; gap:10px;
    }
    .brand img { width:26px; height:26px; }
    h1 { font-family: Georgia, "Times New Roman", serif; font-size:52px; line-height:1.06;
         margin:0 0 18px; color:#2b2413; font-weight:600; }
    p { font-size:19px; line-height:1.55; color:#5d5238; margin:0; }
  </style></head><body>
    <div class="wrap">
      <div class="frame"><iframe id="f" src="${s.iframe}"></iframe></div>
      <div class="copy">
        <div class="brand"><img src="/icons/icon-128.png" alt="" />Waterloo All-in-1</div>
        <h1>${s.headline}</h1>
        <p>${s.caption}</p>
      </div>
    </div>
    <script>
      const f = document.getElementById("f");
      f.addEventListener("load", () => {
        ${s.wide ? `try {
          const d = f.contentDocument;
          const nav = d.querySelector(".opt-nav");
          if (nav) nav.remove();
          const main = d.querySelector(".opt-content");
          if (main) main.style.margin = "0 auto";
        } catch (e) {}` : ""}
      });
    </script>
  </body></html>`;
}

/** 440×280 small promo tile. */
const TILE = `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="/icons/icon.svg"><style>
  html,body { margin:0; height:100%; }
  body {
    font-family: "Segoe UI", system-ui, sans-serif;
    background: linear-gradient(140deg, #f9f3e3, #eedfb8);
    display:flex; align-items:center; gap:24px; padding:0 36px; box-sizing:border-box;
  }
  img { width:84px; height:84px; flex:none; }
  h1 { font-family: Georgia, serif; font-size:34px; line-height:1.05; color:#2b2413; margin:0 0 8px; }
  .sub { font-size:12px; font-weight:700; letter-spacing:.18em; text-transform:uppercase; color:#8a6d1c; }
  p { font-size:15px; line-height:1.4; color:#5d5238; margin:6px 0 0; }
</style></head><body>
  <img src="/icons/icon-128.png" alt="" />
  <div>
    <div class="sub">Waterloo</div>
    <h1>All-in-1</h1>
    <p>Every deadline, class and interview in one side panel and one calendar.</p>
  </div>
</body></html>`;

function serve() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", BASE);
      if (url.pathname === "/store-frame.html") {
        const q = url.searchParams.get("shot");
        const s = SHOTS.find((x) => x.name === q);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(s ? framePage(s) : "no shot");
        return;
      }
      if (url.pathname === "/store-tile.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(TILE);
        return;
      }
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

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const consoleErrors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (
      msg.method === "Runtime.exceptionThrown" ||
      (msg.method === "Log.entryAdded" && msg.params.entry.level === "error")
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

async function capture(cdp, url, w, h, outFile) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: w,
    height: h,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Page.navigate", { url });
  await sleep(1800); // iframe mount + module load + fonts
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  await writeFile(outFile, Buffer.from(shot.data, "base64"));
  console.log(path.relative(REPO, outFile));
  if (cdp.consoleErrors.length) {
    console.log(`  console errors: ${cdp.consoleErrors.join(" | ")}`);
    cdp.consoleErrors.length = 0;
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const server = serve();
  await new Promise((r) => server.listen(PORT, HOST, r));

  const profile = await mkdtemp(path.join(tmpdir(), "wa1-store-cdp-"));
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
    { stdio: ["ignore", "ignore", "pipe"] },
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
      await capture(
        cdp,
        `${BASE}/store-frame.html?shot=${s.name}`,
        1280,
        800,
        path.join(OUT, `${s.name}.png`),
      );
    }
    await capture(cdp, `${BASE}/store-tile.html`, 440, 280, path.join(OUT, "..", "promo-small-440x280.png"));
    await copyFile(path.join(EXTENSION, "icons", "icon-128.png"), path.join(OUT, "..", "icon-128.png")).catch(async () => {
      // fall back to dist copy
      await copyFile(path.join(DIST, "icons", "icon-128.png"), path.join(OUT, "..", "icon-128.png"));
    });

    cdp.close();
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
