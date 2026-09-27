// General: theme, density, classes-in-agenda, review behaviour, and the
// hidden/snoozed items list.

import { Card, Field, Segmented, Toggle } from "../bits.jsx";
import { hiddenSnoozed } from "../../panel/model/itemsheet.js";
import { tabsFor, editTabs } from "../../panel/model/tabs.js";
import { fmtDay, fmtTime } from "../../panel/model/agenda.js";
import { send, IS_PREVIEW } from "../../panel/data.js";
import { UI } from "../../core/messages.js";

/** One row in the hidden/snoozed list. */
function HiddenRow({ entry }) {
  const { item, hidden, snoozedUntil } = entry;
  const patch = (p) => {
    if (!IS_PREVIEW) send({ type: UI.SET_USER_STATE, id: item.id, patch }).catch(() => {});
  };
  return (
    <div class="hidden-row">
      <span class="hidden-main">
        <strong>{item.title}</strong>
        <span class="help">
          {item.org ? `${item.org} · ` : ""}
          {hidden ? "Hidden" : ""}
          {hidden && snoozedUntil ? " · " : ""}
          {snoozedUntil ? `Snoozed until ${fmtDay(snoozedUntil)} ${fmtTime(snoozedUntil)}` : ""}
        </span>
      </span>
      <span class="hidden-acts">
        {hidden ? (
          <button type="button" class="btn btn-sm" onClick={() => patch({ hidden: false })}>
            Unhide
          </button>
        ) : null}
        {snoozedUntil ? (
          <button type="button" class="btn btn-sm" onClick={() => patch({ snoozedUntil: null })}>
            Unsnooze
          </button>
        ) : null}
      </span>
    </div>
  );
}

/**
 * @param {{settings: any, save: (patch: any) => void, state?: any, now?: Date}} p
 */
export function GeneralSection({ settings, save, state, now }) {
  const tucked = hiddenSnoozed(
    (state && state.items) || {},
    (state && state.userState) || {},
    now || new Date()
  );
  return (
    <div class="opt-stack">
      <Card title="Appearance">
        <Field label="Theme" help="Follows your system unless you pick one.">
          <Segmented
            ariaLabel="Theme"
            value={settings.theme || "system"}
            options={[
              ["system", "System"],
              ["light", "Light"],
              ["dark", "Dark"],
            ]}
            onChange={(v) => save({ theme: v })}
          />
        </Field>
        <Field label="Density" help="Compact packs more into the panel rows.">
          <Segmented
            ariaLabel="Density"
            value={settings.density || "comfortable"}
            options={[
              ["comfortable", "Comfortable"],
              ["compact", "Compact"],
            ]}
            onChange={(v) => save({ density: v })}
          />
        </Field>
      </Card>

      <Card title="Agenda">
        <Field label="Classes in the agenda" help="Lectures, tutorials and lab sessions.">
          <Segmented
            ariaLabel="Classes in the agenda"
            value={(settings.agenda && settings.agenda.showClasses) || "today"}
            options={[
              ["today", "Today & tomorrow"],
              ["all", "Always"],
              ["none", "Hide"],
            ]}
            onChange={(v) => save({ agenda: { showClasses: v } })}
          />
        </Field>
        <Toggle
          label="Show items found in text without review"
          checked={!!(settings.review && settings.review.showPending)}
          onChange={(v) => save({ review: { ...(settings.review || {}), showPending: v } })}
        />
        <p class="help">
          Dates spotted inside announcements and messages normally wait in the
          Review tab first. Turn this on to list them straight away.
        </p>
      </Card>

      <Card title="To-dos" id="todos">
        <TodoSettings settings={settings} save={save} />
      </Card>

      <Card title="Panel tabs" id="panel-tabs">
        <p class="help">
          Reorder or hide panel tabs. Keys 1–7 switch tabs in the order below; Agenda is always
          shown.
        </p>
        <TabEditor settings={settings} save={save} />
      </Card>

      <Card title="Hidden and snoozed items">
        {tucked.length ? (
          tucked.map((e) => <HiddenRow key={e.item.id} entry={e} />)
        ) : (
          <p class="help">Nothing hidden or snoozed.</p>
        )}
      </Card>
    </div>
  );
}

const LEAD_TYPES = [
  ["quiz", "Quiz"],
  ["midterm", "Midterm"],
  ["final", "Final exam"],
  ["exam", "Other exam"],
  ["presentation", "Presentation"],
];

/**
 * To-do preferences: which auto to-dos are created, study lead days, and
 * whether to-dos also land on the calendar feed.
 * @param {{settings: any, save: (patch: any) => void}} p
 */
function TodoSettings({ settings, save }) {
  const todos = settings.todos || {};
  const study = todos.study || {};
  const lead = study.leadDays || {};
  const patch = (p) => save({ todos: { ...todos, ...p } });
  const patchStudy = (p) => patch({ study: { ...study, ...p } });
  const patchLead = (k, v) => {
    const n = Math.max(0, Math.min(30, Math.round(Number(v) || 0)));
    patchStudy({ leadDays: { ...lead, [k]: n } });
  };

  return (
    <div class="opt-stack-sm">
      <Toggle
        label="Study to-dos before quizzes, exams and presentations"
        checked={study.enabled !== false}
        onChange={(v) => patchStudy({ enabled: v })}
      />
      {study.enabled !== false ? (
        <div class="lead-grid">
          {LEAD_TYPES.map(([k, label]) => (
            <label key={k} class="lead-cell">
              <span class="label">{label}</span>
              <span class="lead-input">
                <input
                  class="input input-sm"
                  type="number"
                  min={0}
                  max={30}
                  value={lead[k] ?? ""}
                  onChange={(e) => patchLead(k, /** @type {any} */ (e.target).value)}
                />
                <span class="help">days before</span>
              </span>
            </label>
          ))}
        </div>
      ) : null}
      <Toggle
        label="Co-op actions (offers, rankings, timeslots)"
        checked={todos.coop !== false}
        onChange={(v) => patch({ coop: v })}
      />
      <Toggle
        label="Deadlines count as to-dos"
        checked={todos.deadlines !== false}
        onChange={(v) => patch({ deadlines: v })}
      />
      <Toggle
        label="Reply to-dos from email and Discord"
        checked={todos.replies !== false}
        onChange={(v) => patch({ replies: v })}
      />
      <Toggle
        label="Put to-dos on the calendar feed"
        checked={!!todos.includeInCalendar}
        onChange={(v) => patch({ includeInCalendar: v })}
      />
    </div>
  );
}

/**
 * Panel tab order/visibility editor: checkbox to show, up/down to move.
 * @param {{settings: any, save: (patch: any) => void}} p
 */
function TabEditor({ settings, save }) {
  const tabs = tabsFor(settings);
  const move = (id, dir) =>
    editTabs(
      settings,
      (list) => {
        const i = list.findIndex((t) => t.id === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= list.length) return list;
        const next = list.slice();
        [next[i], next[j]] = [next[j], next[i]];
        return next;
      },
      save
    );
  const show = (id, v) =>
    editTabs(settings, (list) => list.map((t) => (t.id === id ? { ...t, visible: v } : t)), save);

  return (
    <div class="tab-edit">
      {tabs.map((t, i) => (
        <div key={t.id} class="tab-edit-row">
          <span class="tab-edit-num tabular">{i + 1}</span>
          <span class="tab-edit-label">{t.label}</span>
          <span class="hidden-acts">
            <button
              type="button"
              class="btn btn-sm"
              disabled={i === 0}
              aria-label={`Move ${t.label} up`}
              onClick={() => move(t.id, -1)}
            >
              ↑
            </button>
            <button
              type="button"
              class="btn btn-sm"
              disabled={i === tabs.length - 1}
              aria-label={`Move ${t.label} down`}
              onClick={() => move(t.id, 1)}
            >
              ↓
            </button>
            {t.id === "agenda" ? (
              <span class="help">always shown</span>
            ) : (
              <Toggle label="Shown" checked={t.visible} onChange={(v) => show(t.id, v)} />
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
