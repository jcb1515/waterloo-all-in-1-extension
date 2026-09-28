// @ts-check
// WaterlooWorks driver: HTML fixtures as observed page responses through
// observe.parse (the adapter's ctx.parseHtml fake dispatches to the real
// parsers, like test/waterlooworks/adapter.test.js). The public co-op
// important-dates page is a fetch target, so it runs through sync().

import fs from "node:fs";
import path from "node:path";
import { parseHTML } from "linkedom";
import adapter from "../../../extension/src/sources/waterlooworks/index.js";
import * as parsers from "../../../extension/src/sources/waterlooworks/parsers.js";
import { COOP_DATES_URL } from "../../../extension/src/sources/waterlooworks/selectors.js";
import { extractDates } from "../../../extension/src/lib/textdates/index.js";

const NOW = new Date("2026-09-20T12:00:00.000Z");
const WW = "https://waterlooworks.uwaterloo.ca/myAccount/co-op/full";

/** Fixture filename -> the page URL the adapter test reads it as. */
const URL_RULES = [
  [/^applications?(-|\.)/i, `${WW}/applications.htm`],
  [/^interviews\.html$/i, `${WW}/interviews.htm`],
  [/^interview-detail/i, `${WW}/interviews.htm`],
  [/^posting/i, `${WW}/jobs.htm`],
  [/^dashboard/i, "https://waterlooworks.uwaterloo.ca/myAccount/dashboard.htm"],
  [/^(events|messages)\.html$/i, "https://waterlooworks.uwaterloo.ca/myAccount/dashboard.htm"],
  [/^message-detail/i, `${WW}/messages.htm`],
  [/^rankings/i, "https://waterlooworks.uwaterloo.ca/myAccount/co-op/rankings.htm"],
  [/not-logged-in/i, "https://waterlooworks.uwaterloo.ca/notLoggedIn.htm"],
];

/** @param {string} name */
function urlFor(name) {
  for (const [re, url] of URL_RULES) if (re.test(name)) return url;
  return `${WW}/dashboard.htm`;
}

/** @param {any} state @param {Date} now */
function ctx(state, now, fetchImpl) {
  return {
    state,
    now,
    settings: {},
    fetch: fetchImpl,
    async parseHtml(html, name, opts) {
      const exportName = String(name).split("/")[1];
      const fn = /** @type {any} */ (parsers)[exportName];
      return fn(parseHTML(String(html)).document, opts);
    },
    textDates: extractDates,
    log() {},
  };
}

export default {
  source: "waterlooworks",
  now: NOW,
  match: (p) => /[\\/]waterlooworks[\\/][^\\/]+\.html$/i.test(p),
  /** @param {string} fixturePath @param {{now: Date, at: string, state: any}} env */
  async run(fixturePath, env) {
    const name = path.basename(fixturePath).toLowerCase();
    const html = fs.readFileSync(fixturePath, "utf8");
    if (name.startsWith("coop-important-dates")) {
      // The public co-op dates page is fetched by sync(), not observed.
      const c = ctx(env.state, env.now, async (url) =>
        String(url) === COOP_DATES_URL
          ? { status: 200, text: html }
          : { status: 0 },
      );
      const res = await adapter.sync(c);
      env.state = res && res.state ? res.state : env.state;
      // A complete sync would replace this source's folded items; report
      // the read as partial so the harness keeps the union.
      return { ...res, complete: false };
    }
    const res = await adapter.observe.parse(
      {
        source: "waterlooworks",
        kind: /** @type {const} */ ("net"),
        url: urlFor(name),
        body: html,
        at: env.at,
      },
      ctx(env.state, env.now),
    );
    env.state = res && res.state ? res.state : env.state;
    return res;
  },
};
