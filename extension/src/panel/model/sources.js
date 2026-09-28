// @ts-check
/*
  Pure source-card status derivation for the Sources view — turns an adapter
  plus its sourceState entry into a status pill. No DOM, no chrome.*.
*/

import { sourceEnabled, sourceFreshness } from "./onboarding.js";
import { siteUrlFor } from "../../core/sites.js";
import { sourceLabel } from "../../ui/sourceLabel.js";
import { CHECK_TIMEOUT_MS } from "../../core/messages.js";

const HOUR = 3600000;
const SYNC_ON_OPEN_MAX_AGE = 30 * 60000;

/**
 * The site URL a source's "Open site" affordance should open. Accepts an
 * Adapter or a SourceId ("gmail" resolves to the gmail checklist row even
 * though the email adapter is "outlook"): the first https checklist-row
 * url wins, else the adapter's first origin.
 * @param {import("../../core/contract.js").Adapter | string} adapterOrSource
 * @returns {string|null}
 */
export function sourceSiteUrl(adapterOrSource) {
  const adapter = typeof adapterOrSource === "string" ? null : adapterOrSource;
  const sourceId = adapter ? adapter.id : String(adapterOrSource || "");
  const url = siteUrlFor(sourceId);
  if (url) return url;
  const origins = (adapter && adapter.origins) || [];
  return origins[0] ? `${origins[0]}/` : null;
}

/**
 * The URL a Sources.jsx "Open"/"Open site" affordance targets: the row's
 * own https checklist url when it names a specific page (the WW interviews
 * row must open the interviews page, not the first row's), else
 * siteUrlFor(source).
 * @param {string} sourceId @param {any} [row] CheckRow
 * @returns {string|null}
 */
export function openTargetFor(sourceId, row) {
  const url = row && row.url;
  if (typeof url === "string" && url.startsWith("https://")) return url;
  return siteUrlFor(sourceId);
}

/**
 * Should the panel ask for a sync of `source` once it opens? Fetch-type
 * sources (gcal) have no page-open trigger of their own, so a stale or
 * never-run source gets one `UI.SYNC` nudge per panel open. Disabled
 * sources never nudge.
 * @param {any} state  merged panel state ({settings, sourceState})
 * @param {string} source
 * @param {Date|number} now
 * @param {number} [maxAgeMs]
 */
export function shouldSyncOnOpen(state, source, now, maxAgeMs = SYNC_ON_OPEN_MAX_AGE) {
  if (!sourceEnabled(state && state.settings, source)) return false;
  const st = ((state && state.sourceState) || {})[source];
  const last = st && st.lastRunAt ? Date.parse(st.lastRunAt) : NaN;
  if (Number.isNaN(last)) return true;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  return nowMs - last > maxAgeMs;
}

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

/* ------------------------- check-now view ------------------------- */

/**
 * The CheckNowButton's view model over the `checkRuns` storage key. A
 * "running" entry older than CHECK_TIMEOUT_MS is reported as a timeout —
 * the run's service worker may have died mid-check.
 * @param {any} state  merged panel state ({checkRuns, settings})
 * @param {string} source  SourceId
 * @param {Date|number} now
 * @returns {{status: "idle"|"running"|"ok"|"failed"|"disabled"|"unsupported",
 *   reason?: string, text: string, openUrl?: string|null}}
 */
export function checkRunView(state, source, now) {
  if (!sourceEnabled(state && state.settings, source)) {
    return { status: "disabled", text: "Turned off" };
  }
  const run = (((state && state.checkRuns) || {})[source]) || null;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const label = sourceLabel(source, null);
  if (!run || !run.status) return { status: "idle", text: "" };
  const startedMs = Date.parse(run.startedAt || "");
  if (run.status === "running") {
    if (Number.isFinite(startedMs) && nowMs - startedMs > CHECK_TIMEOUT_MS) {
      return { status: "failed", reason: "timeout", text: "Didn't finish — try again" };
    }
    return { status: "running", text: "Checking…" };
  }
  if (run.status === "ok") {
    const parts = [`Checked${run.checked != null ? ` ${run.checked}` : ""}`];
    parts.push(
      run.newItems == null || run.newItems === 0 ? "no new items" : `${run.newItems} new`,
    );
    const ago = relAgo(nowMs - Date.parse(run.endedAt || run.startedAt || ""));
    if (ago) parts.push(ago);
    return { status: "ok", text: parts.join(" · ") };
  }
  const reason = run.reason || "error";
  if (reason === "signed-out") {
    return {
      status: "failed",
      reason,
      text: `Signed out of ${label} — `,
      openUrl: siteUrlFor(source),
    };
  }
  if (reason === "not-on-page") {
    if (source === "discord") {
      return {
        status: "failed",
        reason,
        text: "Open a watched Discord channel, then check again",
        openUrl: null,
      };
    }
    return {
      status: "failed",
      reason,
      text: `Open ${label} to check`,
      openUrl: siteUrlFor(source),
    };
  }
  if (reason === "timeout") {
    return { status: "failed", reason, text: "Didn't finish — try again" };
  }
  if (reason === "disabled") return { status: "disabled", text: "Turned off" };
  if (reason === "unsupported") {
    return { status: "unsupported", reason, text: "No check for this source" };
  }
  return { status: "failed", reason, text: "Couldn't check — try again" };
}
