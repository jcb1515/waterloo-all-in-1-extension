// @ts-check
// server/wrangler.jsonc guard: the tracked file ships to anyone who clones
// the repo, so it must never carry a real D1 database_id, a vars block or
// an account_id. Real values live in an untracked local config.
//
// checkWrangler(text) -> string[] of problems (empty = ok). Messages name
// the binding/index but never print the offending value.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PLACEHOLDER = "REPLACE_WITH_YOUR_D1_DATABASE_ID";
const WRANGLER_PATH = path.join("server", "wrangler.jsonc");

/**
 * Strip // and /* *​/ comments without touching string literals
 * (values may legitimately contain "https://…").
 * @param {string} text
 * @returns {string}
 */
function stripComments(text) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++; // skip the closing '/'
      continue;
    }
    out += c;
  }
  return out;
}

/** @param {any} v */
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Check wrangler.jsonc text for values that must never be tracked.
 * @param {string} text JSONC source
 * @returns {string[]} problems (empty = ok)
 */
export function checkWrangler(text) {
  /** @type {string[]} */
  const problems = [];
  let root;
  try {
    root = JSON.parse(stripComments(String(text ?? "")));
  } catch (e) {
    return [`wrangler.jsonc does not parse: ${String((e && e.message) || e)}`];
  }

  let d1Count = 0;
  /** @param {any} node @param {string} at */
  const walk = (node, at) => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${at}[${i}]`));
      return;
    }
    if (!isObj(node)) return;
    for (const [k, v] of Object.entries(node)) {
      const here = at ? `${at}.${k}` : k;
      if (k === "vars") {
        problems.push(`${here}: "vars" must not be tracked — keep real values in an untracked local config`);
      } else if (k === "account_id") {
        problems.push(`${here}: "account_id" must not be tracked`);
      } else if (k === "database_id") {
        d1Count++;
        if (v !== PLACEHOLDER) {
          const binding =
            isObj(node) && typeof node.binding === "string"
              ? ` (binding "${node.binding}")`
              : "";
          problems.push(`${here}${binding}: database_id is not the placeholder`);
        }
      }
      walk(v, here);
    }
  };
  walk(root, "");

  if (!d1Count) {
    problems.push("d1 binding missing: no database_id entries — the binding must not be deleted");
  }
  return problems;
}

/**
 * The index copy of server/wrangler.jsonc — what a commit/push would
 * actually carry (`git show :server/wrangler.jsonc`). Falls back to the
 * working-tree file when git isn't available.
 * @param {string} repoRoot
 * @returns {string}
 */
export function readTrackedWrangler(repoRoot) {
  try {
    return execFileSync("git", ["show", ":server/wrangler.jsonc"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return fs.readFileSync(path.join(repoRoot, WRANGLER_PATH), "utf8");
  }
}
