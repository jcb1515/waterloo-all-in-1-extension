// @ts-check
// One-off: turn the raw ENGL 192 syllabus .txt capture into a committed
// fixture. Strips the instructor's name/email; keeps course content intact.
//   node test/fixtures/outline/redact-syllabus.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAPTURES = path.resolve(HERE, "..", "..", "..", "..", "captures", "outlines");
const SRC = path.join(CAPTURES, "ENGL 192 (008) - Engineering Communications Fall 2026 Syllabus.txt");
const OUT = path.join(HERE, "ENGL192-syllabus.txt");

let text = fs.readFileSync(SRC, "utf8");

// Collect the instructor's name from "Instructor: <name>" so we can remove it
// wherever it appears (full name and each part of 3+ letters).
const names = new Set();
for (const m of text.matchAll(/^Instructor:\s*(.+)$/gm)) {
  const full = m[1].replace(/\s+/g, " ").trim();
  if (full) {
    names.add(full);
    for (const part of full.split(/\s+/)) {
      const word = part.replace(/^[^A-Za-z]+|[^A-Za-z.]+$/g, "");
      if (word.replace(/\./g, "").length >= 3) names.add(word.replace(/\./g, ""));
    }
  }
}

// Emails first (names may sit inside them).
text = text.replace(/\b[\w.]+@uwaterloo\.ca\b/gi, "{email}");
for (const name of [...names].sort((a, b) => b.length - a.length)) {
  text = text.split(name).join("Instructor");
}
text = text.replace(/^(Instructor:\s*).+$/gm, "$1Instructor");

// Prove the scrub worked: no uwaterloo email, no collected name.
if (/[\w.]+@uwaterloo\.ca/i.test(text)) throw new Error("email remains");
for (const name of names) {
  if (name && text.includes(name)) throw new Error(`name remains: ${name}`);
}

fs.writeFileSync(OUT, text);
console.log(`${path.basename(OUT)}: ${fs.statSync(SRC).size} -> ${fs.statSync(OUT).size} bytes, removed ${names.size} name forms`);
