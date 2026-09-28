// @ts-check
// Outline driver: HTML fixtures through observe.parse (scope = the page's
// course code, so fixtures accumulate); the .txt syllabus only exists
// through sync's settings.files path.

import fs from "node:fs";
import path from "node:path";
import { parseHTML } from "linkedom";
import adapter from "../../../extension/src/sources/outline/index.js";
import { parseOutline } from "../../../extension/src/sources/outline/parsers.js";
import { extractDates } from "../../../extension/src/lib/textdates/index.js";

const NOW = new Date("2026-09-26T16:00:00.000Z");

export default {
  source: "outline",
  now: NOW,
  match: (p) => /[\\/]outline[\\/][^\\/]+\.(html|txt)$/i.test(p),
  /** @param {string} fixturePath @param {{now: Date, at: string, state: any}} env */
  async run(fixturePath, env) {
    const name = path.basename(fixturePath);
    const ctx = {
      now: env.now,
      settings: {},
      state: env.state,
      courses: [],
      terms: [],
      calls: { fetch: [], relay: [] },
      log() {},
      textDates: extractDates,
      fetch: async () => ({ status: 0 }),
      relay: async () => ({ status: 0 }),
      parseHtml: async (docHtml, parser) =>
        parseOutline(parseHTML(String(docHtml)).document),
    };
    if (/\.txt$/i.test(name)) {
      ctx.settings = { files: [{ name, text: fs.readFileSync(fixturePath, "utf8") }] };
      const res = await adapter.sync(ctx);
      env.state = res && res.state ? res.state : env.state;
      // A complete sync would replace every other outline's items when
      // folded; report this one-file read as partial so the harness keeps
      // the union (readOk already carries its course scope).
      return { ...res, complete: false };
    }
    const slug = name.replace(/\.html$/i, "").toLowerCase();
    const res = await adapter.observe.parse(
      {
        source: "outline",
        kind: /** @type {const} */ ("dom"),
        url: `https://outline.uwaterloo.ca/viewer/view/${slug}`,
        body: fs.readFileSync(fixturePath, "utf8"),
        at: env.at,
      },
      ctx,
    );
    env.state = res && res.state ? res.state : env.state;
    return res;
  },
};
