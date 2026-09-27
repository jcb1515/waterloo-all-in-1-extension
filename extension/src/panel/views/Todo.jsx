// To-do tab: a quick-add task box, filter chips and the grouped to-do list.
// Rows are source items (deadlines, replies, co-op actions) plus the derived
// to-dos — auto rows carry an "Auto" badge explaining what finishes them.

import { useMemo, useState } from "preact/hooks";
import { buildTodos, doneLine, dueLabel } from "../model/todo.js";
import { parseQuickAdd, manualItemFrom } from "../../core/quickadd.js";
import { GroupHeader } from "../components/GroupHeader.jsx";
import { orgStyle } from "../../ui/colors.js";
import { CheckIcon, PlusIcon, SparklesIcon } from "../../ui/icons.jsx";
import { fmtDay, fmtTime } from "../model/agenda.js";

const FILTERS = [
  ["all", "All"],
  ["school", "School"],
  ["coop", "Co-op"],
  ["teams", "Teams"],
  ["projects", "Projects"],
  ["replies", "Replies"],
  ["mine", "Mine"],
];

/** Timed types keep a startAt anchor; every other quick-add anchors on dueAt. */
const TIMED_TYPES = new Set(["exam", "meeting", "interview", "event", "class", "tutorial"]);

/** One to-do row: checkbox, title, org chip, auto badge, due/done line. */
function TodoRow({ row, now, actions }) {
  const { item } = row;
  const style = orgStyle(item.org) || {};
  const open = () => {
    if (actions.openItem) actions.openItem(item);
    else if (item.url) actions.open(item.url);
  };
  return (
    <div
      class={`item-row${row.done ? " dimmed" : ""} linked`}
      style={{ "--org": style["--org"] || "var(--border-strong)", ...style }}
      role="link"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
    >
      <span class="org-bar" aria-hidden="true" />
      <button
        type="button"
        class={`check${row.done ? " on" : ""}`}
        aria-label={row.done ? "Mark not done" : "Mark done"}
        aria-pressed={row.done}
        onClick={(e) => {
          e.stopPropagation();
          actions.toggleDone(item);
        }}
      >
        <CheckIcon size={14} />
      </button>
      <span class="item-main">
        <span class="item-title">{item.title}</span>
        <span class="item-meta">
          {item.org ? <span class="chip chip-org">{item.org}</span> : null}
          {row.auto ? (
            <span class="badge badge-auto" title={row.auto}>
              <SparklesIcon size={10} /> Auto
            </span>
          ) : null}
          {row.subtasks ? (
            <span class="badge badge-muted tabular">{row.subtasks} subtask{row.subtasks === 1 ? "" : "s"}</span>
          ) : null}
          {item.meta && item.meta.auto === "study" && item.meta.leadDays != null ? (
            <span class="item-type">{item.meta.leadDays}d head start</span>
          ) : null}
        </span>
      </span>
      <span class="item-right tabular">
        {row.done ? (
          <span class="item-status ok">{doneLine(row, now)}</span>
        ) : (
          <span class={row.anchorMs != null && row.anchorMs < now.getTime() ? "item-late" : "item-countdown"}>
            {dueLabel(row, now)}
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * @param {{state: any, actions: any, now: Date, orgs?: string[]}} props
 */
export function Todo({ state, actions, now, orgs = [] }) {
  const [filter, setFilter] = useState("all");
  const [collapsed, setCollapsed] = useState(/** @type {Record<string, boolean>} */ ({}));
  const [draft, setDraft] = useState("");

  const model = useMemo(
    () =>
      buildTodos({
        items: state.items || {},
        todos: state.todos || {},
        applications: state.applications || {},
        userState: state.userState || {},
        settings: state.settings || {},
        now,
        filter,
      }),
    [state.items, state.todos, state.applications, state.userState, state.settings, now, filter]
  );

  const addTask = () => {
    const text = draft.trim();
    if (!text) return;
    const p = parseQuickAdd(text, { now, orgs });
    // Default to task; a type keyword ("quiz …") may still set another type.
    const type = TIMED_TYPES.has(p.type) && !p.startAt ? "task" : p.type || "task";
    actions.manualUpsert(
      manualItemFrom({
        title: p.title,
        org: p.org,
        type,
        dueAt: p.dueAt,
        startAt: p.startAt,
        endAt: p.endAt,
        allDay: p.allDay,
        location: p.location,
      })
    );
    setDraft("");
  };

  const toggle = (id) => setCollapsed((c) => ({ ...c, [id]: !(c[id] ?? (id === "done")) }));

  return (
    <div class="todo-view">
      <form
        class="todo-add"
        onSubmit={(e) => {
          e.preventDefault();
          addTask();
        }}
      >
        <input
          class="input"
          value={draft}
          onInput={(e) => setDraft(/** @type {any} */ (e.target).value)}
          placeholder={'Add a task — e.g. "review lab notes Thursday"'}
          aria-label="Add a task"
        />
        <button type="submit" class="btn btn-primary" disabled={!draft.trim()}>
          <PlusIcon size={14} /> Add
        </button>
      </form>

      <div class="chip-scroll todo-filters" role="tablist" aria-label="To-do filters">
        {FILTERS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            class={`chip filter-chip${filter === id ? " active" : ""}`}
            aria-pressed={filter === id}
            onClick={() => setFilter(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {model.startingSoon.length ? (
        <p class="help todo-starting">
          Starting soon:{" "}
          {model.startingSoon
            .map((t) => `${t.title} (opens ${fmtDay(t.opensAt)})`)
            .join(" · ")}
        </p>
      ) : null}

      {model.groups.length ? (
        model.groups.map((g) => {
          const isCollapsed = collapsed[g.id] ?? !!g.collapsedByDefault;
          return (
            <section class="agenda-group" key={g.id}>
              <GroupHeader
                label={g.label}
                count={g.rows.length}
                tone={g.tone}
                collapsed={isCollapsed}
                onToggle={() => toggle(g.id)}
              />
              {isCollapsed ? null : (
                <div class="agenda-rows">
                  {g.rows.map((r) => (
                    <TodoRow key={r.item.id} row={r} now={now} actions={actions} />
                  ))}
                </div>
              )}
            </section>
          );
        })
      ) : (
        <div class="card empty-card">
          <h3>Nothing to do</h3>
          <p class="help">
            Deadlines, quizzes, replies and auto-created study prep land here. Add a task above.
          </p>
        </div>
      )}
      <p class="help todo-foot">
        Auto rows check themselves off — a study to-do appears days before its assessment and
        clears once it passes.
      </p>
    </div>
  );
}
