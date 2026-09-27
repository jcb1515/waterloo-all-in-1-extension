// General: theme, density, classes-in-agenda, review behaviour.

import { Card, Field, Segmented, Toggle } from "../bits.jsx";

/**
 * @param {{settings: any, save: (patch: any) => void}} p
 */
export function GeneralSection({ settings, save }) {
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
    </div>
  );
}
