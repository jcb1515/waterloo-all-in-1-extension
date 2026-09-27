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
  GROUP_TONE,
} from "../model/coop.js";
import { STATUS_LABEL } from "../../sources/waterlooworks/status.js";
import { ItemRow } from "../components/ItemRow.jsx";
import { fmtAgo, fmtDay, fmtTime, fmtRange } from "../model/agenda.js";
import { orgStyle } from "../../ui/colors.js";
import {
  BriefcaseIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  MapPinIcon,
  PlusIcon,
  XIcon,
} from "../../ui/icons.jsx";

function query0(name) {
  try {
    return new URLSearchParams(location.search).get(name);
  } catch {
    return null;
  }
}

/* ------------------------------ prep checklist ------------------------------ */

/** Editable checklist bound to userState[item.id].subtasks. */
function Checklist({ item, us, actions }) {
  const tasks = checklistFor(item, us);
  const [draft, setDraft] = useState("");
  const persist = (list) => actions.setUserState(item.id, { subtasks: list });
  return (
    <ul class="prep-check" aria-label="Prep checklist">
      {tasks.map((t, i) => (
        <li key={`${t.text}-${i}`}>
          <label>
            <input
              type="checkbox"
              checked={t.done}
              onChange={() =>
                persist(tasks.map((x, j) => (j === i ? { ...x, done: !x.done } : x)))
              }
            />
            <span class={t.done ? "done" : ""}>{t.text}</span>
          </label>
          <button
            type="button"
            class="btn-icon prep-del"
            aria-label={`Remove "${t.text}"`}
            onClick={() => persist(tasks.filter((_, j) => j !== i))}
          >
            <XIcon size={12} />
          </button>
        </li>
      ))}
      <li>
        <input
          class="input prep-add"
          type="text"
          placeholder="Add a step…"
          value={draft}
          aria-label="Add a checklist step"
          onInput={(e) => setDraft(/** @type {any} */ (e.target).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) {
              persist([...tasks, { text: draft.trim(), done: false }]);
              setDraft("");
            }
          }}
        />
        <button
          type="button"
          class="btn-icon"
          aria-label="Add step"
          onClick={() => {
            if (draft.trim()) {
              persist([...tasks, { text: draft.trim(), done: false }]);
              setDraft("");
            }
          }}
        >
          <PlusIcon size={13} />
        </button>
      </li>
    </ul>
  );
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
          <span class="chip chip-org" style={orgStyle(item.org)}>{item.org}</span>
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
        <span class="chip chip-org" style={orgStyle(app.employer)}>{app.employer}</span>
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
            <ItemRow key={it.id} item={it} now={now} actions={actions} />
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
              <ItemRow key={it.id} item={it} now={now} actions={actions} />
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
