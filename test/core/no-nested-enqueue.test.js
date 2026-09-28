// @ts-check
// Regression: a `wa1:probe` handler once wrapped mutateKey() inside enqueue()
// (background/index.js recordProbeResult). mutateKey() itself enqueues on the
// shared store queue, so the outer task awaited an inner task that could only
// run after the outer finished — a permanent deadlock that silently froze
// every storage write (readStats, sourceState, raws, probes).
//
// This scan fails when any enqueue() argument calls a function that itself
// enqueues. The enqueuing set is computed by fixpoint from the sources, so
// wrappers (recordReadStat, appendLog, recordProbeResult, ...) count too.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "extension",
  "src"
);

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.jsx?$/.test(e.name)) yield p;
  }
}

/** Blanks comments and literals, preserving offsets and newlines. */
function strip(src) {
  const out = src.split("");
  let i = 0;
  const n = src.length;
  const prevSignificant = () => {
    for (let j = i - 1; j >= 0; j--) {
      const c = src[j];
      if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") return c;
    }
    return "";
  };
  const blank = (from, to) => {
    for (let j = from; j < to; j++) if (src[j] !== "\n") out[j] = " ";
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
    } else if (c === "/" && d === "*") {
      let j = src.indexOf("*/", i + 2);
      j = j < 0 ? n : j + 2;
      blank(i, j);
      i = j;
    } else if (c === "/" && "=({[,;:!&|?".includes(prevSignificant())) {
      // regex literal — blank to the closing slash + flags
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const ch = src[j];
        if (ch === "\\") j++;
        else if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) break;
        j++;
      }
      j++;
      while (j < n && /[a-z]/i.test(src[j])) j++;
      blank(i, j);
      i = j;
    } else if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") j++;
        else if (src[j] === c) break;
        j++;
      }
      blank(i, j + 1);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

/** index just past the balanced group opened at `open` (`(`, `{` or `[`). */
function matchBalanced(s, open) {
  const close = { "(": ")", "{": "}", "[": "]" }[s[open]];
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    if (s[j] === s[open]) depth++;
    else if (s[j] === close && --depth === 0) return j + 1;
  }
  return s.length;
}

const IDENT = String.raw`[A-Za-z_$][\w$]*`;

/** name -> body text, for every function-ish definition in the file. */
function functionBodies(s) {
  const defs = new Map();
  const takeBody = (afterParams) => {
    let j = afterParams;
    while (j < s.length && /\s/.test(s[j])) j++;
    if (s.startsWith("=>", j)) {
      j += 2;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === "{") return s.slice(j, matchBalanced(s, j));
      const semi = s.indexOf(";", j);
      return s.slice(j, semi < 0 ? s.length : semi);
    }
    if (s[j] === "{") return s.slice(j, matchBalanced(s, j));
    return "";
  };
  for (const m of s.matchAll(new RegExp(`\\bfunction\\s+(${IDENT})\\s*\\(`, "g"))) {
    const paramsEnd = matchBalanced(s, m.index + m[0].length - 1);
    defs.set(m[1], takeBody(paramsEnd));
  }
  for (const m of s.matchAll(
    new RegExp(`\\b(?:const|let|var)\\s+(${IDENT})\\s*=\\s*async\\s+(${IDENT})\\s*=>`, "g")
  )) {
    const semi = s.indexOf(";", m.index + m[0].length);
    defs.set(m[1], s.slice(m.index + m[0].length, semi < 0 ? s.length : semi));
  }
  for (const m of s.matchAll(
    new RegExp(`\\b(?:const|let|var)\\s+(${IDENT})\\s*=\\s*(?:async\\s+)?\\(`, "g")
  )) {
    if (defs.has(m[1])) continue;
    const paramsEnd = matchBalanced(s, m.index + m[0].length - 1);
    const body = takeBody(paramsEnd);
    if (body) defs.set(m[1], body);
  }
  return defs;
}

const files = [...walk(SRC)];
const allDefs = new Map();
const strippedByFile = new Map();
for (const f of files) {
  const stripped = strip(readFileSync(f, "utf8"));
  strippedByFile.set(f, stripped);
  for (const [name, body] of functionBodies(stripped)) {
    if (!allDefs.has(name)) allDefs.set(name, body);
  }
}

// A function "enqueues" when its body calls enqueue() or another function
// that does. enqueue is the shared write queue's serializer (core/store.js);
// discovery-store.js has a same-named local on its own queue — flagging a
// shared-queue arg that calls one of its callers would still be correct.
// Property calls (foo.bar()) are skipped — `chrome.alarms.create` is not the
// `create` in some panel handler, and deps objects can't be resolved.
const callsBare = (/** @type {string} */ text, /** @type {string} */ name) =>
  new RegExp(`(?<!\\.)\\b${name}\\s*\\(`).test(text);

const enqueuing = new Set(["enqueue"]);
let grew = true;
while (grew) {
  grew = false;
  for (const [name, body] of allDefs) {
    if (enqueuing.has(name)) continue;
    for (const e of enqueuing) {
      if (callsBare(body, e)) {
        enqueuing.add(name);
        grew = true;
        break;
      }
    }
  }
}

test("no enqueue() argument calls a function that itself enqueues", () => {
  const violations = [];
  for (const f of files) {
    const s = /** @type {string} */ (strippedByFile.get(f));
    for (const m of s.matchAll(/(?<!\.)\benqueue\s*\(/g)) {
      const argEnd = matchBalanced(s, m.index + m[0].length - 1);
      const arg = s.slice(m.index + m[0].length - 1, argEnd);
      for (const e of enqueuing) {
        if (callsBare(arg, e)) {
          const line = s.slice(0, m.index).split("\n").length;
          violations.push(`${path.relative(SRC, f)}:${line} enqueue(...) calls ${e}()`);
        }
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("the enqueuing set found the known writers", () => {
  for (const name of [
    "enqueue",
    "setLocal",
    "setSettings",
    "mutateKey",
    "pushUpdates",
    "appendLog",
    "patchUserState",
    "recomputeAll",
    "recordReadStat",
    "recordProbeResult",
  ]) {
    assert.ok(enqueuing.has(name), `${name} should be classified as enqueuing`);
  }
});
