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
// Check-now honours the same rules: a forced read re-reads only what is
// already rendered — nothing scrolls, clicks, navigates or requests.

import { MSG } from "../../core/contract.js";
import {
  readLocation,
  inventoryExtract,
  readMessages,
  eventsModalExtract,
} from "./dom.js";
import { hashString } from "../../capture/redact.js";
import { guardInstance } from "../../capture/guard.js";

// Same literal as core/store.js SETTINGS_KEY — the content bundle stays free
// of core imports.
const SETTINGS_KEY = "wa1Settings";

(() => {
  // No early return on the path: Discord is an SPA — it loads on /app,
  // /login, etc. and navigates client-side. The observer stays up and
  // tick() bails whenever readLocation sees a non-/channels/ URL.
  const THROTTLE_MS = 3000;
  /** A read counts as "settled" once the document finished loading and at
   * least 3 s have passed since navigation start — React's first paint has
   * landed by then, so a settled extract reflects the real channel/events
   * state rather than a half-rendered frame. */
  const SETTLE_MS = 3000;
  const settled = () =>
    document.readyState === "complete" && performance.now() >= SETTLE_MS;
  const SEEN_CAP = 2000;

  // --- double-injection guard -------------------------------------------
  // The background re-injects content scripts into open tabs after an
  // install/update/startup — and the new copy can share this world's
  // chrome object, so runtime.id on the old copy is not a reliable
  // liveness probe. guardInstance runs the DOM-event ping/pong/supersede
  // handshake instead: a live owner pongs and this copy bails; otherwise
  // this copy supersedes and the old one runs teardown() = inst.stop().
  // Each injection still captures its own chrome binding for the orphan
  // self-stop on a failed send (a zombie context's runtime.id throws).
  const ext = (() => {
    try {
      return chrome;
    } catch {
      return null;
    }
  })();
  const alive = () => {
    try {
      return !!ext?.runtime?.id;
    } catch {
      return false;
    }
  };
  /** @type {any} */
  const inst = {
    dead: false,
    observer: null,
    /** @type {Set<any>} */
    timers: new Set(),
    /** @type {any} */ onMessage: null,
    stop() {
      this.dead = true;
      try {
        this.observer?.disconnect?.();
      } catch {
        /* best-effort cleanup */
      }
      for (const t of this.timers) {
        try {
          clearTimeout(t);
        } catch {
          /* best-effort cleanup */
        }
      }
      this.timers.clear();
      try {
        ext?.runtime?.onMessage?.removeListener?.(this.onMessage);
      } catch {
        /* best-effort cleanup */
      }
      this.onMessage = null;
    },
  };
  if (!guardInstance("discord-content", () => inst.stop())) return;
  if (!alive()) {
    // This context is itself already orphaned — nothing here can work.
    inst.stop();
    return;
  }

  /** @type {string|null} */
  let lastInventoryHash = null;
  /** @type {string|null} */
  let lastEventsHash = null;
  /** messageId:contentHash pairs already sent (oldest dropped at cap). */
  const seenMessages = new Set();
  let scheduled = false;

  /**
   * sendMessage that folds "Extension context invalidated" into an orphan
   * self-stop: a dead context stops sending, disconnects its observer and
   * clears its timers instead of throwing into the page.
   * @param {any} msg
   */
  const post = (msg) => {
    try {
      ext?.runtime?.sendMessage?.(msg);
    } catch {
      if (!alive()) inst.stop();
    }
  };

  const send = (extract) => {
    if (inst.dead) return;
    post({
      type: MSG.OBSERVED,
      payload: {
        source: "discord",
        kind: "dom",
        url: location.href,
        body: JSON.stringify(extract),
        at: new Date().toISOString(),
      },
    });
  };

  /**
   * Read what's rendered and send whatever changed. A `force` read (panel
   * check-now) bypasses the inventory/events hash dedupe and the
   * seen-messages set, so every visible message and card is re-sent once —
   * and counts as settled whenever the document finished loading (the
   * normal 3 s settle mark does not apply to a user-requested read).
   * @param {boolean} [force]
   * @returns {number} visible messages + event cards read this tick
   */
  const tick = (force = false) => {
    let checked = 0;
    try {
      if (inst.dead) return 0;
      const loc = readLocation(location.href);
      if (!loc) return 0;
      const settledNow = force
        ? document.readyState === "complete"
        : settled();

      // Scheduled events arrive over the gateway — the network recorder
      // never sees them — so the Events modal is read straight from the
      // DOM whenever one is open (list view = "N Events", detail view =
      // "Event Info" tab). TODO(events): markup is best-guess, see dom.js.
      const ev = eventsModalExtract(document, location.href);
      if (ev) {
        checked += Array.isArray(ev.cards) ? ev.cards.length : 0;
        ev.settled = settledNow;
        // settled flips the hash once (false -> true), re-sending the same
        // extract so the adapter can mark the read complete; dedupe then
        // suppresses further repeats.
        const evHash = hashString(
          JSON.stringify([ev.cards, ev.settled])
        );
        if (force || evHash !== lastEventsHash) {
          lastEventsHash = evHash;
          send(ev);
        }
      }

      // DM views: report where we are, never what's said.
      if (loc.guildId === "@me") {
        send({ v: 1, type: "location", location: loc });
        return checked;
      }

      // Guild page: inventory (guild rail + channel sidebar) when changed.
      const inv = inventoryExtract(document, location.href);
      inv.settled = settledNow;
      const invHash = hashString(
        JSON.stringify([inv.guilds, inv.channels, inv.settled])
      );
      if (force || invHash !== lastInventoryHash) {
        lastInventoryHash = invHash;
        send(inv);
      }

      // New/edited messages in the open channel — all of them on force.
      const fresh = [];
      for (const m of readMessages(document)) {
        checked += 1;
        const key = `${m.messageId}:${hashString(m.content || "")}`;
        const seen = seenMessages.has(key);
        if (!seen) {
          if (seenMessages.size >= SEEN_CAP) {
            seenMessages.delete(seenMessages.values().next().value);
          }
          seenMessages.add(key);
        }
        if (force || !seen) fresh.push(m);
      }
      if (fresh.length) {
        send({ v: 1, type: "messages", location: loc, messages: fresh });
      }
    } catch {
      // Discord's DOM is hostile territory — a miss must stay silent.
      if (!alive()) inst.stop();
    }
    return checked;
  };

  // --- check-now -----------------------------------------------------------
  const checkDone = (runId, extra) =>
    post({
      type: "wa1:check-done",
      source: "discord",
      runId,
      ...extra,
    });

  /** @returns {Promise<"ok"|"disabled"|"error">} */
  const sourceGate = async () => {
    try {
      const got = /** @type {any} */ (
        await ext?.storage?.local?.get?.(SETTINGS_KEY)
      );
      const src = got?.[SETTINGS_KEY]?.sources?.discord;
      return src && src.enabled === false ? "disabled" : "ok";
    } catch {
      return "error";
    }
  };

  const runCheck = async (runId) => {
    try {
      const gate = await sourceGate();
      if (gate !== "ok") {
        checkDone(runId, { ok: false, reason: gate });
        return;
      }
      const checked = tick(true);
      checkDone(runId, { ok: true, checked });
    } catch {
      checkDone(runId, { ok: false, reason: "error" });
    }
  };

  const onCheckMessage = (msg, _sender, reply) => {
    if (!msg || msg.type !== "wa1:check-now" || msg.source !== "discord") {
      return;
    }
    // An orphaned context answers nothing and never reads.
    if (inst.dead || !alive()) {
      try {
        inst.stop();
      } catch {
        /* best-effort cleanup */
      }
      return;
    }
    /** @param {any} v */
    const accept = (v) => {
      try {
        if (typeof reply === "function") reply(v);
      } catch {
        /* reply channel gone */
      }
    };
    try {
      // A forced read has something to work with only on a guild channel —
      // or anywhere while an Events modal is open, since the modal carries
      // its own guild context. DM and non-/channels/ pages stay unread.
      const loc = readLocation(String(location.href || ""));
      const onGuild = Boolean(loc && loc.guildId !== "@me");
      const modalOpen = Boolean(
        eventsModalExtract(document, String(location.href || ""))
      );
      if (!onGuild && !modalOpen) {
        accept({ accepted: false, reason: "not-on-page" });
        return;
      }
      accept({ accepted: true });
      void runCheck(msg.runId);
    } catch {
      accept({ accepted: false, reason: "error" });
    }
  };
  try {
    inst.onMessage = onCheckMessage;
    ext?.runtime?.onMessage?.addListener?.(onCheckMessage);
  } catch {
    inst.stop();
    return;
  }

  const schedule = () => {
    if (scheduled || inst.dead) return;
    scheduled = true;
    const t = setTimeout(() => {
      inst.timers.delete(t);
      scheduled = false;
      if (!inst.dead) tick();
    }, THROTTLE_MS);
    inst.timers.add(t);
  };

  tick();
  inst.observer = new MutationObserver(schedule);
  inst.observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
})();
