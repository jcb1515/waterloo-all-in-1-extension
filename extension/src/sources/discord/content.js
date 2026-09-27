// @ts-check
// Discord content script — PASSIVE DOM reader (T3). Bundled as an IIFE by
// tools/build.mjs so imports are fine.
//
// Hard rules (README repeats them):
//   - never send a request to Discord (no fetch/XHR/web-socket),
//   - never touch tokens (no page storage, cookies or webpack modules),
//   - never navigate or click,
//   - never send DM content — /channels/@me only reports the location,
//   - message bodies travel only as transient DOM extracts to OUR OWN
//     background; they are never persisted beyond snippets.

import { MSG } from "../../core/contract.js";
import {
  readLocation,
  inventoryExtract,
  readMessages,
  eventsModalExtract,
} from "./dom.js";
import { hashString } from "../../capture/redact.js";

(() => {
  // No early return on the path: Discord is an SPA — it loads on /app,
  // /login, etc. and navigates client-side. The observer stays up and
  // tick() bails whenever readLocation sees a non-/channels/ URL.
  const THROTTLE_MS = 3000;
  const SEEN_CAP = 2000;
  /** @type {string|null} */
  let lastInventoryHash = null;
  /** @type {string|null} */
  let lastEventsHash = null;
  /** messageId:contentHash pairs already sent (oldest dropped at cap). */
  const seenMessages = new Set();
  /** @type {number|undefined} */
  let timer;

  const send = (extract) => {
    try {
      chrome.runtime.sendMessage({
        type: MSG.OBSERVED,
        payload: {
          source: "discord",
          kind: "dom",
          url: location.href,
          body: JSON.stringify(extract),
          at: new Date().toISOString(),
        },
      });
    } catch {
      // Extension reloads invalidate the context — never throw into the page.
    }
  };

  const tick = () => {
    try {
      const loc = readLocation(location.href);
      if (!loc) return;

      // Scheduled events arrive over the gateway — the network recorder
      // never sees them — so the Events modal is read straight from the
      // DOM whenever one is open (list view = "N Events", detail view =
      // "Event Info" tab). TODO(events): markup is best-guess, see dom.js.
      const ev = eventsModalExtract(document, location.href);
      if (ev) {
        const evHash = hashString(JSON.stringify(ev.cards));
        if (evHash !== lastEventsHash) {
          lastEventsHash = evHash;
          send(ev);
        }
      }

      // DM views: report where we are, never what's said.
      if (loc.guildId === "@me") {
        send({ v: 1, type: "location", location: loc });
        return;
      }

      // Guild page: inventory (guild rail + channel sidebar) when changed.
      const inv = inventoryExtract(document, location.href);
      const invHash = hashString(JSON.stringify([inv.guilds, inv.channels]));
      if (invHash !== lastInventoryHash) {
        lastInventoryHash = invHash;
        send(inv);
      }

      // New/edited messages in the open channel.
      const fresh = [];
      for (const m of readMessages(document)) {
        const key = `${m.messageId}:${hashString(m.content || "")}`;
        if (seenMessages.has(key)) continue;
        if (seenMessages.size >= SEEN_CAP) {
          seenMessages.delete(seenMessages.values().next().value);
        }
        seenMessages.add(key);
        fresh.push(m);
      }
      if (fresh.length) {
        send({ v: 1, type: "messages", location: loc, messages: fresh });
      }
    } catch {
      // Discord's DOM is hostile territory — a miss must stay silent.
    }
  };

  const schedule = () => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      tick();
    }, THROTTLE_MS);
  };

  tick();
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
})();
