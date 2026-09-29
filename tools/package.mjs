// Release packaging: a clean WA1_RELEASE build, dist verification, then a
// zip in release/. `npm run package`.
//
//   The built bundles must carry a valid https calendar service URL —
//   package.json's config.calendarServiceUrl, overridable with
//   WA1_CALENDAR_SERVICE_URL at build time. The check reads the actual
//   baked literal out of dist, rejects localhost, and prints the URL.

import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipFile } from "./zip.mjs";
import { checkWrangler, readTrackedWrangler } from "./verify/wrangler.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(REPO, "dist");
const RELEASE_DIR = path.join(REPO, "release");

const TEXT_EXT = new Set([".js", ".mjs", ".json", ".html", ".css", ".txt", ".md", ".svg", ".ts"]);

async function* walk(dir) {
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(p);
    else yield p;
  }
}

/** Scan the built dist for things that must not ship. */
async function verifyDist(pkgVersion, expectedServiceUrl) {
  const problems = [];
  let baked = null;
  for await (const p of walk(DIST)) {
    const rel = path.relative(DIST, p).split(path.sep).join("/");
    if (!TEXT_EXT.has(path.extname(p).toLowerCase())) continue;
    const text = await readFile(p, "utf8");
    const inLicenses = rel.startsWith("licenses/");
    if (/dev-?profile/i.test(text)) problems.push(`${rel}: mentions dev-profile`);
    if (!inLicenses && /gurshh/i.test(text))
      problems.push(`${rel}: mentions upstream project names`);
    // A shipped feed URL would bake in as an https?://host literal; the bare
    // "localhost" hostname checks in publish.js/learn mocks are fine.
    if (/https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(text))
      problems.push(`${rel}: contains a localhost URL`);
    if (expectedServiceUrl && text.includes(expectedServiceUrl)) baked = expectedServiceUrl;
  }
  const manifest = JSON.parse(await readFile(path.join(DIST, "manifest.json"), "utf8"));
  if (manifest.version !== pkgVersion)
    problems.push(`manifest version ${manifest.version} != package.json ${pkgVersion}`);
  // Releases ship the shared feed server: the expected https URL must be a
  // literal in at least one bundle. (minified or not, the define bakes the
  // same string)
  if (!expectedServiceUrl) {
    problems.push("no calendar service URL configured — set config.calendarServiceUrl or WA1_CALENDAR_SERVICE_URL");
  } else if (!/^https:\/\/[^/]+$/.test(expectedServiceUrl)) {
    problems.push(`calendar service URL is not a bare https origin: ${expectedServiceUrl}`);
  } else if (!baked) {
    problems.push(`calendar service URL ${expectedServiceUrl} is not baked into any dist bundle`);
  }
  return { problems, baked };
}

/**
 * server/wrangler.jsonc must never carry a real D1 database_id, a vars
 * block or an account_id — checked on both the index copy (what a push
 * would ship) and the working-tree file (what the developer has locally).
 */
async function verifyWrangler() {
  /** @type {string[]} */
  const problems = [];
  try {
    for (const p of checkWrangler(readTrackedWrangler(REPO))) {
      problems.push(`tracked: ${p}`);
    }
  } catch (e) {
    problems.push(`tracked: cannot read index copy — ${String((e && e.message) || e)}`);
  }
  try {
    const wt = await readFile(path.join(REPO, "server", "wrangler.jsonc"), "utf8");
    for (const p of checkWrangler(wt)) problems.push(`worktree: ${p}`);
  } catch (e) {
    problems.push(`worktree: cannot read file — ${String((e && e.message) || e)}`);
  }
  return problems;
}

async function main() {
  const pkg = JSON.parse(await readFile(path.join(REPO, "package.json"), "utf8"));
  const version = pkg.version;

  console.log("Building release bundle (WA1_RELEASE=1, no dev profile, minified)…");
  const expectedServiceUrl =
    process.env.WA1_CALENDAR_SERVICE_URL ??
    (pkg.config && pkg.config.calendarServiceUrl) ??
    "";

  const build = spawnSync(process.execPath, [path.join(REPO, "tools", "build.mjs")], {
    cwd: REPO,
    env: { ...process.env, WA1_RELEASE: "1" },
    stdio: "inherit",
  });
  if (build.status !== 0) process.exit(build.status ?? 1);

  const { problems, baked } = await verifyDist(version, expectedServiceUrl);
  problems.push(...(await verifyWrangler()));
  if (problems.length) {
    console.error("dist verification failed:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`calendar service URL baked in: ${baked}`);

  const entries = [];
  for await (const p of walk(DIST)) {
    const rel = path.relative(DIST, p).split(path.sep).join("/");
    entries.push({ name: rel, data: await readFile(p) });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));

  await mkdir(RELEASE_DIR, { recursive: true });
  const zipPath = path.join(RELEASE_DIR, `waterloo-all-in-1-${version}.zip`);
  const buf = zipFile(entries);
  await writeFile(zipPath, buf);
  console.log(`${path.relative(REPO, zipPath)} — ${entries.length} files, ${(buf.length / 1024).toFixed(1)} KiB`);
}

await main();
