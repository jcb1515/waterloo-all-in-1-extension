// Projects tab: user projects — a segmented card list with progress, a
// detail view (editable header, quick-add row, grouped items, status
// actions) and a new-project form. Project records persist via
// wa1:project-upsert/delete; their items are ordinary manual items.

import { useMemo, useState } from "preact/hooks";
import { projectItemList, projectProgress } from "../../core/projects.js";
import { parseQuickAdd, manualItemFrom } from "../../core/quickadd.js";
import { orgStyle } from "../../ui/colors.js";
import { fmtDay } from "../model/agenda.js";
import { GroupHeader } from "../components/GroupHeader.jsx";
import { ItemRow } from "../components/ItemRow.jsx";
import {
  ArrowLeftIcon,
  CalendarIcon,
  CheckIcon,
  FlagIcon,
  PlusIcon,
  TrashIcon,
} from "../../ui/icons.jsx";
import { query } from "../data.js";

const DAY = 86400000;
const SEGMENTS = [
  ["active", "Active"],
  ["done", "Done"],
  ["archived", "Archived"],
];
const ADD_TYPES = [
  ["task", "Task"],
  ["deadline", "Milestone"],
  ["meeting", "Meeting"],
];
const pad = (n) => String(n).padStart(2, "0");
const toDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** "in 12 days" / "Tomorrow" / "3 days late" — day-granular countdown. */
function dueCountdown(dueAt, now) {
  const ms = Date.parse(dueAt);
  if (Number.isNaN(ms)) return null;
  const days = Math.round((ms - now.getTime()) / DAY);
  if (days <= -2) return `${-days} days late`;
  if (days === -1) return "Yesterday";
  if (days <= 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `in ${days} days`;
}

/** The 8-swatch colour picker — sets `org-N` via a CSS var. */
function Swatches({ value, onPick, size = 22 }) {
  return (
    <div class="proj-swatches" role="radiogroup" aria-label="Project colour">
      {Array.from({ length: 8 }, (_, i) => (
        <button
          key={i}
          type="button"
          class={`proj-swatch${value === i ? " on" : ""}`}
          style={{ background: `var(--org-${i})`, width: size, height: size }}
          aria-label={`Colour ${i + 1}`}
          aria-checked={value === i}
          role="radio"
          onClick={() => onPick(i)}
        />
      ))}
    </div>
  );
}

/* ------------------------------- new form ------------------------------- */

function NewProjectForm({ actions, onDone }) {
  const [f, setF] = useState({
    name: "",
    color: 0,
    date: "",
    time: "",
    allDay: true,
    description: "",
    calendar: true,
  });
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const create = () => {
    const name = f.name.trim();
    if (!name) return;
    /** @type {any} */
    const p = {
      name,
      color: f.color,
      calendar: f.calendar,
      status: "active",
    };
    if (f.description.trim()) p.description = f.description.trim();
    if (f.date) {
      p.dueAt = new Date(
        f.allDay ? `${f.date}T23:59` : `${f.date}T${f.time || "09:00"}`
      ).toISOString();
      if (f.allDay) p.allDay = true;
    }
    actions.projectUpsert(p);
    onDone();
  };
  return (
    <section class="card proj-form">
      <input
        class="input"
        placeholder="Project name"
        aria-label="Project name"
        value={f.name}
        onInput={(e) => set("name", /** @type {any} */ (e.target).value)}
        autoFocus
      />
      <Swatches value={f.color} onPick={(c) => set("color", c)} />
      <div class="proj-form-row">
        <input
          class="input"
          type="date"
          aria-label="Due date (optional)"
          value={f.date}
          onChange={(e) => set("date", /** @type {any} */ (e.target).value)}
        />
        {f.date && !f.allDay ? (
          <input
            class="input"
            type="time"
            aria-label="Due time"
            value={f.time}
            onChange={(e) => set("time", /** @type {any} */ (e.target).value)}
          />
        ) : null}
        {f.date ? (
          <label class="qa-allday">
            <input
              type="checkbox"
              checked={f.allDay}
              onChange={(e) => set("allDay", /** @type {any} */ (e.target).checked)}
            />
            All day
          </label>
        ) : null}
      </div>
      <textarea
        class="input"
        rows={2}
        placeholder="Description (optional)"
        aria-label="Description"
        value={f.description}
        onInput={(e) => set("description", /** @type {any} */ (e.target).value)}
      />
      <label class="switch">
        <input
          type="checkbox"
          checked={f.calendar}
          onChange={(e) => set("calendar", /** @type {any} */ (e.target).checked)}
        />
        <span class="track" aria-hidden="true" />
        <span>Add to Google Calendar</span>
      </label>
      <div class="sheet-acts">
        <button type="button" class="btn btn-primary" disabled={!f.name.trim()} onClick={create}>
          Create project
        </button>
        <button type="button" class="btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    </section>
  );
}

/* ------------------------------ list cards ------------------------------ */

function ProjectCard({ project, progress, now, onOpen }) {
  const style = orgStyle(project.name, [project]) || {};
  const cd = project.dueAt ? dueCountdown(project.dueAt, now) : null;
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <button
      type="button"
      class={`card proj-card${project.dueAt && progress.lateDays ? " late" : ""}`}
      style={style}
      onClick={onOpen}
    >
      <span class="proj-bar-top" aria-hidden="true" />
      <span class="proj-card-head">
        <strong>{project.name}</strong>
        {cd ? (
          <span class={`chip ${progress.lateDays ? "badge-warn" : "chip-org"}`}>{cd}</span>
        ) : null}
        {project.calendar !== false ? (
          <span class="proj-cal" title="Included in the calendar feed">
            <CalendarIcon size={13} />
          </span>
        ) : null}
      </span>
      {progress.total ? (
        <span class="proj-progress">
          <span class="proj-track" aria-hidden="true">
            <i style={{ width: `${pct}%` }} />
          </span>
          <span class="proj-count tabular">
            {progress.done}/{progress.total} done
          </span>
        </span>
      ) : null}
      {progress.next ? (
        <span class="proj-next help">
          Next: {progress.next.title}
          {progress.nextAt ? ` · ${fmtDay(progress.nextAt)}` : ""}
        </span>
      ) : null}
    </button>
  );
}

/* -------------------------------- detail -------------------------------- */

function ProjectDetail({ project, state, actions, now, onBack }) {
  const items = useMemo(
    () => projectItemList(state.items, project.id),
    [state.items, project.id]
  );
  const [draft, setDraft] = useState("");
  const [addType, setAddType] = useState("task");
  const [confirmDone, setConfirmDone] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [collapsed, setCollapsed] = useState(/** @type {Record<string, boolean>} */ ({}));
  const [name, setName] = useState(project.name);
  const [desc, setDesc] = useState(project.description || "");

  const us = state.userState || {};
  const open = items.filter((i) => {
    const u = us[i.id] || {};
    return !(u.done || i.status === "done" || i.status === "submitted");
  });
  const patch = (p) => actions.projectUpsert({ ...project, ...p });
  const commitName = () => {
    const n = name.trim();
    if (n && n !== project.name) patch({ name: n });
    else setName(project.name);
  };
  const commitDesc = () => {
    if (desc.trim() !== (project.description || "")) patch({ description: desc.trim() });
  };

  const addItem = () => {
    const text = draft.trim();
    if (!text) return;
    const p = parseQuickAdd(text, { now, orgs: [] });
    actions.manualUpsert(
      manualItemFrom({
        title: p.title,
        org: project.name,
        type: addType,
        dueAt: p.dueAt,
        startAt: p.startAt,
        endAt: p.endAt,
        allDay: p.allDay,
        location: p.location,
        meta: { projectId: project.id },
      })
    );
    setDraft("");
  };

  // Groups: overdue, upcoming, undated, done.
  const groups = useMemo(() => {
    /** @type {Record<string, any[]>} */
    const g = { overdue: [], upcoming: [], nodate: [], done: [] };
    for (const it of items) {
      const u = us[it.id] || {};
      const done = !!(u.done || it.status === "done" || it.status === "submitted");
      const a = it.dueAt || it.startAt;
      const ms = a ? Date.parse(a) : NaN;
      if (done) g.done.push(it);
      else if (Number.isNaN(ms)) g.nodate.push(it);
      else if (ms < now.getTime()) g.overdue.push(it);
      else g.upcoming.push(it);
    }
    const byAnchor = (a, b) =>
      Date.parse(a.dueAt || a.startAt || "") - Date.parse(b.dueAt || b.startAt || "");
    g.overdue.sort(byAnchor);
    g.upcoming.sort(byAnchor);
    g.done.sort(byAnchor);
    return [
      ["overdue", "Overdue", "danger", false],
      ["upcoming", "Upcoming", null, false],
      ["nodate", "No date", null, false],
      ["done", "Done", null, true],
    ]
      .map(([id, label, tone, collapsed]) => ({ id, label, tone, collapsed, rows: g[id] }))
      .filter((gr) => gr.rows.length);
  }, [items, us, now]);

  const markDone = (checkOff) => {
    if (checkOff) {
      const at = new Date().toISOString();
      for (const it of open) actions.setUserState(it.id, { done: true, doneAt: at });
    }
    patch({ status: "done" });
    setConfirmDone(false);
  };

  return (
    <div class="proj-detail">
      <div class="proj-detail-head" style={orgStyle(project.name, [project]) || {}}>
        <button type="button" class="btn-icon" aria-label="Back to projects" onClick={onBack}>
          <ArrowLeftIcon size={16} />
        </button>
        <input
          class="input proj-name-input"
          value={name}
          aria-label="Project name"
          onInput={(e) => setName(/** @type {any} */ (e.target).value)}
          onBlur={commitName}
          onKeyDown={(e) => e.key === "Enter" && commitName()}
        />
      </div>

      <section class="card proj-form">
        <Swatches
          value={project.color || 0}
          onPick={(c) => patch({ color: c })}
        />
        <div class="proj-form-row">
          <input
            class="input"
            type="date"
            aria-label="Due date"
            value={project.dueAt ? toDate(new Date(project.dueAt)) : ""}
            onChange={(e) => {
              const v = /** @type {any} */ (e.target).value;
              if (!v) patch({ dueAt: null });
              else
                patch({
                  dueAt: new Date(
                    project.allDay !== false ? `${v}T23:59` : `${v}T09:00`
                  ).toISOString(),
                });
            }}
          />
          {project.dueAt ? (
            <span class={`chip ${projectProgress(project, state.items, us, now).lateDays ? "badge-warn" : "chip-org"}`}>
              {dueCountdown(project.dueAt, now)}
            </span>
          ) : null}
        </div>
        <textarea
          class="input"
          rows={2}
          placeholder="Description (optional)"
          aria-label="Description"
          value={desc}
          onInput={(e) => setDesc(/** @type {any} */ (e.target).value)}
          onBlur={commitDesc}
        />
        <label class="switch">
          <input
            type="checkbox"
            checked={project.calendar !== false}
            onChange={(e) => patch({ calendar: /** @type {any} */ (e.target).checked })}
          />
          <span class="track" aria-hidden="true" />
          <span>Add to Google Calendar</span>
        </label>
      </section>

      <form
        class="todo-add"
        onSubmit={(e) => {
          e.preventDefault();
          addItem();
        }}
      >
        <div class="segmented proj-add-types" role="group" aria-label="Item type">
          {ADD_TYPES.map(([v, l]) => (
            <button
              key={v}
              type="button"
              class={addType === v ? "active" : ""}
              aria-pressed={addType === v}
              onClick={() => setAddType(v)}
            >
              {l}
            </button>
          ))}
        </div>
        <input
          class="input"
          value={draft}
          onInput={(e) => setDraft(/** @type {any} */ (e.target).value)}
          placeholder={`Add to ${project.name} — e.g. "poster due Friday"`}
          aria-label={`Add to ${project.name}`}
        />
        <button type="submit" class="btn btn-primary" disabled={!draft.trim()}>
          <PlusIcon size={14} /> Add
        </button>
      </form>

      {groups.map((g) => {
        const isCollapsed = collapsed[g.id] ?? g.collapsed;
        return (
        <section class="agenda-group" key={g.id}>
          <GroupHeader
            label={g.label}
            count={g.rows.length}
            tone={g.tone}
            collapsed={isCollapsed}
            onToggle={() => setCollapsed((c) => ({ ...c, [g.id]: !isCollapsed }))}
          />
          {isCollapsed ? null : (
            <div class="card row-card" role="list">
              {g.rows.map((it) => (
                <ItemRow
                  key={it.id}
                  item={it}
                  now={now}
                  actions={actions}
                  done={g.id === "done"}
                  projects={state.projects}
                />
              ))}
            </div>
          )}
        </section>
        );
      })}
      {!groups.length ? (
        <p class="help">Nothing here yet — add a task or milestone above.</p>
      ) : null}

      <section class="card proj-actions">
        {confirmDone ? (
          <>
            <p class="help">
              {open.length
                ? `Check off the ${open.length} open item${open.length === 1 ? "" : "s"} too?`
                : "Mark this project done?"}
            </p>
            <div class="sheet-acts">
              {open.length ? (
                <button type="button" class="btn" onClick={() => markDone(true)}>
                  Done + check off items
                </button>
              ) : null}
              <button type="button" class="btn btn-primary" onClick={() => markDone(false)}>
                {open.length ? "Just the project" : "Mark done"}
              </button>
              <button type="button" class="btn" onClick={() => setConfirmDone(false)}>
                Cancel
              </button>
            </div>
          </>
        ) : confirmDel ? (
          <>
            <p class="help">
              Delete {project.name} and its {items.length} item{items.length === 1 ? "" : "s"}?
            </p>
            <div class="sheet-acts">
              <button
                type="button"
                class="btn btn-danger"
                onClick={() => {
                  actions.projectDelete(project.id);
                  onBack();
                }}
              >
                <TrashIcon size={13} /> Delete project
              </button>
              <button type="button" class="btn" onClick={() => setConfirmDel(false)}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <div class="sheet-acts">
            {project.status === "active" ? (
              <button type="button" class="btn" onClick={() => setConfirmDone(true)}>
                <CheckIcon size={13} /> Mark project done
              </button>
            ) : (
              <button
                type="button"
                class="btn"
                onClick={() => patch({ status: "active" })}
              >
                {project.status === "done" ? "Reopen" : "Unarchive"}
              </button>
            )}
            {project.status !== "archived" ? (
              <button type="button" class="btn" onClick={() => patch({ status: "archived" })}>
                Archive
              </button>
            ) : null}
            <button type="button" class="btn" onClick={() => setConfirmDel(true)}>
              <TrashIcon size={13} /> Delete
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

/* --------------------------------- view --------------------------------- */

/**
 * @param {{state: any, actions: any, now: Date}} props
 */
export function Projects({ state, actions, now }) {
  const projects = Array.isArray(state.projects) ? state.projects : [];
  const [seg, setSeg] = useState("active");
  const [showForm, setShowForm] = useState(() => query.get("newproject") === "1");
  const [selId, setSelId] = useState(() => query.get("project"));

  const sel = selId ? projects.find((p) => p && p.id === selId) || null : null;
  if (sel) {
    return (
      <ProjectDetail
        project={sel}
        state={state}
        actions={actions}
        now={now}
        onBack={() => setSelId(null)}
      />
    );
  }

  const shown = projects.filter((p) => (p.status || "active") === seg);
  return (
    <div class="proj-view">
      <div class="proj-toolbar">
        <div class="segmented" role="tablist" aria-label="Project status">
          {SEGMENTS.map(([id, label]) => {
            const n = projects.filter((p) => (p.status || "active") === id).length;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={seg === id}
                onClick={() => setSeg(id)}
              >
                {label}
                {n ? ` (${n})` : ""}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          class="btn btn-primary"
          onClick={() => setShowForm((v) => !v)}
        >
          <PlusIcon size={14} /> New project
        </button>
      </div>

      {showForm ? <NewProjectForm actions={actions} onDone={() => setShowForm(false)} /> : null}

      {shown.length ? (
        shown.map((p) => (
          <ProjectCard
            key={p.id}
            project={p}
            progress={projectProgress(p, state.items, state.userState || {}, now)}
            now={now}
            onOpen={() => setSelId(p.id)}
          />
        ))
      ) : (
        <div class="card empty-card">
          <FlagIcon size={20} />
          <h3>No {seg} projects</h3>
          <p class="help">
            Make a project for anything with a deadline — a hackathon, a design-team build,
            job applications, a personal goal.
          </p>
        </div>
      )}
    </div>
  );
}
