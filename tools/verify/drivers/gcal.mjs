// @ts-check
// gcal driver: fixture HTML through the real DOM extract (gcalExtract) then
// observe.parse, same as test/gcal/gcal.test.js. The reader yields no items
// — this is a no-throw check that state.events stays sane.

import fs from "node:fs";
import path from "node:path";
import { parseHTML } from "linkedom";
import adapter from "../../../extension/src/sources/gcal/index.js";
import { gcalExtract } from "../../../extension/src/sources/gcal/dom.js";

const NOW = new Date("2026-09-28T12:00:00.000Z");
const GC = "https://calendar.google.com/calendar/u/0/r/";

/** Filename -> page URL, matching test/gcal/gcal.test.js. */
const HREFS = {
  "gcal-week.html": `${GC}week/2026/9/29`,
  "gcal-day.html": `${GC}day/2026/10/1`,
  "gcal-month.html": `${GC}month/2026/10/1`,
  "gcal-schedule.html": `${GC}agenda`,
  "gcal-shortid.html": `${GC}day/2026/10/1`,
};

export default {
  source: "gcal",
  now: NOW,
  match: (p) => /[\\/]gcal[\\/][^\\/]+\.html$/i.test(p),
  /** @param {string} fixturePath @param {{now: Date, at: string, state: any}} env */
  async run(fixturePath, env) {
    const name = path.basename(fixturePath).toLowerCase();
    const href = HREFS[name] || `${GC}week/2026/9/29`;
    const doc = parseHTML(fs.readFileSync(fixturePath, "utf8")).document;
    const extract = gcalExtract(doc, href, { now: env.now });
    const res = await adapter.observe.parse(
      {
        source: "gcal",
        kind: /** @type {const} */ ("dom"),
        url: href,
        body: JSON.stringify(extract),
        at: env.at,
      },
      { now: env.now, settings: {}, state: env.state, courses: [], terms: [], log() {} },
    );
    env.state = res && res.state ? res.state : env.state;
    return res;
  },
};
