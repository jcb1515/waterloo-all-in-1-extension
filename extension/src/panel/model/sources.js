// @ts-check
/*
  Pure source-card status derivation for the Sources view — turns an adapter
  plus its sourceState entry into a status pill. No DOM, no chrome.*.
*/

const HOUR = 3600000;

/**
 * @param {import("../../core/contract.js").Adapter} adapter
 * @param {any} st        sourceState[adapter.id] entry (may be undefined)
 * @param {"live"|"soon"} stage
 * @param {Date} now
 * @returns {{key: string, label: string, tone: "ok"|"warn"|"danger"|"muted", detail?: string}}
 */
export function sourceStatus(adapter, st, stage, now) {
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
  if (st && st.complete === false) {
    return { key: "stale", label: "Stale · open site to refresh", tone: "warn" };
  }
  const lastOk = st && st.lastOkAt ? Date.parse(st.lastOkAt) : NaN;
  if (Number.isNaN(lastOk)) {
    return { key: "stale", label: "Stale · open site to refresh", tone: "warn", detail: "Never synced." };
  }
  const staleAfter = adapter.intervalMinutes > 0 ? 2 * adapter.intervalMinutes * 60000 : 24 * HOUR;
  if (now.getTime() - lastOk > Math.max(staleAfter, 12 * HOUR)) {
    return { key: "stale", label: "Stale · open site to refresh", tone: "warn" };
  }
  return { key: "connected", label: "Connected", tone: "ok" };
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
  if (trouble) return { label: "Needs attention", tone: "warn" };
  if (newest === -Infinity) return { label: "Not synced yet", tone: "muted" };
  return { label: `Synced ${relAgo(now.getTime() - newest)}`, tone: "ok" };
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
