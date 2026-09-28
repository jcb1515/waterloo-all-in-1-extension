// "Get set up" card and "Needs a visit" nudges — both render the pure
// model output from panel/model/onboarding.js. A source page is opened
// only inside a click handler (the caller's onOpen); nothing navigates
// automatically.

import { CheckIcon } from "./icons.jsx";
import { sourceLabel } from "./sourceLabel.js";

/**
 * First-run checklist. `rows` = onboardingRows(state, now) — already
 * filtered to the surface's scope by the caller. Shows nothing with no
 * rows; the caller also hides it when every row is done or the card was
 * dismissed (userState.onboardingDismissedAt).
 * @param {{rows: Array<{source: string, row: any, done: boolean,
 *   lastOkAt: string|null}>, onOpen: (url: string) => void,
 *   onDismiss?: () => void}} p
 */
export function OnboardingCard({ rows, onOpen, onDismiss }) {
  if (!rows || !rows.length) return null;
  const done = rows.filter((r) => r.done).length;
  return (
    <section class="card onboard-card" aria-label="Get set up">
      <div class="onboard-head">
        <h3 class="onboard-title">Get set up · {done} of {rows.length}</h3>
        {onDismiss ? (
          <button type="button" class="linklike onboard-dismiss" onClick={onDismiss}>
            Dismiss
          </button>
        ) : null}
      </div>
      <ul class="onboard-list">
        {rows.map(({ source, row, done }) => (
          <li key={`${source}:${row.id}`} class="onboard-row">
            <span class="onboard-text">
              <span class="onboard-label">{row.label}</span>
              {row.how ? <span class="onboard-how">{row.how}</span> : null}
            </span>
            {done ? (
              <span class="onboard-done" role="img" aria-label="Done" title="Done">
                <CheckIcon size={15} />
              </span>
            ) : row.url ? (
              <button
                type="button"
                class="btn btn-sm onboard-open"
                onClick={() => onOpen(row.url)}
              >
                Open
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * "Needs a visit" stale-read nudges. `limit` caps the list (Upcoming shows
 * at most 2; a source page's Check segment shows all of that source's).
 * @param {{nudges: Array<{source: string, row: any, lastOkAt: string,
 *   ageDays: number}>, limit?: number, onOpen: (url: string) => void,
 *   onSnooze: (key: string) => void}} p
 */
export function NudgeCard({ nudges, limit, onOpen, onSnooze }) {
  const list = (nudges || []).slice(0, limit || (nudges || []).length || 0);
  if (!list.length) return null;
  return (
    <section class="card nudge-card" aria-label="Needs a visit">
      <h3 class="nudge-title">Needs a visit</h3>
      <ul class="nudge-list">
        {list.map((n) => {
          const days = Math.floor(n.ageDays);
          return (
            <li key={`${n.source}:${n.row.id}`} class="nudge-row">
              <span class="nudge-text">
                <span class="nudge-name">{nudgeLabel(n)}</span>
                <span class="nudge-when"> — last checked {days} day{days === 1 ? "" : "s"} ago</span>
              </span>
              <span class="nudge-actions">
                {n.row.url ? (
                  <button type="button" class="linklike" onClick={() => onOpen(n.row.url)}>
                    Open
                  </button>
                ) : null}
                <button
                  type="button"
                  class="linklike"
                  onClick={() => onSnooze(`${n.source}:${n.row.id}`)}
                >
                  Snooze
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** "Portal exam schedule" — source name + row label minus the "Your ". */
function nudgeLabel(n) {
  const label = String(n.row.label || "").replace(/^your\s+/i, "");
  return `${sourceLabel(n.source, null)} ${label}`.trim();
}
