// @ts-check
// PLACEHOLDER — owned by W3 (stream/coop). Replace freely.
//
// Contract (see coordination/w1.md):
//   export function PickedUp({sourceId, state, actions, now})
// Renders in the Sources source-page "Picked up" segment. This minimal
// version lists the items the source contributed (source or seenIn match).

import { useMemo } from "preact/hooks";
import { ItemRow } from "../../../ui/ItemRow.jsx";
import { EmptyState } from "../../../ui/EmptyState.jsx";
import { SearchIcon } from "../../../ui/icons.jsx";

/**
 * @param {{sourceId: string, state: any, actions: any, now: Date}} props
 */
export function PickedUp({ sourceId, state, actions, now }) {
  const rows = useMemo(() => {
    const hits = [];
    for (const it of Object.values(state.items || {})) {
      if (!it) continue;
      const sources = [it.source, ...(Array.isArray(it.seenIn) ? it.seenIn.map((s) => (s && s.source) || s) : [])];
      if (sources.includes(sourceId)) hits.push(it);
    }
    const ms = (it) => Date.parse(it.startAt || it.dueAt || "") || 0;
    hits.sort((a, b) => ms(b) - ms(a));
    return hits;
  }, [state.items, sourceId]);

  if (!rows.length) {
    return (
      <EmptyState
        icon={SearchIcon}
        title="Nothing picked up yet"
        text="Items this source finds show up here."
      />
    );
  }

  return (
    <div class="card row-card" role="list">
      {rows.slice(0, 40).map((item) => (
        <ItemRow key={item.id} item={item} now={now} actions={actions} projects={state.projects} />
      ))}
      {rows.length > 40 ? <p class="help">…and {rows.length - 40} more</p> : null}
    </div>
  );
}
