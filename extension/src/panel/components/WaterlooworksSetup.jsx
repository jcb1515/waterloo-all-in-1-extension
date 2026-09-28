// @ts-check
// WaterlooWorks-specific setup blocks, mounted by setup/pages.jsx inside
// W1's Sources page frame (which owns the Enabled toggle and sync controls).

import { Toggle } from "../../ui/bits.jsx";

/**
 * The in-tab refresh switch: writes
 * `settings.sources.waterlooworks.autoRefresh`. Absent means on — only
 * `false` disables the hidden-iframe refresh rounds.
 * @param {{state: any, actions: any}} p
 */
export function WaterlooworksRefreshToggle({ state, actions }) {
  const src =
    (state.settings &&
      state.settings.sources &&
      state.settings.sources.waterlooworks) ||
    {};
  return (
    <div class="src-sub">
      <Toggle
        checked={src.autoRefresh !== false}
        label="Refresh WaterlooWorks automatically"
        onChange={(v) =>
          actions.saveSettings({
            sources: { waterlooworks: { ...src, autoRefresh: v } },
          })
        }
      />
      <p class="help">
        While a WaterlooWorks tab is open, re-read your dashboard, interviews
        and every page of applications in the background (at most every 30
        minutes). Turn off if WaterlooWorks changes and something looks wrong.
      </p>
    </div>
  );
}
