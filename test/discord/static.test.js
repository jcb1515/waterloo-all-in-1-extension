// @ts-check
// Privacy hard rules: the Discord source must contain no network calls,
// no token/storage access, no navigation or clicks.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "extension",
  "src",
  "sources",
  "discord"
);

const FORBIDDEN = [
  /\bfetch\s*\(/,
  /XMLHttpRequest/,
  /\bWebSocket\b/,
  /localStorage/,
  /sessionStorage/,
  /document\.cookie/,
  /webpackChunk/,
  /\.click\s*\(/,
  /location\.assign/,
  /location\.href\s*=(?![=])/,
  /location\.replace\s*\(/,
  /history\.pushState/,
];

test("discord sources contain no forbidden APIs", () => {
  for (const file of ["content.js", "dom.js", "index.js", "messages.js", "identity.js", "recurring.js", "rules.js", "selectors.js", "time.js", "events.js"]) {
    const src = readFileSync(path.join(DIR, file), "utf8");
    // Strip comments and strings-free zones are overkill; the forbidden
    // tokens simply must not appear at all.
    for (const re of FORBIDDEN) {
      assert.equal(
        re.test(src),
        false,
        `${file} contains forbidden pattern ${re}`
      );
    }
  }
});
