// @ts-check
// Discord driver: fixture HTML through the real DOM readers — inventory,
// messages and events extracts as dom payloads, plus a synthesized REST
// channel-history net payload built from the same message rows
// (domMessageToRest), threaded through one ctx.state like the live reader.

import fs from "node:fs";
import path from "node:path";
import { parseHTML } from "linkedom";
import adapter from "../../../extension/src/sources/discord/index.js";
import {
  inventoryExtract,
  messagesExtract,
  eventsModalExtract,
} from "../../../extension/src/sources/discord/dom.js";
import { domMessageToRest } from "../../../extension/src/sources/discord/messages.js";
import { applyResult } from "../../../extension/src/core/merge.js";
import { extractDates } from "../../../extension/src/lib/textdates/index.js";

const NOW = new Date("2026-10-01T20:00:00.000Z");
const API = "https://discord.com/api/v10";
const G = "1000000000000000001"; // Robotics Club (fixture guild)
const CH = "2000000000000000002"; // pcb-design
const CH_LIST = "2000000000000000001"; // elec-general (chat-messages fixture)

/** Explicit watched set built from the fixture guild names. */
const SETTINGS = {
  watched: {
    "Robotics Club": { focus: ["electrical"] },
    "Rocket Team": {},
  },
};

export default {
  source: "discord",
  now: NOW,
  match: (p) => /[\\/]discord[\\/][^\\/]+\.html$/i.test(p),
  /** @param {string} fixturePath @param {{now: Date, at: string, state: any}} env */
  async run(fixturePath, env) {
    const name = path.basename(fixturePath).toLowerCase();
    const doc = parseHTML(fs.readFileSync(fixturePath, "utf8")).document;
    const channel = name.startsWith("chat-messages") ? CH_LIST : CH;
    const href = `https://discord.com/channels/${G}/${channel}`;
    const ctx = {
      state: env.state,
      now: env.now,
      settings: SETTINGS,
      textDates: extractDates,
      log() {},
    };

    /** @type {any[]} */
    const results = [];
    const push = async (payload) => {
      const res = await adapter.observe.parse(payload, ctx);
      ctx.state = res && res.state ? res.state : ctx.state;
      results.push(res);
    };

    await push({
      source: "discord",
      kind: /** @type {const} */ ("dom"),
      url: href,
      body: JSON.stringify(inventoryExtract(doc, href)),
      at: env.at,
    });

    if (name.startsWith("chat-messages")) {
      const msgs = messagesExtract(doc, href);
      await push({
        source: "discord",
        kind: "dom",
        url: href,
        body: JSON.stringify(msgs),
        at: env.at,
      });
      const rest = msgs.messages.map((m) =>
        domMessageToRest(m, msgs.location.channelId),
      );
      await push({
        source: "discord",
        kind: /** @type {const} */ ("net"),
        method: "GET",
        status: 200,
        url: `${API}/channels/${msgs.location.channelId}/messages?limit=50`,
        body: JSON.stringify(rest),
        at: env.at,
      });
    }

    const ev = eventsModalExtract(doc, href);
    if (ev) {
      await push({
        source: "discord",
        kind: "dom",
        url: href,
        body: JSON.stringify(ev),
        at: env.at,
      });
    }

    env.state = ctx.state;
    /** @type {any} */
    let merged = null;
    for (const r of results) {
      merged = applyResult(merged, r, {
        mode: r && r.scope ? "scope" : "sync",
        scope: r && r.scope,
      });
    }
    return { ...(merged || { items: [] }), scope: "discord" };
  },
};
