// @ts-check
// PLACEHOLDER — owned by W3 (stream/coop). Replace freely.
//
// Contract (see coordination/w1.md):
//   export function Check({sourceId, state, actions, now})
// Renders in the Sources source-page "Check" segment. This minimal version
// links out to the full Check readers overlay for per-page diagnostics.

import { EmptyState } from "../../../ui/EmptyState.jsx";
import { ClipboardCheckIcon } from "../../../ui/icons.jsx";

/**
 * @param {{sourceId: string, state: any, actions: any, now: Date}} props
 */
export function Check({ sourceId, state, actions }) {
  const st = (state.sourceState || {})[sourceId] || null;
  const probes = st && st.probes ? Object.keys(st.probes).length : 0;
  return (
    <EmptyState
      icon={ClipboardCheckIcon}
      title={probes ? `${probes} page${probes === 1 ? "" : "s"} read so far` : "No page reads yet"}
      text="Check readers shows what this source has seen on each page — counts only."
    >
      <button type="button" class="btn btn-sm" onClick={() => actions.openCheckReaders()}>
        Open Check readers
      </button>
    </EmptyState>
  );
}
