// Co-op view: the next 14 days of WaterlooWorks items, interview prep cards
// with a persistent checklist, and the applications list grouped by status.

import { useMemo, useState } from "preact/hooks";
import {
  comingUp,
  groupApplications,
  groupForStatus,
  prepOf,
  checklistFor,
  appLastAt,
  coopEvents,
  GROUP_TONE,
} from "../model/coop.js";
import { STATUS_LABEL } from "../../sources/waterlooworks/status.js";
import { ItemRow } from "../components/ItemRow.jsx";
import { Checklist } from "../components/Checklist.jsx";
import { fmtAgo, fmtDay, fmtTime, fmtRange } from "../model/agenda.js";
import { orgStyle } from "../../ui/colors.js";
import {
  BriefcaseIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  MapPinIcon,
} from "../../ui/icons.jsx";

function query0(name) {
  try {
    return new URLSearchParams(location.search).get(name);
  } catch {
    return null;
  }
}

/** One interview row + expandable prep card. */
function PrepCard({ item, state, actions, now, open, onToggle }) {
  const prep = prepOf(item);
  const us = (state.userState || {})[item.id] || {};
  const tasks = checklistFor(item, us);
  const done = tasks.filter((t) => t.done).length;
  return (
    <section class="card prep-card">
      <button
        type="button"
        class="prep-head"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span class={`chev${open ? " open" : ""}`} aria-hidden="true">
          <ChevronRightIcon size={13} />
        </span>
        <span class="prep-main">
          <strong>{item.title}</strong>
          <span class="prep-sub tabular">
            {item.startAt ? `${fmtDay(item.startAt)} · ${item.endAt ? fmtRange(item.startAt, item.endAt) : fmtTime(item.startAt)}` : ""}
            {done ? ` · ${done}/${tasks.length} prepped` : ""}
          </span>
        </span>
        {item.org ? (
          <span class="chip chip-org" style={orgStyle(item.org, state.projects)}>{item.org}</span>
        ) : null}
      </button>
      {open ? (
        <div class="prep-body">
          <dl class="prep-facts">
            {prep.format ? (
              <>
                <dt>Format</dt>
                <dd>{prep.format}</dd>
              </>
            ) : null}
            {prep.location ? (
              <>
                <dt>Where</dt>
                <dd>
                  <MapPinIcon size={11} /> {prep.location}
                </dd>
              </>
            ) : null}
            {prep.interviewer ? (
              <>
                <dt>Interviewer</dt>
                <dd>{prep.interviewer}</dd>
              </>
            ) : null}
            {prep.jobId ? (
              <>
                <dt>Job</dt>
                <dd>#{prep.jobId}</dd>
              </>
            ) : null}
          </dl>
          {prep.instructions ? <p class="prep-notes">{prep.instructions}</p> : null}
          {prep.url ? (
            <button
              type="button"
              class="btn btn-sm"
              onClick={() => actions.open(prep.url)}
            >
              <ExternalLinkIcon size={12} /> Posting
            </button>
          ) : null}
          <Checklist item={item} us={us} actions={actions} />
        </div>
      ) : null}
    </section>
  );
}

/* --------------------------------- events --------------------------------- */

/** A WaterlooWorks dashboard event — pending rows take the Review verdicts. */
function EventRow({ item, state, actions, pending }) {
  return (
    <div class="event-row">
      <div class="event-main">
        <strong>{item.title}</strong>
        <span class="event-sub tabular">
          {item.startAt ? fmtDay(item.startAt) : ""}
          {item.endAt ? ` · ${fmtRange(item.startAt, item.endAt)}` : ""}
          {item.location ? ` · ${item.location}` : ""}
        </span>
      </div>
      {item.org ? (
        <span class="chip chip-org" style={orgStyle(item.org, state.projects)}>{item.org}</span>
      ) : null}
      {pending ? (
        <span class="event-acts">
          <button
            type="button"
            class="btn btn-sm"
            onClick={() => actions.setUserState(item.id, { review: "accepted" })}
          >
            Add
          </button>
          <button
            type="button"
            class="btn btn-sm btn-ghost"
            onClick={() => actions.setUserState(item.id, { review: "dismissed" })}
          >
            Dismiss
          </button>
        </span>
      ) : (
        <span class="badge badge-ok">
          {item.meta?.registered === true ? "Registered" : "Added"}
        </span>
      )}
    </div>
  );
}

/* ------------------------------ applications ------------------------------ */

function AppCard({ app, state, actions, now }) {
  const [open, setOpen] = useState(false);
  const g = groupForStatus(app.status);
  const last = appLastAt(app);
  const linked = (app.itemIds || [])
    .map((id) => state.items[id])
    .filter(Boolean);
  return (
    <section class="card app-card">
      <div class="app-head">
        <span class="chip chip-org" style={orgStyle(app.employer, state.projects)}>{app.employer}</span>
        <div class="app-main">
          <strong>{app.jobTitle || "Untitled posting"}</strong>
          <span class="app-sub tabular">
            {app.jobId ? `#${app.jobId}` : ""}
            {app.jobId && app.cycle ? " · " : ""}
            {app.cycle || ""}
          </span>
        </div>
        <span class={`badge badge-${GROUP_TONE[g] || "muted"}`}>
          {STATUS_LABEL[app.status] || app.status}
        </span>
      </div>
      <div class="app-foot">
        {Number.isNaN(last) ? null : (
          <span class="app-updated">Updated {fmtAgo(new Date(last).toISOString(), now)}</span>
        )}
        {app.url ? (
          <button type="button" class="btn-icon" aria-label="Open posting" onClick={() => actions.open(app.url)}>
            <ExternalLinkIcon size={13} />
          </button>
        ) : null}
        {Array.isArray(app.history) && app.history.length ? (
          <button
            type="button"
            class="linklike"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            History
          </button>
        ) : null}
      </div>
      {open && app.history ? (
        <ol class="app-history">
          {[...app.history].reverse().map((h, i) => (
            <li key={i} class="tabular">
              <span>{STATUS_LABEL[h.status] || h.status}</span>
              <span>{fmtDay(h.at)}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {linked.length ? (
        <div class="app-linked">
          {linked.map((it) => (
            <ItemRow key={it.id} item={it} now={now} actions={actions} projects={state.projects} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/**
 * @param {{state: any, actions: any, now: Date}} props
 */
export function Coop({ state, actions, now }) {
  const [group, setGroup] = useState("all");
  const [openPrep, setOpenPrep] = useState(() => query0("prep") || null);

  const soon = useMemo(
    () => comingUp(state.items, state.userState, now, 14, {
      acceptPending: !!(state.settings && state.settings.review && state.settings.review.showPending),
    }),
    [state.items, state.userState, state.settings, now]
  );
  const interviews = soon.filter((it) => it.type === "interview");
  const events = useMemo(
    () => coopEvents(state.items, state.userState, now),
    [state.items, state.userState, now]
  );
  const groups = useMemo(() => groupApplications(state.applications), [state.applications]);
  const shown = (groups.find((g) => g.key === group) || groups[0]).apps;

  const empty = !soon.length && !Object.keys(state.applications || {}).length;

  return (
    <div class="coop">
      {empty ? (
        <div class="card empty-card">
          <BriefcaseIcon size={20} />
          <h3>No co-op data yet</h3>
          <p class="help">
            Browse WaterlooWorks (Applications and Interviews pages) to load your
            co-op search here — nothing is sent anywhere.
          </p>
        </div>
      ) : null}

      {soon.length ? (
        <section class="agenda-group">
          <h3 class="coop-h">Coming up</h3>
          <div class="card row-card" role="list">
            {soon.map((it) => (
              <ItemRow key={it.id} item={it} now={now} actions={actions} projects={state.projects} />
            ))}
          </div>
        </section>
      ) : null}

      {interviews.length ? (
        <section class="agenda-group">
          <h3 class="coop-h">Interview prep</h3>
          {interviews.map((it) => (
            <PrepCard
              key={it.id}
              item={it}
              state={state}
              actions={actions}
              now={now}
              open={openPrep === it.id}
              onToggle={() => setOpenPrep((cur) => (cur === it.id ? null : it.id))}
            />
          ))}
        </section>
      ) : null}

      {events.pending.length || events.registered.length ? (
        <section class="agenda-group">
          <h3 class="coop-h">Events</h3>
          <div class="card row-card" role="list">
            {events.pending.map((it) => (
              <EventRow
                key={it.id}
                item={it}
                state={state}
                actions={actions}
                pending={true}
              />
            ))}
            {events.registered.map((it) => (
              <EventRow
                key={it.id}
                item={it}
                state={state}
                actions={actions}
                pending={false}
              />
            ))}
          </div>
        </section>
      ) : null}

      {Object.keys(state.applications || {}).length ? (
        <section class="agenda-group">
          <h3 class="coop-h">Applications</h3>
          <div class="chip-scroll" role="group" aria-label="Application status filter">
            {groups.map((g) => (
              <button
                key={g.key}
                type="button"
                class={`chip filter-chip${group === g.key ? " active" : ""}`}
                aria-pressed={group === g.key}
                onClick={() => setGroup(g.key)}
              >
                {g.label} {g.apps.length}
              </button>
            ))}
          </div>
          {shown.map((app) => (
            <AppCard key={app.id} app={app} state={state} actions={actions} now={now} />
          ))}
          {!shown.length ? <p class="help">Nothing in this group.</p> : null}
        </section>
      ) : null}
    </div>
  );
}
