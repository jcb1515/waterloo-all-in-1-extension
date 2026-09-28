// @ts-check
// Learn driver: the redacted fixture set is a fake-API route map
// (test/fixtures/learn/fixtures.js), run through adapter.sync exactly the
// way test/learn/*.test.js does.

import adapter from "../../../extension/src/sources/learn/index.js";
import { learnRoutes, makeCtx, NOW } from "../../../test/fixtures/learn/fixtures.js";

export default {
  source: "learn",
  // Fixture dates were authored around the adapter test's NOW.
  now: NOW,
  match: (p) => /[\\/]learn[\\/]fixtures\.js$/i.test(p),
  /** @param {string} fixturePath @param {{now: Date, at: string, state: any}} env */
  async run(fixturePath, env) {
    const { ctx } = makeCtx(learnRoutes(), { now: env.now });
    return adapter.sync(ctx);
  },
};
