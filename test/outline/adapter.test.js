// @ts-check
// Adapter test: ctx.fetch + ctx.parseHtml wiring, failures degrade to complete:false.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import adapter from "../../extension/src/sources/outline/index.js";
import { parseOutline } from "../../extension/src/sources/outline/parsers.js";
import { extractDates } from "../../extension/src/lib/textdates/index.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "outline");
const NOW = new Date("2026-09-26T16:00:00Z");
const html = (code) => fs.readFileSync(path.join(DIR, `${code}.html`), "utf8");

const ROUTES = {
  "https://outline.uwaterloo.ca/viewer/math117": { status: 200, text: html("MATH117") },
  "https://outline.uwaterloo.ca/viewer/ece105": { status: 500 },
};

function makeCtx(settings) {
  return {
    now: NOW,
    settings,
    courses: [],
    terms: [],
    state: {},
    log: () => {},
    textDates: extractDates,
    async fetch(url) {
      const r = ROUTES[url];
      if (!r) return { status: 404 };
      return { status: r.status, text: r.text };
    },
    async parseHtml(html, parser) {
      // Contract order is (html, "<source>/<name>"); anything else throws.
      if (!/^[\w-]+\/[\w-]+$/.test(String(parser))) throw new Error(`bad parser name: ${parser}`);
      assert.equal(parser, "outline/parseOutline");
      return parseOutline(parseHTML(html).document);
    },
  };
}

test("adapter maps sources, keeps going past a 500, unique ids", async () => {
  const ctx = makeCtx({
    urls: Object.keys(ROUTES),
    files: [{ name: "GENE119.html", html: html("GENE119") }],
    sections: { "MATH 117": ["LEC 002"], "GENE 119": ["SEM 003"], "ECE 105": ["LEC 002"] },
    groups: {},
  });
  const res = await adapter.sync(ctx);
  assert.equal(res.complete, false);
  assert.ok(res.readOk.includes("MATH 117"));
  assert.ok(res.readOk.includes("GENE 119"));
  assert.ok(!res.readOk.includes("ECE 105"));
  const ids = res.items.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(res.courses.some((c) => c.code === "MATH 117"));
  assert.ok(res.items.every((i) => i.source === "outline"));
});

test("adapter merges outlineUrl from ctx.courses and sections from settings+course", async () => {
  const ctx = makeCtx({ urls: [], sections: {} });
  ctx.courses = [
    { code: "MATH 117", outlineUrl: "https://outline.uwaterloo.ca/viewer/math117", sections: ["LEC 002"] },
  ];
  const res = await adapter.sync(ctx);
  assert.equal(res.complete, true);
  assert.deepEqual(res.readOk, ["MATH 117"]);
  assert.ok(res.items.filter((i) => i.type === "class").length > 0);
});

test("a non-outline page keeps complete:false and readOk empty", async () => {
  const ctx = makeCtx({ urls: ["https://outline.uwaterloo.ca/nope"] });
  ctx.fetch = async () => ({ status: 200, text: "<html><body>not an outline</body></html>" });
  const res = await adapter.sync(ctx);
  assert.equal(res.complete, false);
  assert.deepEqual(res.readOk, []);
});

test("no fixture leaks @uwaterloo.ca", () => {
  for (const f of fs.readdirSync(DIR).filter((f) => f.endsWith(".html"))) {
    assert.ok(!fs.readFileSync(path.join(DIR, f), "utf8").includes("@uwaterloo.ca"), f);
  }
});
