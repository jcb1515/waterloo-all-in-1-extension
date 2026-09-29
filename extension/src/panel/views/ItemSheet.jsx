// Item detail sheet: everything known about one merged item — type, times,
// facts, per-source evidence — plus the user's own layer (notes, subtasks,
// estimate, snooze, hide) persisted to userState via UI.SET_USER_STATE.

import { useRef, useState } from "preact/hooks";
import { effectiveItem } from "../../core/effective.js";
import { fmtDay, fmtTime, fmtRange, fmtAgo } from "../model/agenda.js";
import {
  SNOOZE_PRESETS,
  snoozeUntil,
  fmtEstimate,
  primaryLink,
  sourceLabel,
  sourceOpenLink,
  calendarState,
  calendarReasonText,
  removeCalendarPatch,
  todoState,
} from "../model/itemsheet.js";
import { ADAPTERS } from "../../core/registry.js";
import { Checklist } from "../components/Checklist.jsx";
import { ItemEditForm } from "../../ui/ItemEditForm.jsx";
import { typeLabelFor } from "../components/ItemRow.jsx";
import { orgStyle } from "../../ui/colors.js";
import {
  typeIcon,
  ExternalLinkIcon,
  ArrowLeftIcon,
  MapPinIcon,
  CircleDashedIcon,
  EyeOffIcon,
  CheckIcon,
  TrashIcon,
  PencilIcon,
} from "../../ui/icons.jsx";

const NO_CHECK = new Set(["class", "tutorial", "exam", "term-date"]);

const EST_CHIPS = [
  [15, "15m"],
  [30, "30m"],
  [60, "1h"],
  [120, "2h"],
  [180, "3h"],
  [300, "5h"],
];

/** "Due Fri, Oct 3 · 11:59 PM" / "Sat, Oct 4 · 6:00–7:00 PM" — sheet line. */
function whenLabel(item) {
  if (item.startAt) {
    const d = fmtDay(item.startAt);
    const t = item.allDay
      ? "All day"
      : item.endAt
        ? fmtRange(item.startAt, item.endAt)
        : fmtTime(item.startAt);
    return `${d} · ${t}`;
  }
  if (item.dueAt) {
    return `Due ${fmtDay(item.dueAt)} · ${item.allDay ? "All day" : fmtTime(item.dueAt)}`;
  }
  return null;
}

/**
 * @param {{state: any, actions: any, now: Date, itemId: string,
 *   onClose: () => void}} props
 */
export function ItemSheet({ state, actions, now, itemId, onClose }) {
  // Derived to-dos live in the separate `todos` map, not `items`.
  const raw = state.items[itemId] || (state.todos || {})[itemId];
  const us = (state.userState || {})[itemId] || {};
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editAdd, setEditAdd] = useState(false);
  const [notes, setNotes] = useState(us.notes || "");
  const notesTimer = useRef(/** @type {any} */ (null));

  if (!raw) {
    return (
      <div class="card empty-card">
        <h3>Item not found</h3>
        <p class="help">It may have been merged or removed since this view loaded.</p>
      </div>
    );
  }

  const item = effectiveItem(raw, us);
  const Icon = typeIcon(item.type);
  const link = primaryLink(item);
  const cal = calendarState(raw, us, state, now);
  const todo = todoState(raw, us, state, now);
  const calSyncOff = !(
    state.settings &&
    state.settings.calendar &&
    state.settings.calendar.enabled === true
  );
  // A derived to-do points at the source row it replaces (meta.linkedItemId).
  const linkedSrc =
    item.meta && item.meta.linkedItemId ? state.items[item.meta.linkedItemId] || null : null;
  const project =
    item.meta && item.meta.projectId
      ? (state.projects || []).find((p) => p && p.id === item.meta.projectId) || null
      : null;
  const done = us.done || item.status === "done" || item.status === "submitted";
  const facts = (item.meta && Array.isArray(item.meta.facts) && item.meta.facts) || [];
  const seenIn = Array.isArray(item.seenIn) ? item.seenIn : [];
  const snoozedUntil =
    us.snoozedUntil && Date.parse(us.snoozedUntil) > now.getTime() ? us.snoozedUntil : null;
  const estMin = typeof us.estimateMin === "number" && us.estimateMin > 0 ? us.estimateMin : 0;
  const preset = EST_CHIPS.some(([m]) => m === estMin) ? null : estMin || "";

  const onNotes = (v) => {
    setNotes(v);
    if (notesTimer.current) clearTimeout(notesTimer.current);
    notesTimer.current = setTimeout(
      () => actions.setUserState(item.id, { notes: v }),
      500
    );
  };

  const hide = () => {
    actions.setUserState(item.id, { hidden: true });
    actions.toast(`${item.title} hidden`, {
      label: "Undo",
      run: () => actions.setUserState(item.id, { hidden: false }),
    });
    onClose();
  };

  const del = () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    actions.manualDelete(item.id);
    onClose();
  };

  const addToCalendar = (override) => {
    const prev = us;
    actions.setUserState(item.id, {
      review: "accepted",
      calendar: null,
      ...(override ? { override } : {}),
    });
    setEditAdd(false);
    actions.toast("Added to your calendar", {
      label: "Undo",
      run: () =>
        actions.setUserState(item.id, {
          review: prev.review ?? null,
          calendar: prev.calendar ?? null,
          ...(override ? { override: prev.override ?? null } : {}),
        }),
    });
  };

  const removeFromCalendar = () => {
    const prev = us;
    actions.setUserState(item.id, removeCalendarPatch(us));
    actions.toast("Removed from your calendar", {
      label: "Undo",
      run: () =>
        actions.setUserState(item.id, {
          review: prev.review ?? null,
          calendar: prev.calendar ?? null,
        }),
    });
  };

  const addToTodo = () => {
    actions.setUserState(item.id, { todo: true });
    actions.toast("Added to To-do", {
      label: "Undo",
      run: () => actions.setUserState(item.id, { todo: null }),
    });
  };

  const removeFromTodo = () => {
    const prev = us.todo;
    actions.setUserState(item.id, { todo: false });
    actions.toast("Removed from To-do", {
      label: "Undo",
      run: () => actions.setUserState(item.id, { todo: prev ?? null }),
    });
  };

  return (
    <div class="sheet">
      <section class="card sheet-card">
        <div class="sheet-head">
          <span class="item-icon" aria-hidden="true" style={orgStyle(item.org, state.projects)}>
            <Icon size={18} />
          </span>
          <h2 class="sheet-title">{item.title}</h2>
          {item.org ? (
            <span class="chip chip-org" style={orgStyle(item.org, state.projects)}>{item.org}</span>
          ) : null}
        </div>
        <dl class="sheet-facts tabular">
          <dt>Type</dt>
          <dd>{typeLabelFor(item)}</dd>
          {whenLabel(item) ? (
            <>
              <dt>When</dt>
              <dd>
                {whenLabel(item)}
                {item.moved && item.moved.from ? (
                  <span class="sheet-moved"> · was <s>{fmtDay(item.moved.from)}</s></span>
                ) : null}
              </dd>
            </>
          ) : null}
          {item.location ? (
            <>
              <dt>Location</dt>
              <dd>
                <MapPinIcon size={11} /> {item.location}
              </dd>
            </>
          ) : null}
          {typeof item.weight === "number" ? (
            <>
              <dt>Weight</dt>
              <dd>{item.weight}% of grade</dd>
            </>
          ) : null}
          <dt>Confidence</dt>
          <dd>
            {item.confidence === "tentative" ? (
              <>
                <span class="badge badge-tentative">
                  <CircleDashedIcon size={11} /> Tentative
                </span>{" "}
                — found in text; the date may need a check
              </>
            ) : (
              "Exact"
            )}
          </dd>
          {item.meta && item.meta.onCalendar ? (
            <>
              <dt>Calendar</dt>
              <dd>Already on your Google Calendar</dd>
            </>
          ) : project ? (
            <>
              <dt>Calendar</dt>
              <dd>
                <label class="sheet-cal-toggle">
                  <input
                    type="checkbox"
                    checked={!(item.meta && item.meta.calendar === false)}
                    onChange={(e) => {
                      const on = /** @type {any} */ (e.target).checked;
                      const meta = { ...(raw.meta || {}) };
                      if (on) delete meta.calendar;
                      else meta.calendar = false;
                      actions.manualUpsert({ ...raw, meta });
                    }}
                  />
                  Include in calendar
                </label>
              </dd>
            </>
          ) : (
            <>
              <dt>Calendar</dt>
              <dd class="sheet-cal">
                {cal.kind === "on" ? (
                  <button type="button" class="btn btn-sm" onClick={removeFromCalendar}>
                    Remove from calendar
                  </button>
                ) : cal.canAdd ? (
                  <span class="sheet-cal-acts">
                    <button
                      type="button"
                      class="btn btn-sm btn-primary"
                      onClick={() => addToCalendar()}
                    >
                      Add to calendar
                    </button>
                    <button
                      type="button"
                      class="btn btn-sm"
                      onClick={() => setEditAdd(true)}
                    >
                      Edit &amp; add
                    </button>
                  </span>
                ) : (
                  <span class="help">{calendarReasonText(cal.reason, item)}</span>
                )}
                {calSyncOff ? (
                  <span class="help sheet-cal-hint">
                    Calendar sync is off — it'll show in Upcoming now and on Google
                    Calendar once you turn sync on.
                  </span>
                ) : null}
              </dd>
            </>
          )}
          {todo.listed || todo.canAdd ? (
            <>
              <dt>To-do</dt>
              <dd class="sheet-cal">
                {todo.listed ? (
                  <span class="sheet-cal-acts">
                    <span class="help">{todo.auto ? "On your to-do list" : "Pinned to your to-do list"}</span>
                    <button type="button" class="btn btn-sm" onClick={removeFromTodo}>
                      Remove from To-do
                    </button>
                  </span>
                ) : (
                  <button type="button" class="btn btn-sm" onClick={addToTodo}>
                    Add to To-do
                  </button>
                )}
              </dd>
            </>
          ) : null}
        </dl>
        {editAdd ? (
          <ItemEditForm
            item={item}
            onSave={(override) => addToCalendar(override)}
            onCancel={() => setEditAdd(false)}
          />
        ) : null}
        {linkedSrc ? (
          <p class="help sheet-linked-src">
            From {sourceLabel(linkedSrc.source)}:{" "}
            <button
              type="button"
              class="linklike"
              onClick={() => actions.openItem && actions.openItem(linkedSrc)}
            >
              {linkedSrc.title}
            </button>
          </p>
        ) : null}
        {item.meta && item.meta.auto === "study" ? (
          <StudyTodoCard
            item={item}
            us={us}
            parent={state.items[(item.meta.parentId)] || null}
            actions={actions}
            now={now}
          />
        ) : null}
        {item.details ? <p class="sheet-details">{item.details}</p> : null}
        {facts.length ? (
          <dl class="sheet-facts">
            {facts.map((f, i) => (
              <div class="sheet-fact" key={i}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {seenIn.length ? (
          <div class="sheet-sources">
            <h3 class="sheet-h">Sources</h3>
            {seenIn.map((s, i) => {
              const openUrl = sourceOpenLink(item, s, ADAPTERS);
              return (
                <div class="sheet-src" key={`${s.source}-${s.scope || ""}-${i}`}>
                  <span class="sheet-src-name">{sourceLabel(s.source)}</span>
                  {s.scope ? <span class="badge badge-muted">{s.scope}</span> : null}
                  {s.at ? (
                    <span class="sheet-src-at tabular">{fmtAgo(s.at, now)}</span>
                  ) : null}
                  {openUrl ? (
                    <button
                      type="button"
                      class="linklike sheet-src-open"
                      title={openUrl}
                      onClick={() => actions.open(openUrl)}
                    >
                      Open <ExternalLinkIcon size={10} />
                    </button>
                  ) : null}
                </div>
              );
            })}
            {item.evidence && item.evidence.snippet ? (
              <p class="review-evidence">{item.evidence.snippet}</p>
            ) : null}
          </div>
        ) : null}
        <div class="sheet-acts">
          {link.url ? (
            <button
              type="button"
              class="btn btn-primary"
              onClick={() => actions.open(link.url)}
            >
              <ExternalLinkIcon size={13} /> Open in {link.label}
            </button>
          ) : null}
          {!NO_CHECK.has(item.type) ? (
            <button
              type="button"
              class="btn"
              onClick={() => actions.toggleDone(item)}
            >
              <CheckIcon size={13} /> {done ? "Mark not done" : "Mark done"}
            </button>
          ) : null}
          <button type="button" class="btn" onClick={hide}>
            <EyeOffIcon size={13} /> Hide
          </button>
          {item.source === "manual" && actions.editManual ? (
            <>
              <button
                type="button"
                class="btn"
                onClick={() => actions.editManual(item)}
              >
                <PencilIcon size={13} /> Edit
              </button>
              <button
                type="button"
                class={`btn${confirmDelete ? " btn-danger" : ""}`}
                onClick={del}
              >
                <TrashIcon size={13} /> {confirmDelete ? "Confirm delete" : "Delete"}
              </button>
            </>
          ) : null}
        </div>
      </section>

      <section class="card sheet-card">
        <h3 class="sheet-h">Your stuff</h3>
        <label class="sheet-field">
          <span class="sheet-label">Notes</span>
          <textarea
            class="input sheet-notes"
            rows={3}
            placeholder="Private notes — saved on this computer"
            value={notes}
            onInput={(e) => onNotes(/** @type {any} */ (e.target).value)}
          />
        </label>
        <span class="sheet-label">Subtasks</span>
        <Checklist item={item} us={us} actions={actions} withDefaults={false} />
        <span class="sheet-label">Estimate</span>
        <div class="chip-scroll">
          {EST_CHIPS.map(([m, label]) => (
            <button
              key={m}
              type="button"
              class={`chip filter-chip${estMin === m ? " active" : ""}`}
              aria-pressed={estMin === m}
              onClick={() =>
                actions.setUserState(item.id, { estimateMin: estMin === m ? null : m })
              }
            >
              {label}
            </button>
          ))}
          <input
            class="input sheet-est-custom"
            type="number"
            min={1}
            placeholder="min"
            aria-label="Custom estimate in minutes"
            value={preset}
            onInput={(e) => {
              const v = Number(/** @type {any} */ (e.target).value);
              actions.setUserState(item.id, { estimateMin: v > 0 ? Math.round(v) : null });
            }}
          />
        </div>
        <span class="sheet-label">Snooze</span>
        <div class="chip-scroll chip-wrap">
          {SNOOZE_PRESETS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              class="chip filter-chip"
              onClick={() =>
                actions.setUserState(item.id, { snoozedUntil: snoozeUntil(key, now) })
              }
            >
              {label}
            </button>
          ))}
          {snoozedUntil ? (
            <button
              type="button"
              class="chip filter-chip active"
              onClick={() => actions.setUserState(item.id, { snoozedUntil: null })}
            >
              Until {fmtDay(snoozedUntil)} — unsnooze
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

const LEAD_CHOICES = [1, 2, 3, 5, 7, 10, 14];

/**
 * The auto-section on a derived study to-do: a link to the parent item and
 * the lead-time override (userState.override.opensAt = due − lead days).
 * @param {{item: any, us: any, parent: any, actions: any, now: Date}} p
 */
function StudyTodoCard({ item, us, parent, actions, now }) {
  const dueMs = Date.parse(item.dueAt || item.startAt || "");
  const openMs = Date.parse(item.opensAt || "");
  const leadDays =
    Number.isNaN(dueMs) || Number.isNaN(openMs)
      ? (item.meta && item.meta.leadDays) || null
      : Math.max(0, Math.round((dueMs - openMs) / 86400000));

  const setLead = (days) => {
    if (Number.isNaN(dueMs)) return;
    const override = { ...(us.override || {}), opensAt: new Date(dueMs - days * 86400000).toISOString() };
    actions.setUserState(item.id, { override });
  };

  return (
    <div class="study-todo">
      {item.meta && item.meta.completesWhen ? (
        <p class="help">
          Auto-created — completes {item.meta.completesWhen}.
        </p>
      ) : null}
      {parent ? (
        <button
          type="button"
          class="btn btn-sm"
          onClick={() => actions.openItem(parent)}
        >
          <ArrowLeftIcon size={12} /> {parent.title}
          {parent.dueAt || parent.startAt ? (
            <span class="help"> · {fmtDay(parent.dueAt || parent.startAt)}</span>
          ) : null}
        </button>
      ) : null}
      {Number.isNaN(dueMs) ? null : (
        <div class="study-lead">
          <span class="sheet-label">Start showing {leadDays != null ? `(currently ${leadDays} day${leadDays === 1 ? "" : "s"} before)` : "…"}</span>
          <div class="chip-scroll chip-wrap">
            {LEAD_CHOICES.map((d) => (
              <button
                key={d}
                type="button"
                class={`chip filter-chip${leadDays === d ? " active" : ""}`}
                aria-pressed={leadDays === d}
                onClick={() => setLead(d)}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
