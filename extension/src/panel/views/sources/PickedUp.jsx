// @ts-check
// Sources > Picked up segment: every item this source contributed (its
// source or any seenIn entry — review-pending included), grouped by type
// with upcoming vs earlier splits. Grouping lives in model/pickedUp.js.

import { useMemo } from "preact/hooks";
import { pickedUpGroups } from "../../model/pickedUp.js";
import { sourceSiteUrl } from "../../model/sources.js";
import { adapterForSource } from "../../../core/registry.js";
import { ItemRow } from "../../../ui/ItemRow.jsx";
import { Section } from "../../../ui/Section.jsx";
import { EmptyState } from "../../../ui/EmptyState.jsx";
import { SearchIcon, ExternalLinkIcon } from "../../../ui/icons.jsx";

/**
 * @param {{sourceId: string, state: any, actions: any, now: Date}} props
 */
export function PickedUp({ sourceId, state, actions, now }) {
  const groups = useMemo(
    () => pickedUpGroups(state.items || {}, sourceId, now),
    [state.items, sourceId, now]
  );

  // Effective pending: the item is review-pending and the user's verdict
  // (Add/Dismiss in Review or Co-op Events) hasn't overridden it.
  /** @param {any} item */
  const isPending = (item) =>
    item.review === "pending" &&
    !["accepted", "dismissed"].includes(
      ((state.userState || {})[item.id] || {}).review
    );

  /** @param {any[]} list */
  const rows = (list) =>
    list.map((item) => (
      <div key={item.id}>
        {isPending(item) ? (
          <p class="help">
            <span class="badge badge-warn">Not added</span>
          </p>
        ) : null}
        <ItemRow item={item} now={now} actions={actions} projects={state.projects} />
      </div>
    ));

  /** @param {any[]} list */
  const earlier = (list) =>
    list.length ? (
      <details>
        <summary>Earlier ({list.length})</summary>
        <div class="card row-card" role="list">
          {rows(list)}
        </div>
      </details>
    ) : null;

  if (!groups.length) {
    const adapter = adapterForSource(sourceId);
    const site = adapter ? sourceSiteUrl(adapter) : null;
    return (
      <EmptyState
        icon={SearchIcon}
        title="Nothing picked up yet"
        text="Items this source finds show up here — open the site to let it read."
      >
        {site ? (
          <button type="button" class="btn btn-sm" onClick={() => actions.open(site)}>
            <ExternalLinkIcon size={13} /> Open site
          </button>
        ) : null}
      </EmptyState>
    );
  }

  return (
    <div class="sources-list">
      {groups.map((g) =>
        g.collapsed ? (
          <Section key={g.key}>
            <details>
              <summary>
                {g.label} ({g.count})
              </summary>
              {g.upcoming.length ? (
                <div class="card row-card" role="list">
                  {rows(g.upcoming)}
                </div>
              ) : null}
              {earlier(g.earlier)}
            </details>
          </Section>
        ) : (
          <Section key={g.key} title={`${g.label} (${g.count})`}>
            {g.upcoming.length ? (
              <div class="card row-card" role="list">
                {rows(g.upcoming)}
              </div>
            ) : null}
            {earlier(g.earlier)}
          </Section>
        )
      )}
    </div>
  );
}
