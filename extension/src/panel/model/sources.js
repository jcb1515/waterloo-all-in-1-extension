// @ts-check
/*
  Pure source-card status derivation for the Sources view — turns an adapter
  plus its sourceState entry into a status pill. No DOM, no chrome.*.
*/

import { sourceFreshness } from "./onboarding.js";

const HOUR = 3600000;

/**
 * @param {import("../../core/contract.js").Adapter} adapter
 * @param {any} st        sourceState[adapter.id] entry (may be undefined)
 * @param {"live"|"soon"} stage
 * @param {Date} now
 * @param {any} [state]  full panel state; when given, freshness comes from
 *   sourceFreshness (shared with the onboarding nudges) instead of the
 *   lastOkAt interval rule.
 * @returns {{key: string, label: string, tone: "ok"|"warn"|"danger"|"muted", detail?: string}}
 */
export function sourceStatus(adapter, st, stage, now, state) {
  if (stage === "soon") return { key: "soon", label: "Coming soon", tone: "muted" };

  const err = st && st.error;
  if (st && st.session === "signed-out") {
    return { key: "signed-out", label: "Signed out", tone: "warn", detail: "Open the site and sign back in." };
  }
  if (err) {
    if (err.code === "signed-out" || err.code === "no-tab") {
      return { key: "signed-out", label: "Signed out", tone: "warn", detail: err.message };
    }
    return { key: "error", label: "Error", tone: "danger", detail: String(err.message || err.code || "Sync failed") };
  }
  if (state !== undefined) {
    const fr = sourceFreshness(state, adapter.id, now);
    if (fr.key === "needs-visit") {
      return { key: "needs-visit", label: "Needs a visit", tone: "warn" };
    }
    if (fr.key === "fresh") {
      if (st && st.complete === false) {
        return {
          key: "connected",
          label: "Connected",
          tone: "ok",
          detail: "Last read was partial — some sections couldn't be read.",
        };
      }
      return { key: "connected", label: "Connected", tone: "ok" };
    }
    if (fr.key === "opened-nothing") {
      return {
        key: "opened-nothing",
        label: "Opened, nothing read yet",
        tone: "warn",
        detail: "You opened it, but no read landed — open the site again.",
      };
    }
    if (fr.key === "opened-waiting") {
      return {
        key: "opened-waiting",
        label: "Opened · waiting for a read",
        tone: "muted",
        detail: "You opened it recently — the read lands once the page finishes loading.",
      };
    }
    return {
      key: "never",
      label: "Not read yet · open the site",
      tone: "warn",
      detail: "Open the site once so the extension can see it.",
    };
  }
  // complete:false is NOT staleness — an adapter can report it whenever one
  // piece couldn't be read (e.g. a Learn course with no discussions tool, or
  // a passive adapter's deliberate partial result) while still having synced
  // a minute ago. Staleness is decided by the age of lastOkAt alone.
  const lastOk = st && st.lastOkAt ? Date.parse(st.lastOkAt) : NaN;
  if (Number.isNaN(lastOk)) {
    return { key: "stale", label: "Stale · open site to refresh", tone: "warn", detail: "Never synced." };
  }
  const staleAfter = adapter.intervalMinutes > 0 ? 2 * adapter.intervalMinutes * 60000 : 24 * HOUR;
  if (now.getTime() - lastOk > Math.max(staleAfter, 12 * HOUR)) {
    return { key: "stale", label: "Stale · open site to refresh", tone: "warn" };
  }
  if (st && st.complete === false) {
    return {
      key: "connected",
      label: "Connected",
      tone: "ok",
      detail: "Last read was partial — some sections couldn't be read.",
    };
  }
  return { key: "connected", label: "Connected", tone: "ok" };
}

/**
 * The Agenda attention strip: the first actively synced live source whose
 * sourceState shows an error or a signed-out session, plus the text to show.
 * Passive sources (intervalMinutes 0) stay silent — a signed-out state there
 * is normal, not a nag.
 * @param {import("../../core/contract.js").Adapter[]} adapters
 * @param {Record<string, any>} sourceState
 * @param {(id: string) => "live"|"soon"} stageFor
 * @returns {null | {adapter: import("../../core/contract.js").Adapter, st: any, text: string}}
 */
export function attentionSource(adapters, sourceState, stageFor) {
  for (const a of adapters || []) {
    if (stageFor(a.id) !== "live" || !(a.intervalMinutes > 0)) continue;
    const st = (sourceState || {})[a.id];
    if (!st || !(st.error || st.session === "signed-out")) continue;
    const text =
      st.session === "signed-out" || (st.error && st.error.code) === "signed-out"
        ? "signed out — open the site"
        : (st.error && st.error.message) || "sync error";
    return { adapter: a, st, text };
  }
  return null;
}

/**
 * Header pill for the whole store: "Needs attention" if any live source that
 * the extension actively syncs (intervalMinutes > 0) is in trouble, otherwise
 * "Synced Xm ago" from the newest lastOkAt. Passive sources — WaterlooWorks
 * reads only while you browse — are excluded from the nag: logging out there
 * constantly is normal.
 * @param {import("../../core/contract.js").Adapter[]} adapters
 * @param {Record<string, any>} sourceState
 * @param {(id: string) => "live"|"soon"} stageFor
 * @param {Date} now
 * @returns {{label: string, tone: "ok"|"warn"|"muted", short: string}}
 *   `short` is the compact pill text shown under 420 px (a status dot + it).
 */
export function storeSyncSummary(adapters, sourceState, stageFor, now) {
  let newest = -Infinity;
  let trouble = false;
  for (const a of adapters) {
    if (stageFor(a.id) !== "live") continue;
    const st = (sourceState || {})[a.id];
    if (st && st.lastOkAt) newest = Math.max(newest, Date.parse(st.lastOkAt));
    if (!(a.intervalMinutes > 0)) continue; // passive: never a "Needs attention" trigger
    const s = sourceStatus(a, st, "live", now);
    if (s.key === "error" || s.key === "signed-out") trouble = true;
  }
  if (trouble) return { label: "Needs attention", tone: "warn", short: "!" };
  if (newest === -Infinity) return { label: "Not synced yet", tone: "muted", short: "—" };
  const ago = relAgo(now.getTime() - newest);
  return {
    label: `Synced ${ago}`,
    tone: "ok",
    short: ago === "just now" ? "now" : ago.replace(/ ago$/, ""),
  };
}

/** @param {number} ms */
function relAgo(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
