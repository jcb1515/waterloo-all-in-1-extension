// @ts-check
/*
  Redacts the real outline.uwaterloo.ca captures (captures/outlines/, outside
  git) into synthetic-enough fixtures committed under test/fixtures/outline/.
  Instructor names and emails are removed; schedule/plan/assessment markup is
  untouched so the fixtures exercise the real template. Run once:

    node test/fixtures/outline/redact-outlines.mjs
*/

import { parseHTML } from "linkedom";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../../../../captures/outlines");

const FILES = {
  "Fall 2026_ Calculus 1 for Engineering.html": "MATH117",
  "Fall 2026_ Classical Mechanics (1).html": "ECE105",
  "Fall 2026_ Electrical and Computer Engineering Group 2.html": "GENE119",
  "Fall 2026_ Engineering Profession and Practice.html": "ECE190",
  "Fall 2026_ Fundamentals of programming.html": "ECE150",
  "Fall 2026_ Linear Algebra for Engineering.html": "MATH115",
  "Fall 2026_ Project Studio.html": "ECE198",
};

// Team lines worth keeping: office-hours schedules only. Everything else in the
// instructional team section (names, emails, roles, contact prose) is dropped.
const KEEP_LINE = /office hours|(mon|tues|wednes|thurs|fri)days?\s+\d|excluding|starting/i;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

for (const [file, code] of Object.entries(FILES)) {
  const raw = readFileSync(path.join(SRC, file), "utf8");
  const { document } = parseHTML(raw);

  // Collect personal data before removing the elements that carry it.
  const names = new Set();
  document.querySelectorAll(".instructor-info > span").forEach((s) => {
    const t = s.textContent.trim();
    if (t) names.add(t);
  });
  document.querySelectorAll('a[href^="mailto:"]').forEach((a) => {
    const m = String(a.getAttribute("title") || "").match(/^(.*?)\s*\(/);
    if (m && m[1].trim()) names.add(m[1].trim());
  });

  document.querySelectorAll("script, style, svg, link, meta, noscript, #codex-agent-overlay-root").forEach((el) => el.remove());
  document.querySelectorAll(".instructor-info").forEach((el) => {
    el.innerHTML = "<span>Instructor</span>";
  });

  // In the instructional team section, keep only office-hours-shaped p/li.
  const h2 = document.querySelector("#instructional_team");
  if (h2) {
    for (let sib = h2.nextElementSibling; sib && sib.tagName !== "H2"; sib = sib.nextElementSibling) {
      sib.querySelectorAll("p, li").forEach((el) => {
        if (KEEP_LINE.test(el.textContent)) return;
        // A wrapper whose descendants carry an office-hours line is kept so the
        // line itself survives; a leaf without the words is dropped.
        if ([...el.querySelectorAll("p, li")].some((d) => KEEP_LINE.test(d.textContent))) return;
        el.remove();
      });
    }
  }

  let out = document.toString();
  out = out.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "instructor@example.com");
  // Full names first, then any name part of four letters or more.
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(esc(name), "g"), "Instructor");
  }
  for (const name of names) {
    for (const part of name.split(/[^\p{L}]+/u)) {
      if (part.length >= 4) out = out.replace(new RegExp(`\\b${esc(part)}\\b`, "g"), "Instructor");
    }
  }

  if (out.includes("@uwaterloo.ca")) throw new Error(`${code}: a uwaterloo.ca email survived`);
  for (const name of names) {
    if (out.includes(name)) throw new Error(`${code}: name ${JSON.stringify(name)} survived`);
  }

  const target = path.join(HERE, `${code}.html`);
  writeFileSync(target, out);
  console.log(`${code}.html  ${raw.length} -> ${out.length}`);
}
console.log("done");
