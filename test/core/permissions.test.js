// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  OPTIONAL_PERMISSION_GROUPS,
  neededGroups,
  scriptsForGrants,
} from "../../extension/src/core/permissions.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(
  readFileSync(path.join(REPO, "extension", "manifest.json"), "utf8"),
);

const ALL_OPTIONAL = Object.values(OPTIONAL_PERMISSION_GROUPS).flat();

test("scriptsForGrants: no grants -> no scripts", () => {
  assert.deepEqual(scriptsForGrants([]), []);
  assert.deepEqual(scriptsForGrants(["https://learn.uwaterloo.ca/*"]), []);
});

test("scriptsForGrants: discord grant registers observer + recorder", () => {
  const list = scriptsForGrants(["https://discord.com/*"]);
  assert.equal(list.length, 2);
  const obs = list.find((s) => s.id === "wa1:obs:discord");
  const rec = list.find((s) => s.id === "wa1:rec:discord");
  assert.ok(obs && rec);
  assert.deepEqual(obs.js, ["src/capture/observer.main.js"]);
  assert.equal(obs.world, "MAIN");
  assert.equal(obs.runAt, "document_start");
  assert.deepEqual(obs.matches, ["https://discord.com/*"]);
  assert.deepEqual(rec.js, [
    "src/capture/recorder.content.js",
    "src/sources/discord/content.js",
  ]);
  assert.equal(rec.world, undefined); // isolated, like the static entries
});

test("scriptsForGrants: outlook-only grant registers only the outlook group", () => {
  const list = scriptsForGrants(OPTIONAL_PERMISSION_GROUPS.outlook);
  assert.equal(list.length, 2);
  const obs = list.find((s) => s.id === "wa1:obs:outlook");
  const rec = list.find((s) => s.id === "wa1:rec:outlook");
  assert.ok(obs && rec);
  assert.deepEqual(obs.matches, OPTIONAL_PERMISSION_GROUPS.outlook);
  assert.deepEqual(rec.js, [
    "src/capture/recorder.content.js",
    "src/sources/email/content.js",
  ]);
});

test("scriptsForGrants: gmail-only grant registers only the gmail group", () => {
  const list = scriptsForGrants(["https://mail.google.com/*"]);
  assert.equal(list.length, 2);
  for (const s of list) {
    assert.deepEqual(s.matches, ["https://mail.google.com/*"]);
    assert.ok(s.id.endsWith(":gmail"));
  }
  const rec = list.find((s) => s.id === "wa1:rec:gmail");
  assert.ok(rec && rec.js.includes("src/sources/email/content.js"));
});

test("scriptsForGrants: all grants register both email groups plus discord", () => {
  const list = scriptsForGrants(ALL_OPTIONAL);
  assert.equal(list.length, 7);
  for (const g of ["discord", "outlook", "gmail"]) {
    assert.ok(list.some((s) => s.id === `wa1:obs:${g}`), `obs:${g}`);
    assert.ok(list.some((s) => s.id === `wa1:rec:${g}`), `rec:${g}`);
  }
  assert.ok(list.some((s) => s.id === "wa1:rec:gcal"), "rec:gcal");
});

test("scriptsForGrants: gcal registers only recorder + source script at document_idle", () => {
  const list = scriptsForGrants(["https://calendar.google.com/*"]);
  // No MAIN-world observer: gcal reads the DOM directly, no network payloads.
  assert.equal(list.length, 1);
  const rec = list[0];
  assert.equal(rec.id, "wa1:rec:gcal");
  assert.deepEqual(rec.js, [
    "src/capture/recorder.content.js",
    "src/sources/gcal/content.js",
  ]);
  assert.equal(rec.runAt, "document_idle");
  assert.equal(rec.world, undefined);
  assert.deepEqual(rec.matches, ["https://calendar.google.com/*"]);
});

test("neededGroups: discord gates on enabled, email gates per provider", () => {
  assert.deepEqual(neededGroups("discord", {}), ["discord"]);
  assert.deepEqual(neededGroups("discord", { enabled: false }), []);
  assert.deepEqual(neededGroups("outlook", {}), ["outlook", "gmail"]);
  assert.deepEqual(neededGroups("outlook", { enabled: false }), []);
  assert.deepEqual(neededGroups("outlook", { gmail: false }), ["outlook"]);
  assert.deepEqual(neededGroups("outlook", { outlook: false, gmail: false }), []);
  assert.deepEqual(neededGroups("learn", {}), []);
  // gcal is off by default: unset needs nothing; only enabled === true does.
  assert.deepEqual(neededGroups("gcal", undefined), []);
  assert.deepEqual(neededGroups("gcal", {}), []);
  assert.deepEqual(neededGroups("gcal", { enabled: false }), []);
  assert.deepEqual(neededGroups("gcal", { enabled: true }), ["gcal"]);
  assert.deepEqual(neededGroups("gcal", { enabled: true, gcal: false }), []);
});

test("manifest: optional hosts are not required and not static-matched", () => {
  const required = new Set(manifest.host_permissions || []);
  const optional = new Set(manifest.optional_host_permissions || []);
  for (const o of ALL_OPTIONAL) {
    assert.ok(optional.has(o), `${o} missing from optional_host_permissions`);
    assert.ok(!required.has(o), `${o} still required`);
  }
  for (const cs of manifest.content_scripts || []) {
    for (const match of cs.matches || []) {
      assert.ok(!optional.has(match), `static content_scripts still match ${match}`);
    }
  }
  assert.ok((manifest.permissions || []).includes("scripting"));
  // Required hosts still cover the Waterloo sites.
  for (const h of [
    "https://learn.uwaterloo.ca/*",
    "https://outline.uwaterloo.ca/*",
    "https://portal.uwaterloo.ca/*",
    "https://portalapi2.uwaterloo.ca/*",
    "https://waterlooworks.uwaterloo.ca/*",
    "https://uwaterloo.ca/co-operative-education/*",
  ]) {
    assert.ok(required.has(h), `required host missing: ${h}`);
  }
});
