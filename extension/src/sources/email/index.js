// @ts-check
/*
  Email adapter — passive observe only (T3). OWA needs a tokened API we never
  captured and Gmail was likewise structural-only, so there are no net
  urlPatterns at all; everything arrives as a serialised DOM extract from
  content.js. "outlook" and "gmail" payloads both land here (the registry maps
  them to this adapter id).
*/

import { extractDates, termCodeFor } from "../../lib/textdates/index.js";
import { itemsFromMessage } from "./extract.js";

/** @typedef {import("../../core/contract.js").SyncContext} SyncContext */
/** @typedef {import("../../core/contract.js").SyncResult} SyncResult */

/** @type {import("../../core/contract.js").Adapter} */
const adapter = {
  id: "outlook",
  label: "Email (Outlook + Gmail)",
  origins: [
    "https://outlook.office.com",
    "https://outlook.cloud.microsoft",
    "https://outlook.live.com",
    "https://mail.google.com",
  ],
  intervalMinutes: 0,
  syncOnTabOpen: false,

  /** No fetch tier — mail APIs need auth we never hold. */
  async sync() {
    return { items: [], complete: false, session: "no-tab" };
  },

  observe: {
    urlPatterns: [],
    /**
     * @param {import("../../core/contract.js").ObservedPayload} payload
     * @param {SyncContext} ctx
     * @returns {Promise<SyncResult & {scope: string}>}
     */
    async parse(payload, ctx) {
      const provider = payload.source === "gmail" ? "gmail" : "outlook";
      const prev = ctx.state && typeof ctx.state === "object" ? ctx.state : {};
      const settings = ctx.settings || {};

      if (settings[provider] === false) {
        return { items: [], complete: false, scope: "email:off", state: prev };
      }
      /** @type {any} */
      let data;
      try {
        data = JSON.parse(String(payload.body || ""));
      } catch {
        return { items: [], complete: false, scope: "email:none", state: prev };
      }
      if (!data || !Array.isArray(data.messages)) {
        return { items: [], complete: false, scope: "email:none", state: prev };
      }

      // Folder filter: a known folder outside the allow-list yields nothing;
      // a null folder is allowed.
      const folders = settings.folders || ["inbox"];
      const folder = data.folder == null ? null : String(data.folder).toLowerCase();
      const allowed =
        folder == null || (Array.isArray(folders) && folders.some((f) => String(f).toLowerCase() === folder));

      const now = ctx.now || new Date();
      const at = payload.at || now.toISOString();
      /** @type {import("../../core/contract.js").Item[]} */
      const items = [];
      const msgs = data.messages.filter((m) => m && m.key);
      if (allowed) {
        for (const m of msgs) {
          items.push(
            ...itemsFromMessage(m, {
              provider,
              now,
              termCode: termCodeFor(now),
              textDates: ctx.textDates || extractDates,
              courses: ctx.courses || [],
              settings,
              at,
            }),
          );
        }
      }

      // A single message view scopes narrowly so that message's items are
      // replaced; a list view's scope matches no item, so nothing is removed.
      const keys = new Set(msgs.map((m) => String(m.key)));
      const scope =
        allowed && data.view === "message" && keys.size === 1
          ? `email:${provider}:${[...keys][0]}`
          : `email:${provider}:list`;

      const state = {
        lastSeenAt: at,
        counts: { ...(prev.counts || {}), [provider]: msgs.length },
      };
      return {
        items,
        complete: true,
        readOk: [scope],
        scope,
        session: "signed-in",
        state,
      };
    },
  },
};

export default adapter;
