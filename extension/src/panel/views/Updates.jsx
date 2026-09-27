// Updates view: the merged change feed (new / moved / cancelled / status /
// review), grouped by day, newest first. Opening it stamps updatesSeenAt.

import { useEffect, useMemo, useState } from "preact/hooks";
import { fmtAgo, fmtDay, fmtTime, startOfDay } from "../model/agenda.js";
import {
  BellIcon,
  SparklesIcon,
  ArrowRightIcon,
  XIcon,
  FlagIcon,
  ClipboardCheckIcon,
  ExternalLinkIcon,
} from "../../ui/icons.jsx";

const KIND_ICON = {
  new: SparklesIcon,
  moved: ArrowRightIcon,
  cancelled: XIcon,
  removed: XIcon,
  status: FlagIcon,
  review: ClipboardCheckIcon,
};

/** One update row. */
function UpdateRow({ update, item, now, onOpenItem }) {
  const Icon = KIND_ICON[update.kind] || BellIcon;
  // A moved update strikes the old date next to the new one.
  const moved =
    update.kind === "moved" && item && item.moved && item.moved.from
      ? { from: item.moved.from, to: item.dueAt || item.startAt }
      : null;
  return (
    <div class="update-row" role="listitem">
      <span class="update-icon" aria-hidden="true">
        <Icon size={15} />
      </span>
      <span class="update-main">
        <span class="update-text">{update.text}</span>
        {moved && moved.to ? (
          <span class="update-moved tabular">
            <s>{fmtDay(moved.from)} {fmtTime(moved.from)}</s>
            {" → "}
            {fmtDay(moved.to)} {fmtTime(moved.to)}
          </span>
        ) : null}
      </span>
      <span class="update-side">
        <span class="update-time">{fmtAgo(update.at, now)}</span>
        {item && (item.url || (item.evidence && item.evidence.url)) ? (
          <button
            type="button"
            class="btn-icon"
            aria-label="Open item"
            onClick={() => onOpenItem(item)}
          >
            <ExternalLinkIcon size={13} />
          </button>
        ) : null}
      </span>
    </div>
  );
}

/**
 * @param {{state: any, actions: any, now: Date, onGoAgenda: () => void}} props
 */
export function Updates({ state, actions, now, onGoAgenda }) {
  const updates = Array.isArray(state.updates) ? state.updates : [];
  const [confirmClear, setConfirmClear] = useState(false);

  // Viewing marks everything read.
  useEffect(() => {
    actions.markUpdatesSeen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const groups = useMemo(() => {
    /** @type {Map<string, any[]>} */
    const byDay = new Map();
    for (const u of updates) {
      const key = new Date(startOfDay(new Date(u.at)).getTime()).toDateString();
      const list = byDay.get(key) || [];
      list.push(u);
      byDay.set(key, list);
    }
    return [...byDay.entries()].map(([day, rows]) => ({ day, rows }));
  }, [updates]);

  const onOpenItem = (item) => {
    const url = item.url || (item.evidence && item.evidence.url);
    if (url) actions.open(url);
    else onGoAgenda();
  };

  return (
    <div class="updates">
      {!updates.length ? (
        <div class="card empty-card">
          <BellIcon size={20} />
          <h3>No updates yet</h3>
          <p class="help">New deadlines, moved dates and status changes show up here.</p>
        </div>
      ) : (
        <>
          <div class="updates-bar">
            <button
              type="button"
              class="linklike danger"
              onClick={() => (confirmClear ? (actions.clearUpdates(), setConfirmClear(false)) : setConfirmClear(true))}
            >
              {confirmClear ? "Clear the feed — sure?" : "Clear all"}
            </button>
            {confirmClear ? (
              <button type="button" class="linklike" onClick={() => setConfirmClear(false)}>
                Cancel
              </button>
            ) : null}
          </div>
          {groups.map((g) => (
            <section class="update-day" key={g.day}>
              <h3 class="update-day-label">{fmtDay(new Date(g.day))}</h3>
              <div class="card row-card" role="list">
                {g.rows.map((u) => (
                  <UpdateRow
                    key={u.id}
                    update={u}
                    item={u.refId ? state.items[u.refId] : null}
                    now={now}
                    onOpenItem={onOpenItem}
                  />
                ))}
              </div>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
