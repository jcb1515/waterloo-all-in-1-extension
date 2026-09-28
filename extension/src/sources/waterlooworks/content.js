// @ts-check
// WaterlooWorks content script — DOM snapshotter (T3) plus the in-tab refresh
// trigger (T4). Isolated world. The snapshot builder and the hidden-iframe
// refresh round live in refresh.js (bundled into this script); this file owns
// only the trigger wiring: hash-deduped sends, the throttled refresh kick and
// the check-now handler.
// No requests and no navigation of THIS page; parsers.js does the parsing.
import {
  buildSnapshot,
  checkCount,
  checkNowRound,
  maybeRefresh,
  refreshGate,
} from "./refresh.js";
import { isLoggedOut } from "./parsers.js";

const MY_ACCOUNT_RE =
  /^https:\/\/waterlooworks\.uwaterloo\.ca\/myAccount\//;

(() => {
  // --- double-injection guard -------------------------------------------
  // The background re-injects content scripts into open tabs after an
  // install/update/startup. Each injection gets its own chrome binding —
  // capture this context's so liveness checks its OWN context: after an
  // unload, reading the zombie's runtime.id throws.
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
  const prev = /** @type {any} */ (globalThis).__wa1WwContent;
  /** @type {any} */
  const inst = {
    alive,
    dead: false,
    observer: null,
    /** @type {Set<any>} */
    timers: new Set(),
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
    },
  };
  if (prev && typeof prev.alive === "function" && prev.alive()) return;
  globalThis.__wa1WwContent = inst;
  try {
    prev?.stop?.();
  } catch {
    /* best-effort cleanup */
  }
  if (!alive()) {
    // This context is itself already orphaned — nothing here can work.
    inst.stop();
    return;
  }

  const loadedAt = Date.now();
  /** @type {string|null} */
  let lastHash = null;
  let scheduled = false;

  // Small string hash so we only send when the snapshot actually changed.
  const hashOf = (text) => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16);
  };

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

  const send = () => {
    if (inst.dead) return;
    try {
      const complete =
        document.readyState === "complete" && Date.now() - loadedAt >= 3000;
      const snapshot = buildSnapshot(document, complete);
      if (!snapshot) return;
      const hash = hashOf(snapshot);
      if (hash === lastHash) return;
      lastHash = hash;
      // Mirror of MSG.OBSERVED — the literal keeps this script dependency-free
      // of the background's message registry.
      post({
        type: "wa1:observed",
        payload: {
          source: "waterlooworks",
          kind: "dom",
          url: location.href,
          body: snapshot,
          at: new Date().toISOString(),
        },
      });
    } catch {
      if (!alive()) inst.stop();
    }
  };

  /** @param {() => void} fn @param {number} ms */
  const delay = (fn, ms) => {
    const t = setTimeout(() => {
      inst.timers.delete(t);
      if (!inst.dead) fn();
    }, ms);
    inst.timers.add(t);
    return t;
  };

  // --- check-now -----------------------------------------------------------
  // Registered before the /myAccount/ bail below: the background retries in
  // a fresh tab on {accepted:false, reason:"not-on-page"}, so every WW page
  // — not just /myAccount/ ones — must answer.
  const checkDone = (runId, extra) =>
    post({
      type: "wa1:check-done",
      source: "waterlooworks",
      runId,
      ...extra,
    });

  const runCheck = async (runId) => {
    try {
      const gate = await refreshGate();
      if (gate !== "ok") {
        // Kill switch or a broken storage read — accepted but not read.
        checkDone(runId, { ok: false, reason: gate });
        return;
      }
      // The top page's own snapshot goes out again — a forced read bypasses
      // the unchanged-snapshot dedupe, not the kill switch or the allowlist.
      lastHash = null;
      send();
      const out = await checkNowRound();
      checkDone(runId, {
        ok: out.ok,
        checked: (out.checked || 0) + checkCount(document),
        ...(out.reason ? { reason: out.reason } : {}),
      });
    } catch {
      checkDone(runId, { ok: false, reason: "error" });
    }
  };

  const onCheckMessage = (msg, _sender, reply) => {
    if (
      !msg ||
      msg.type !== "wa1:check-now" ||
      msg.source !== "waterlooworks"
    ) {
      return;
    }
    // An orphaned context answers nothing and never starts a round.
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
      // A signed-out page still accepts: there is nothing to retry, so the
      // failure is reported on check-done instead of accepted:false.
      if (isLoggedOut(document, String(location.href || ""))) {
        accept({ accepted: true });
        checkDone(msg.runId, { ok: false, reason: "signed-out" });
        return;
      }
      if (!MY_ACCOUNT_RE.test(String(location.href || ""))) {
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
    ext?.runtime?.onMessage?.addListener?.(onCheckMessage);
  } catch {
    inst.stop();
    return;
  }

  // Any /myAccount/ page — grids, dashboard, messages, rankings, job/interview
  // details all live under it. Other WW pages only answer check-now.
  if (!MY_ACCOUNT_RE.test(String(location.href || ""))) {
    return;
  }

  const schedule = () => {
    if (scheduled || inst.dead) return;
    scheduled = true;
    delay(() => {
      scheduled = false;
      send();
    }, 2000); // throttled: Vue re-renders in bursts
  };

  send();
  window.addEventListener("load", send);
  // A page that finishes rendering before the 3 s completeness mark may never
  // mutate again — resend once shortly after the mark so a complete=1
  // snapshot lands even on a static page (hash dedupe still applies). Once
  // the page has settled, kick the throttled iframe refresh round too: it
  // self-gates on visibility, the 30 min per-tab throttle and the click
  // allowlist.
  const resendAfterSettled = () => {
    delay(() => {
      send();
      maybeRefresh();
    }, Math.max(0, loadedAt + 3000 - Date.now()) + 100);
  };
  window.addEventListener("load", resendAfterSettled);
  if (document.readyState === "complete") resendAfterSettled();
  inst.observer = new MutationObserver(schedule);
  inst.observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
})();
