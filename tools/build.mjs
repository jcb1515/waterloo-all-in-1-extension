// Bundles extension/ into dist/ with esbuild.
//   node tools/build.mjs          one-shot build
//   node tools/build.mjs --watch  rebuild on change (npm run dev)
//
// Everything under extension/ that is not a .js file is copied to dist/
// unchanged (manifest, html, css, fonts, icons, _locales). Every .js file
// reaches dist/ through one of the bundles below, so each bundle keeps the
// entry's own relative path (src/panel/panel.js -> dist/src/panel/panel.js).

import * as esbuild from "esbuild";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(REPO, "extension");
const DIST = path.join(REPO, "dist");

const ESM_ENTRIES = [
  "src/background/index.js",
  "src/panel/panel.js",
  "src/options/options.js",
];

const IIFE_ENTRIES = [
  "src/capture/observer.main.js",
  "src/capture/recorder.content.js",
  "src/sources/learn/content.js",
  "src/sources/portal/content.js",
  "src/sources/waterlooworks/content.js",
  "src/sources/discord/content.js",
  "src/sources/email/content.js",
];

async function* walk(dir) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(p);
    else yield p;
  }
}

async function copyStaticFile(absPath) {
  if (absPath.endsWith(".js")) return;
  const dest = path.join(DIST, path.relative(SRC, absPath));
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(absPath, dest);
}

async function copyStatic() {
  for await (const p of walk(SRC)) await copyStaticFile(p);
}

const shared = {
  bundle: true,
  minify: false,
  target: "chrome116",
  outdir: DIST,
  outbase: SRC,
  logLevel: "info",
};

const configs = [
  { ...shared, format: "esm", entryPoints: ESM_ENTRIES.map((e) => path.join(SRC, e)) },
  { ...shared, format: "iife", entryPoints: IIFE_ENTRIES.map((e) => path.join(SRC, e)) },
];

const watchMode = process.argv.includes("--watch");

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });
await copyStatic();

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
