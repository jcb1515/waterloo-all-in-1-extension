// @ts-check
// Email driver: HTML fixtures through the real DOM extractor (extractFor)
// then observe.parse, same as test/email/adapter.test.js. The adapter id is
// "outlook"; the payload's source field is the extract's provider.

import fs from "node:fs";
import path from "node:path";
import { parseHTML } from "linkedom";
import adapter from "../../../extension/src/sources/email/index.js";
import { extractFor } from "../../../extension/src/sources/email/dom.js";
import { extractDates } from "../../../extension/src/lib/textdates/index.js";

const NOW = new Date("2026-10-01T15:00:00.000Z");

/** Filename -> page URL, matching the adapter tests. Unknown names fall
 *  back to the provider's inbox list view. */
const HREFS = {
  "gmail-list.html": "https://mail.google.com/mail/u/0/#inbox",
  "gmail-message.html": "https://mail.google.com/mail/u/0/#inbox/thread-abc123",
  "outlook-list.html": "https://outlook.office.com/mail/inbox",
  "outlook-message.html": "https://outlook.office.com/mail/inbox/id/conv-out-1",
};

export default {
  source: "email",
  now: NOW,
  match: (p) => /[\\/]email[\\/][^\\/]+\.html$/i.test(p),
  /** @param {string} fixturePath @param {{now: Date, at: string, state: any}} env */
  async run(fixturePath, env) {
    const name = path.basename(fixturePath).toLowerCase();
    const gmail = name.startsWith("gmail");
    const href =
      HREFS[name] ||
      (gmail
        ? "https://mail.google.com/mail/u/0/#inbox"
        : "https://outlook.office.com/mail/inbox");
    const doc = parseHTML(fs.readFileSync(fixturePath, "utf8")).document;
    const extract = extractFor(doc, href);
    const ctx = {
      now: env.now,
      settings: {},
      state: env.state,
      courses: [],
      terms: [],
      log() {},
      textDates: extractDates,
      fetch: async () => ({ status: 0 }),
      relay: async () => ({ status: 0 }),
      parseHtml: async () => null,
    };
    const res = await adapter.observe.parse(
      {
        source: extract.provider,
        kind: /** @type {const} */ ("dom"),
        url: href,
        body: JSON.stringify(extract),
        at: env.at,
      },
      ctx,
    );
    env.state = res && res.state ? res.state : env.state;
    return res;
  },
};
