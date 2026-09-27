// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXT = path.join(REPO, "extension");

const manifest = JSON.parse(readFileSync(path.join(EXT, "manifest.json"), "utf8"));

function referencedPaths(m) {
  /** @type {string[]} */
  const paths = [];
  if (m.background && m.background.service_worker) paths.push(m.background.service_worker);
  if (m.side_panel && m.side_panel.default_path) paths.push(m.side_panel.default_path);
  if (m.options_page) paths.push(m.options_page);
  if (m.options_ui && m.options_ui.page) paths.push(m.options_ui.page);
  for (const v of Object.values(m.icons || {})) paths.push(String(v));
  if (m.action) {
    for (const v of Object.values(m.action.default_icon || {})) paths.push(String(v));
    if (m.action.default_popup) paths.push(m.action.default_popup);
  }
  for (const cs of m.content_scripts || []) {
    for (const p of cs.js || []) paths.push(p);
    for (const p of cs.css || []) paths.push(p);
  }
  for (const r of m.web_accessible_resources || []) {
    for (const p of r.resources || []) paths.push(p);
  }
  return paths;
}

test("every path in extension/manifest.json exists under extension/", () => {
  const paths = referencedPaths(manifest);
  assert.ok(paths.length > 0, "manifest references no files?");
  for (const p of paths) {
    assert.ok(existsSync(path.join(EXT, p)), `missing: extension/${p}`);
  }
});

test("default_locale has a messages.json", () => {
  assert.ok(existsSync(path.join(EXT, "_locales", manifest.default_locale, "messages.json")));
});
