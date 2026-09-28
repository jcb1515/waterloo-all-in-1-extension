// @ts-check
// core/sites.js — siteUrlFor picks the first https checklist-row url per
// SourceId (gmail/outlook stay distinct despite the shared adapter), else
// the adapter origin; sourceForTabUrl maps a tab URL to its SourceId.
import test from "node:test";
import assert from "node:assert/strict";
import { siteUrlFor, sourceForTabUrl } from "../../extension/src/core/sites.js";
import { CHECK_SOURCES } from "../../extension/src/sources/probes.js";
import { adapterForSource } from "../../extension/src/core/registry.js";

test("siteUrlFor: gmail and outlook resolve to their own checklist rows", () => {
  assert.equal(siteUrlFor("gmail"), "https://mail.google.com/mail/u/0/#inbox");
  assert.equal(siteUrlFor("outlook"), "https://outlook.office.com/mail/inbox");
});

test("siteUrlFor: every source is https on one of its adapter's origins", () => {
  for (const source of Object.keys(CHECK_SOURCES)) {
    const url = siteUrlFor(source);
    if (url == null) continue; // a source with no checklist url and no origin
    assert.ok(url.startsWith("https://"), `${source} -> ${url} must be https`);
    const host = new URL(url).hostname;
    const adapter = adapterForSource(source);
    const originHosts = ((adapter && adapter.origins) || []).map((o) => {
      try {
        return new URL(o).hostname;
      } catch {
        return String(o);
      }
    });
    assert.ok(
      originHosts.some((h) => host === h || host.endsWith(`.${h}`)),
      `${source} -> ${host} not under adapter origins ${originHosts.join(",")}`,
    );
  }
});

test("siteUrlFor: unknown source returns null", () => {
  assert.equal(siteUrlFor("not-a-source"), null);
  assert.equal(siteUrlFor(""), null);
});

test("sourceForTabUrl maps every SITE_BY_HOST host to its source", () => {
  assert.equal(sourceForTabUrl("https://learn.uwaterloo.ca/d2l/home"), "learn");
  assert.equal(sourceForTabUrl("https://portal.uwaterloo.ca/"), "portal");
  assert.equal(sourceForTabUrl("https://waterlooworks.uwaterloo.ca/home.htm"), "waterlooworks");
  assert.equal(sourceForTabUrl("https://discord.com/channels/1/2"), "discord");
  assert.equal(sourceForTabUrl("https://outlook.office.com/mail/inbox"), "outlook");
  assert.equal(sourceForTabUrl("https://outlook.live.com/mail/0/"), "outlook");
  assert.equal(sourceForTabUrl("https://mail.google.com/mail/u/0/#inbox"), "gmail");
  assert.equal(sourceForTabUrl("https://calendar.google.com/calendar/"), "gcal");
});

test("sourceForTabUrl: unmapped/garbage URLs return null", () => {
  assert.equal(sourceForTabUrl("https://example.com/"), null);
  assert.equal(sourceForTabUrl("chrome-extension://abc/panel.html"), null);
  assert.equal(sourceForTabUrl("not a url"), null);
  assert.equal(sourceForTabUrl(""), null);
});

test("sourceForTabUrl never aliases gmail to outlook (or back)", () => {
  assert.notEqual(sourceForTabUrl("https://mail.google.com/"), "outlook");
  assert.notEqual(sourceForTabUrl("https://outlook.office.com/"), "gmail");
});
