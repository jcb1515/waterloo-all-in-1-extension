// General: theme, density, classes-in-agenda, review behaviour, and the
// hidden/snoozed items list.

import { Card, Field, Segmented, Toggle } from "../bits.jsx";
import { hiddenSnoozed } from "../../panel/model/itemsheet.js";
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
