// Rasterise extension/icons/*.svg into the PNG sizes the manifest references.
//   node tools/icons.mjs

import { Resvg } from "@resvg/resvg-js";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ICONS = path.join(REPO, "extension", "icons");

const JOBS = [
  { src: "icon-16.svg", out: "icon-16.png", size: 16 },
  { src: "icon.svg", out: "icon-32.png", size: 32 },
  { src: "icon.svg", out: "icon-48.png", size: 48 },
  { src: "icon.svg", out: "icon-128.png", size: 128 },
];

for (const { src, out, size } of JOBS) {
  const svg = await readFile(path.join(ICONS, src), "utf8");
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: size } });
  await writeFile(path.join(ICONS, out), resvg.render().asPng());
  console.log(`wrote extension/icons/${out} (${size}px)`);
}
