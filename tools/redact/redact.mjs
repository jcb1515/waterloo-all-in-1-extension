// Turns a raw capture into a committable redacted fixture.
//   node tools/redact/redact.mjs <input.(json|html)> <output> [--words a,b]
// JSON input -> shapeOf; HTML input -> htmlOutline (via linkedom).

import { readFileSync, writeFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { shapeOf, htmlOutline } from "../../extension/src/capture/redact.js";

const positional = [];
/** @type {string[]} */
let words = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--words") {
    words = String(argv[++i] || "")
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean);
  } else {
    positional.push(argv[i]);
  }
}

const [input, output] = positional;
if (!input || !output) {
  console.error("usage: node tools/redact/redact.mjs <input.(json|html)> <output.json> [--words a,b]");
  process.exit(1);
}

const text = readFileSync(input, "utf8");
let out;
if (/\.json$/i.test(input)) {
  out = shapeOf(JSON.parse(text), "", 0, words);
} else if (/\.html?$/i.test(input)) {
  out = htmlOutline(parseHTML(text).document, words);
} else {
  console.error(`unknown input type: ${input} (want .json or .html)`);
  process.exit(1);
}

writeFileSync(output, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${output}`);
