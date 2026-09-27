// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { bodyShape } from "../../extension/src/capture/redact.js";

test("bodyShape parses JSON served as text/html", () => {
  // WaterlooWorks serves JSON with a text/html content type.
  const shape = bodyShape('{"items":[{"id":42,"name":"x"}]}', "text/html", [], () => {
    throw new Error("must not call htmlShape for JSON bodies");
  });
  assert.deepEqual(shape, {
    items: { "<array>": 1, items: { id: "<number>", name: "<string 1>" } },
  });
});

test("bodyShape sniffs JSON by first non-space character", () => {
  const shape = bodyShape('   [1, 2, 3]', "text/plain");
  assert.deepEqual(shape, { "<array>": 3, items: "<number>" });
});

test("bodyShape falls back to htmlShape for real HTML", () => {
  const html = "<html><body>hi</body></html>";
  const shape = bodyShape(html, "text/html", [], (h) => ({ html: h.length }));
  assert.deepEqual(shape, { html: html.length });
});

test("bodyShape ignores junk and missing htmlShape", () => {
  assert.equal(bodyShape("{not json", "text/html"), null);
  assert.equal(bodyShape("<p>hi</p>", "text/html"), null);
  assert.equal(bodyShape("", "application/json"), null);
  assert.equal(bodyShape(null, "application/json"), null);
});
