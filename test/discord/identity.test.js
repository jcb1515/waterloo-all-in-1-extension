// @ts-check
// Self/role id inference from mentions-endpoint payloads (fake snowflakes).
import test from "node:test";
import assert from "node:assert/strict";
import { inferIdentity } from "../../extension/src/sources/discord/identity.js";

const ping = (mentions, extra = {}) => ({
  mentions: mentions.map((id) => ({ id })),
  mention_roles: [],
  mention_everyone: false,
  ...extra,
});

test("direct mentions intersect to a single selfId", () => {
  const id = inferIdentity(undefined, [
    ping(["42", "99"]),       // 42 + someone else mentioned
    ping(["42"]),             // 42 alone
    ping(["42", "99", "101"]),
  ]);
  assert.equal(id.selfId, "42");
  assert.equal(id.evidence, 3);
});

test("no consensus -> no selfId", () => {
  const id = inferIdentity(undefined, [ping(["42", "99"]), ping(["7"])]);
  assert.equal(id.selfId, undefined);
});

test("known selfId turns non-direct mentions pings into roleIds", () => {
  const prev = inferIdentity(undefined, [ping(["42"])]);
  const next = inferIdentity(prev, [
    ping(["88"], { mention_roles: ["77"] }), // role ping, user not named
    ping(["42"], { mention_roles: ["77"] }), // direct ping — not a role hint
    ping([], { mention_everyone: true }),    // @everyone — not personal
    ping(["88"], { mention_roles: ["77", "78"] }), // ambiguous — skipped
  ]);
  assert.deepEqual(next.roleIds, ["77"]);
});

test("settings override/extend the inference", () => {
  const id = inferIdentity(undefined, [ping(["42"])], {
    userId: "555",
    roleIds: ["88"],
  });
  assert.equal(id.selfId, "555");
  assert.deepEqual(id.roleIds, ["88"]);
});
