// Release packaging: a clean WA1_RELEASE build, dist verification, then a
// zip in release/. `npm run package`.
//
//   WA1_CALENDAR_SERVICE_URL must be set to the production feed origin when
//   cutting a real release; the zip check rejects a localhost/empty URL only
//   when it shows up in dist.

import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipFile } from "./zip.mjs";

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
async function verifyDist(pkgVersion) {
  const problems = [];
  const feedEnv = process.env.WA1_CALENDAR_SERVICE_URL || "";
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(feedEnv))
    problems.push(`WA1_CALENDAR_SERVICE_URL points at localhost: ${feedEnv}`);
  for await (const p of walk(DIST)) {
    const rel = path.relative(DIST, p).split(path.sep).join("/");
    if (!TEXT_EXT.has(path.extname(p).toLowerCase())) continue;
    const text = await readFile(p, "utf8");
    const inLicenses = rel.startsWith("licenses/");
    if (/dev-?profile/i.test(text)) problems.push(`${rel}: mentions dev-profile`);
    if (!inLicenses && /watnow|gurshh/i.test(text))
      problems.push(`${rel}: mentions upstream project names`);
    // A shipped feed URL would bake in as an https?://host literal; the bare
    // "localhost" hostname checks in publish.js/learn mocks are fine.
    if (/https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(text))
      problems.push(`${rel}: contains a localhost URL`);
  }
  const manifest = JSON.parse(await readFile(path.join(DIST, "manifest.json"), "utf8"));
  if (manifest.version !== pkgVersion)
    problems.push(`manifest version ${manifest.version} != package.json ${pkgVersion}`);
  return problems;
}

async function main() {
  const pkg = JSON.parse(await readFile(path.join(REPO, "package.json"), "utf8"));
  const version = pkg.version;

  console.log("Building release bundle (WA1_RELEASE=1, no dev profile, minified)…");
  const build = spawnSync(process.execPath, [path.join(REPO, "tools", "build.mjs")], {
    cwd: REPO,
    env: { ...process.env, WA1_RELEASE: "1" },
    stdio: "inherit",
  });
  if (build.status !== 0) process.exit(build.status ?? 1);

  const problems = await verifyDist(version);
  if (problems.length) {
    console.error("dist verification failed:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

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
