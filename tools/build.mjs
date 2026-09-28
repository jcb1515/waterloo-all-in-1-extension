// Bundles extension/ into dist/ with esbuild.
//   node tools/build.mjs          one-shot build
//   node tools/build.mjs --watch  rebuild on change (npm run dev)
//
// Everything under extension/ that is not a .js file is copied to dist/
// unchanged (manifest, html, css, fonts, icons, _locales). Every .js file
// reaches dist/ through one of the bundles below, so each bundle keeps the
// entry's own relative path (src/panel/panel.js -> dist/src/panel/panel.js).

import * as esbuild from "esbuild";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(REPO, "extension");
const DIST = path.join(REPO, "dist");

const pkg = JSON.parse(await readFile(path.join(REPO, "package.json"), "utf8"));

// The shared calendar server is built into every bundle (dev and release)
// from package.json's config.calendarServiceUrl. WA1_CALENDAR_SERVICE_URL
// overrides it — an explicitly empty value bakes "" so self-hosters can ship
// a build with no default server. The user's saved setting always wins at
// runtime (see BUILT_IN_SERVICE_URL in core/store.js).
const CALENDAR_SERVICE_URL =
  process.env.WA1_CALENDAR_SERVICE_URL ??
  (pkg.config && pkg.config.calendarServiceUrl) ??
  "";

const ESM_ENTRIES = [
  "src/background/index.js",
  "src/panel/main.jsx",
  "src/options/main.jsx",
  "src/capture/offscreen.js",
];

const IIFE_ENTRIES = [
  "src/capture/observer.main.js",
  "src/capture/recorder.content.js",
  "src/sources/learn/content.js",
  "src/sources/outline/content.js",
  "src/sources/portal/content.js",
  "src/sources/waterlooworks/content.js",
  "src/sources/discord/content.js",
  "src/sources/email/content.js",
  "src/sources/gcal/content.js",
];

async function* walk(dir) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(p);
    else yield p;
  }
}

async function copyStaticFile(absPath) {
  const base = path.basename(absPath).toLowerCase();
  if (absPath.endsWith(".js") || absPath.endsWith(".jsx")) return;
  if (absPath.endsWith(".d.ts")) return; // dev-time typings, not for the bundle
  if (base === "readme.md" || base === "license" || base === "license.md") return; // docs stay in the repo, not the bundle
  const dest = path.join(DIST, path.relative(SRC, absPath));
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(absPath, dest);
}

async function copyStatic() {
  for await (const p of walk(SRC)) await copyStaticFile(p);
}

/**
 * dist/vendor/pdf.worker.min.mjs — pdfjs's web worker, loaded by the options
 * page via chrome.runtime.getURL (only options imports pdfjs; the worker file
 * itself must ship unbundled).
 */
async function copyVendor() {
  const src = path.join(REPO, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.min.mjs");
  const dest = path.join(DIST, "vendor", "pdf.worker.min.mjs");
  try {
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(src, dest);
  } catch {
    console.warn("pdfjs-dist worker not found — PDF import will fall back to pdfjs's fake worker");
  }
}

/** dist/licenses/THIRD_PARTY_NOTICES.txt — repo LICENSE + every licenses/ file. */
async function writeNotices() {
  const parts = [await readFile(path.join(REPO, "LICENSE"), "utf8")];
  const licDir = path.join(REPO, "licenses");
  for (const f of (await readdir(licDir)).sort()) {
    const text = await readFile(path.join(licDir, f), "utf8");
    parts.push(`\n${"=".repeat(72)}\n\n${f}\n\n${"=".repeat(72)}\n\n${text}`);
  }
  const dest = path.join(DIST, "licenses", "THIRD_PARTY_NOTICES.txt");
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, parts.join("\n"));
}

// Optional local developer defaults (gitignored): repo-root dev-profile.json
// is baked into the bundle as __WA1_DEV_PROFILE__ and merged over
// DEFAULT_SETTINGS by core/store.js. Release builds (WA1_RELEASE=1, via
// tools/package.mjs) ignore it entirely — a shipped bundle must never carry
// personal defaults — and minify the JS.
const RELEASE = process.env.WA1_RELEASE === "1";
let devProfile = null;
if (!RELEASE) {
  try {
    devProfile = JSON.parse(await readFile(path.join(REPO, "dev-profile.json"), "utf8"));
  } catch {
    /* no dev profile — blank defaults */
  }
}

const shared = {
  bundle: true,
  minify: RELEASE,
  target: "chrome116",
  jsx: "automatic",
  jsxImportSource: "preact",
  outdir: DIST,
  outbase: SRC,
  logLevel: "info",
  define: {
    __WA1_DEV_PROFILE__: JSON.stringify(devProfile ?? null),
    __WA1_CALENDAR_SERVICE_URL__: JSON.stringify(CALENDAR_SERVICE_URL),
  },
};

const configs = [
  { ...shared, format: "esm", entryPoints: ESM_ENTRIES.map((e) => path.join(SRC, e)) },
  { ...shared, format: "iife", entryPoints: IIFE_ENTRIES.map((e) => path.join(SRC, e)) },
];

const watchMode = process.argv.includes("--watch");

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });
await copyStatic();
await copyVendor();
await writeNotices();

if (!watchMode) {
  await Promise.all(configs.map((c) => esbuild.build(c)));
} else {
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  // Bundles only cover .js; re-copy other files when they change.
  watch(SRC, { recursive: true }, (_event, rel) => {
    if (!rel || rel.endsWith(".js")) return;
    copyStaticFile(path.join(SRC, rel)).catch((e) => console.error("copy failed", rel, e));
  });
  console.log("Watching extension/ for changes...");
}
