// Sources view: one status card per adapter, with sync/open/clear actions and
// a footer link to the privacy & discovery settings.

import { useMemo } from "preact/hooks";
import { ADAPTERS, stageForAdapter } from "../../core/registry.js";
import { sourceStatus } from "../model/sources.js";
import { fmtAgo } from "../model/agenda.js";
import { IS_PREVIEW } from "../data.js";
import { RefreshIcon, ExternalLinkIcon, TrashIcon, ShieldIcon } from "../../ui/icons.jsx";

const TONE_BADGE = { ok: "badge-ok", warn: "badge-warn", danger: "badge-danger", muted: "badge-muted" };

/** Monogram from a label: "Course outlines" -> "Co", "WaterlooWorks" -> "Wa". */
function monogram(label) {
  const words = String(label).replace(/\(.*\)/, "").trim().split(/\s+/);
  const first = words[0] || "?";
  const second = words.length > 1 ? words[1] : first.slice(1);
  return (first[0] + (second[0] || "")).toUpperCase();
}

/**
 * @param {{state: any, actions: any, now: Date}} props
 */
export function Sources({ state, actions, now }) {
  const cards = useMemo(
    () =>
      ADAPTERS.map((a) => {
        const stage = stageForAdapter(a.id);
        const st = (state.sourceState || {})[a.id] || null;
        return { adapter: a, stage, st, status: sourceStatus(a, st, stage, now) };
      }),
    [state.sourceState]
  );

  const openPrivacy = () => {
    const url = IS_PREVIEW
      ? "/src/options/options.html#privacy"
      : chrome.runtime.getURL("src/options/options.html#privacy");
    try {
      if (!IS_PREVIEW && chrome.tabs) {
        chrome.tabs.create({ url });
        return;
      }
    } catch {
      /* fall through to location */
    }
    window.open(url, "_blank");
  };

  return (
    <div class="sources-list">
      {cards.map(({ adapter, stage, st, status }) => (
        <section class="card source-card" key={adapter.id}>
          <div class="source-head">
            <span class="mono-tile" aria-hidden="true">
              {monogram(adapter.label)}
            </span>
            <div class="source-title">
              <h3>{adapter.label}</h3>
              {st || stage !== "soon" ? (
                <span class="source-meta tabular">
                  {st && st.lastOkAt
                    ? `Synced ${fmtAgo(st.lastOkAt, now)}`
                    : st && st.lastRunAt
                      ? `Tried ${fmtAgo(st.lastRunAt, now)}`
                      : "Not synced yet"}
                  {st && typeof st.itemCount === "number" && st.itemCount > 0
                    ? ` · ${st.itemCount} items`
                    : ""}
                </span>
              ) : null}
            </div>
            <span class={`badge ${TONE_BADGE[status.tone]}`}>{status.label}</span>
          </div>
          {status.detail ? <p class="source-detail">{status.detail}</p> : null}
          {!(adapter.intervalMinutes > 0) ? (
            <p class="source-detail">Updates while you browse {adapter.label}.</p>
          ) : null}
          <div class="source-actions">
            {stage === "live" && adapter.sync && adapter.intervalMinutes > 0 ? (
              <button
                type="button"
                class="btn btn-sm"
                onClick={() => actions.sync(adapter.id)}
              >
                <RefreshIcon size={13} /> Sync now
              </button>
            ) : null}
            {adapter.origins && adapter.origins[0] ? (
              <button
                type="button"
                class="btn btn-sm"
                onClick={() => actions.open(`${adapter.origins[0]}/`)}
              >
                <ExternalLinkIcon size={13} /> Open site
              </button>
            ) : null}
            {st ? (
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                onClick={() => {
                  if (window.confirm(`Clear all ${adapter.label} data stored on this computer?`)) {
                    actions.clearSource(adapter.id);
                  }
                }}
              >
                <TrashIcon size={13} /> Clear data
              </button>
            ) : null}
          </div>
        </section>
      ))}
      <button type="button" class="btn btn-ghost sources-privacy" onClick={openPrivacy}>
        <ShieldIcon size={14} /> Privacy &amp; discovery settings
      </button>
    </div>
  );
}
