// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkWrangler,
  readTrackedWrangler,
} from "../../tools/verify/wrangler.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLACEHOLDER = "REPLACE_WITH_YOUR_D1_DATABASE_ID";

const cfg = (over = {}) =>
  JSON.stringify(
    {
      name: "waterloo-all-in-1-feed",
      main: "src/worker.js",
      d1_databases: [
        {
          binding: "DB",
          database_name: "waterloo-all-in-1-feed",
          database_id: PLACEHOLDER,
          migrations_dir: "migrations",
        },
      ],
      ...over,
    },
    null,
    2,
  );

test("checkWrangler: the placeholder passes", () => {
  assert.deepEqual(checkWrangler(cfg()), []);
});

test("checkWrangler: a real uuid fails without printing it", () => {
  const real = "01234567-89ab-cdef-0123-456789abcdef";
  const text = cfg().replace(PLACEHOLDER, real);
  const problems = checkWrangler(text);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /d1_databases\[0\]/);
  assert.match(problems[0], /binding "DB"/);
  assert.ok(!problems[0].includes(real), "the real id must not be printed");
});

test("checkWrangler: two d1 entries, one real, fails once", () => {
  const real = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const other = {
    binding: "DB2",
    database_name: "other",
    database_id: real,
    migrations_dir: "migrations",
  };
  const parsed = JSON.parse(cfg());
  parsed.d1_databases.push(other);
  const problems = checkWrangler(JSON.stringify(parsed));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /d1_databases\[1\]/);
  assert.match(problems[0], /binding "DB2"/);
  assert.ok(!problems[0].includes(real));
});

test("checkWrangler: a vars block fails", () => {
  const problems = checkWrangler(
    cfg({ vars: { SECRET_TOKEN: "x" } }),
  );
  assert.ok(problems.some((p) => /vars/.test(p)));
});

test("checkWrangler: account_id fails", () => {
  const problems = checkWrangler(cfg({ account_id: "abc123" }));
  assert.ok(problems.some((p) => /account_id/.test(p)));
});

test("checkWrangler: a database_id inside a comment is ignored", () => {
  const text = `{
  // "database_id": "01234567-89ab-cdef-0123-456789abcdef"
  "d1_databases": [{ "binding": "DB", "database_id": "${PLACEHOLDER}" }]
}`;
  assert.deepEqual(checkWrangler(text), []);
});

test("checkWrangler: no d1 entry fails as missing", () => {
  const problems = checkWrangler(JSON.stringify({ name: "x", main: "w.js" }));
  assert.ok(problems.some((p) => /d1 binding missing/.test(p)));
});

test("checkWrangler: // in a string literal is not a comment", () => {
  const text = `{
  "name": "x",
  "vars_url_note": "https://example.com/a",
  "d1_databases": [{ "binding": "DB", "database_id": "${PLACEHOLDER}" }]
}`;
  assert.deepEqual(checkWrangler(text), []);
});

test("the tracked server/wrangler.jsonc passes", () => {
  assert.deepEqual(checkWrangler(readTrackedWrangler(ROOT)), []);
});
