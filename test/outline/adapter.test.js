// @ts-check
// Adapter test: ctx.fetch + ctx.relay + ctx.parseHtml wiring, failures degrade
// to complete:false, login shells report session state.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import adapter, { isLoginShell } from "../../extension/src/sources/outline/index.js";
import { parseOutline } from "../../extension/src/sources/outline/parsers.js";
import { extractDates } from "../../extension/src/lib/textdates/index.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "outline");
const NOW = new Date("2026-09-26T16:00:00Z");
const html = (code) => fs.readFileSync(path.join(DIR, `${code}.html`), "utf8");

const ROUTES = {
  "https://outline.uwaterloo.ca/viewer/math117": { status: 200, text: html("MATH117") },
  "https://outline.uwaterloo.ca/viewer/ece105": { status: 500 },
};

const SECTIONS = { "MATH 117": ["LEC 002"], "GENE 119": ["SEM 003"], "ECE 105": ["LEC 002"] };

function makeCtx(settings, { routes = ROUTES, relay = null, courses = [], terms = [], state = {} } = {}) {
  return {
    now: NOW,
    settings,
    courses,
    terms,
    state,
    calls: { fetch: [], relay: [] },
    log: () => {},
    textDates: extractDates,
    async fetch(url) {
      this.calls.fetch.push(url);
      const r = routes[url];
      if (!r) return { status: 404 };
      return { status: r.status, text: r.text, url: r.url, loginRedirect: r.loginRedirect };
    },
    async relay(origin, p) {
      this.calls.relay.push([origin, p]);
      return relay ? relay(origin, p) : { status: 0, error: "no relay" };
    },
    async parseHtml(docHtml, parser) {
      // Contract order is (html, "<source>/<name>"); anything else throws.
      if (!/^[\w-]+\/[\w-]+$/.test(String(parser))) throw new Error(`bad parser name: ${parser}`);
      assert.equal(parser, "outline/parseOutline");
      return parseOutline(parseHTML(docHtml).document);
    },
  };
}

test("adapter maps sources, keeps going past a 500, unique ids", async () => {
  const ctx = makeCtx({
    urls: Object.keys(ROUTES),
    files: [{ name: "GENE119.html", html: html("GENE119") }],
    sections: SECTIONS,
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
  assert.equal(res.session, "signed-in");
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
  const ctx = makeCtx({ urls: ["https://example.com/nope"] });
  ctx.fetch = async () => ({ status: 200, text: "<html><body>not an outline</body></html>" });
  const res = await adapter.sync(ctx);
  assert.equal(res.complete, false);
  assert.deepEqual(res.readOk, []);
  assert.equal(res.session, undefined); // not a login shell either
});

test("T1 login shell falls back to T2 relay on outline.uwaterloo.ca", async () => {
  const shell = {
    status: 200,
    url: "https://idp.uwaterloo.ca/x",
    loginRedirect: true,
    text: "<html>Sign in</html>",
  };
  const ctx = makeCtx(
    { urls: ["https://outline.uwaterloo.ca/viewer/view/abc"], sections: SECTIONS },
    {
      routes: { "https://outline.uwaterloo.ca/viewer/view/abc": shell },
      relay: () => Promise.resolve({ status: 200, text: html("MATH117") }),
    },
  );
  const res = await adapter.sync(ctx);
  assert.deepEqual(ctx.calls.relay, [["https://outline.uwaterloo.ca", "/viewer/view/abc"]]);
  assert.equal(res.session, "signed-in");
  assert.ok(res.items.length > 0);
  assert.deepEqual(res.readOk, ["MATH 117"]);
});

test("login shell + no tab -> signed-out, complete false, nothing read", async () => {
  const shell = { status: 200, url: "https://idp.uwaterloo.ca/x", text: "<html>Sign in</html>" };
  const ctx = makeCtx(
    { urls: ["https://outline.uwaterloo.ca/viewer/view/abc"], sections: SECTIONS },
    {
      routes: { "https://outline.uwaterloo.ca/viewer/view/abc": shell },
      relay: () => Promise.resolve({ status: 0, noTab: true }),
    },
  );
  const res = await adapter.sync(ctx);
  assert.equal(res.complete, false);
  assert.equal(res.session, "signed-out");
  assert.equal(res.items.length, 0);
  assert.deepEqual(res.readOk, []);
});

test("observe.parse builds items, scope matches seenIn, seenUrls recorded", async () => {
  const ctx = makeCtx({ sections: SECTIONS });
  const url = "https://outline.uwaterloo.ca/viewer/view/math117";
  const res = await adapter.observe.parse(
    { source: "outline", kind: "dom", url, body: html("MATH117"), at: NOW.toISOString() },
    ctx,
  );
  assert.ok(res.items.length > 0);
  assert.equal(res.complete, true);
  assert.equal(res.scope, "MATH 117");
  assert.ok(res.items.every((i) => i.seenIn[0].scope === res.scope));
  assert.equal(res.session, "signed-in");
  assert.equal(res.state.seenUrls["MATH 117"], url);

  // A later sync with no settings.urls still reads the observed page.
  const ctx2 = makeCtx({ sections: SECTIONS }, { state: res.state });
  const res2 = await adapter.sync(ctx2);
  assert.deepEqual(ctx2.calls.fetch, [url]);
});

test("observe.parse on a non-outline body returns an empty incomplete result", async () => {
  const ctx = makeCtx({});
  const res = await adapter.observe.parse(
    { source: "outline", kind: "dom", url: "https://outline.uwaterloo.ca/viewer/view/x", body: "<html><body>login</body></html>", at: NOW.toISOString() },
    ctx,
  );
  assert.deepEqual(res.items, []);
  assert.equal(res.complete, false);
  assert.equal(res.scope, "outline:none");
});

test("isLoginShell flags SSO shells, not real pages or plain errors", () => {
  assert.equal(isLoginShell({ status: 200, url: "https://idp.uwaterloo.ca/x", loginRedirect: true, text: "<html>Sign in</html>" }), true);
  assert.equal(isLoginShell({ status: 200, url: "https://idp.uwaterloo.ca/x", text: "redirect" }), true);
  assert.equal(isLoginShell({ status: 200, text: "<html><body>Sign in with Duo</body></html>" }), true);
  assert.equal(isLoginShell({ status: 200, url: "https://outline.uwaterloo.ca/viewer/view/abc", text: html("MATH117") }), false);
  assert.equal(isLoginShell({ status: 404, url: "https://outline.uwaterloo.ca/viewer/view/nope", text: "not found" }), false);
  assert.equal(isLoginShell(null), false);
});

test("sync accepts {name, text} syllabus files", async () => {
  const text = fs.readFileSync(path.join(DIR, "ENGL192-syllabus.txt"), "utf8");
  const ctx = makeCtx({ files: [{ name: "ENGL192.txt", text }] });
  const res = await adapter.sync(ctx);
  assert.ok(res.readOk.includes("ENGL 192"));
  assert.equal(res.items.filter((i) => i.type === "class").length, 22);
  assert.equal(res.items.filter((i) => i.type !== "class").length, 16);
  assert.equal(res.courses[0].code, "ENGL 192");
  // Unparseable text degrades instead of throwing.
  const ctx2 = makeCtx({ files: [{ name: "junk.txt", text: "not a syllabus" }] });
  const res2 = await adapter.sync(ctx2);
  assert.equal(res2.complete, false);
  assert.deepEqual(res2.readOk, []);
});

test("no fixture leaks @uwaterloo.ca", () => {
  for (const f of fs.readdirSync(DIR).filter((f) => f.endsWith(".html"))) {
    assert.ok(!fs.readFileSync(path.join(DIR, f), "utf8").includes("@uwaterloo.ca"), f);
  }
});
