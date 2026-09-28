// Teams tab: one card per watched design-team Discord server — next meeting,
// your assigned tasks, deadlines, pending review count, unread watched
// channels and this week's items.

import { useMemo } from "preact/hooks";
import { teamCards } from "../model/teams.js";
import { ItemRow } from "../components/ItemRow.jsx";
import { fmtDay, fmtTime, fmtRange } from "../model/agenda.js";
import { orgStyle } from "../../ui/colors.js";
import { UsersIcon, InboxIcon, MessageSquareIcon, MapPinIcon, RepeatIcon } from "../../ui/icons.jsx";

/**
 * @param {{state: any, actions: any, now: Date,
 *   onOpenReview?: (org: string) => void}} props
 */
export function Teams({ state, actions, now, onOpenReview }) {
  const { teams } = useMemo(
    () =>
      teamCards({
        items: state.items,
        userState: state.userState,
        sourceState: state.sourceState,
        settings: state.settings,
        now,
      }),
    [state.items, state.userState, state.sourceState, state.settings, now]
  );

  if (!teams.length) {
    return (
      <div class="card empty-card">
        <UsersIcon size={20} />
        <h3>No teams yet</h3>
        <p class="help">
          Pick the design-team servers to watch in Settings → Sources →
          Discord, then browse them in Edge.
        </p>
      </div>
    );
  }

  return (
    <div class="teams">
      {teams.map((t) => (
        <section class="card team-card" key={t.name}>
          <div class="team-head">
            <span class="chip chip-org" style={orgStyle(t.name, state.projects)}>{t.name}</span>
            {t.focus.map((f) => (
              <span key={f} class="chip chip-focus">{f}</span>
            ))}
          </div>

          {t.nextMeeting ? (
            <div class="team-next">
              <span class="team-label">Next meeting</span>
              <button
                type="button"
                class="linklike team-next-link"
                onClick={() => actions.openItem && actions.openItem(t.nextMeeting)}
              >
                {fmtDay(t.nextMeeting.startAt)} ·{" "}
                {t.nextMeeting.endAt
                  ? fmtRange(t.nextMeeting.startAt, t.nextMeeting.endAt)
                  : fmtTime(t.nextMeeting.startAt)}
              </button>
              {t.nextMeeting.location ? (
                <span class="team-loc">
                  <MapPinIcon size={11} /> {t.nextMeeting.location}
                </span>
              ) : null}
              {t.weekly ? (
                <span class="badge badge-muted">
                  <RepeatIcon size={10} /> weekly
                </span>
              ) : null}
            </div>
          ) : null}

          {t.tasks.length ? (
            <div class="team-section">
              <span class="team-label">Your tasks</span>
              <div class="team-rows" role="list">
                {t.tasks.map((it) => (
                  <ItemRow key={it.id} item={it} now={now} actions={actions} projects={state.projects} />
                ))}
              </div>
            </div>
          ) : null}

          {t.deadlines.length ? (
            <div class="team-section">
              <span class="team-label">Deadlines</span>
              <div class="team-rows" role="list">
                {t.deadlines.map((it) => (
                  <ItemRow key={it.id} item={it} now={now} actions={actions} projects={state.projects} />
                ))}
              </div>
            </div>
          ) : null}

          {t.pendingCount ? (
            <button
              type="button"
              class="btn btn-sm team-review"
              onClick={() => onOpenReview && onOpenReview(t.name)}
            >
              <InboxIcon size={12} /> Needs review · {t.pendingCount}
            </button>
          ) : null}

          {t.unread.length ? (
            <div class="team-section">
              <span class="team-label">New messages</span>
              {t.unread.map((c) => (
                <button
                  key={c.channelId}
                  type="button"
                  class="linklike team-unread"
                  onClick={() => actions.open(c.url)}
                >
                  <MessageSquareIcon size={11} /> #{c.name}
                  {c.mentions ? <span class="badge badge-warn">{c.mentions} ping{c.mentions === 1 ? "" : "s"}</span> : null}
                </button>
              ))}
            </div>
          ) : null}

          {t.week.length ? (
            <div class="team-section">
              <span class="team-label">This week</span>
              <div class="team-rows" role="list">
                {t.week.map((it) => (
                  <ItemRow key={it.id} item={it} now={now} actions={actions} projects={state.projects} />
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}
