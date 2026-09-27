// Reminders: master toggle, per-type lead times, quiet hours, the morning
// briefing, and a test notification.

import { useState } from "preact/hooks";
import { Card, Field, Toggle } from "../bits.jsx";
import { send, IS_PREVIEW } from "../../panel/data.js";
import { UI } from "../../core/messages.js";
import { BellIcon, XIcon } from "../../ui/icons.jsx";

const LEAD_PRESETS = [
  [10080, "1 week"],
  [4320, "3 days"],
  [2880, "2 days"],
  [1440, "1 day"],
  [180, "3 h"],
  [120, "2 h"],
  [60, "1 h"],
  [30, "30 min"],
  [15, "15 min"],
];

const TYPE_ROWS = [
  ["deadline", "Deadlines"],
  ["quiz", "Quizzes"],
  ["exam", "Exams"],
  ["presentation", "Presentations"],
  ["interview", "Interviews"],
  ["application-deadline", "Application deadlines"],
  ["offer-deadline", "Offer deadlines"],
  ["meeting", "Meetings"],
  ["task", "Tasks"],
  ["lab", "Lab reports"],
  ["class", "Classes"],
  ["tutorial", "Tutorials"],
  ["event", "Events"],
  ["cycle-date", "Co-op cycle dates"],
];

/** "2 h" / "1 day" for a lead in minutes. */
function leadLabel(min) {
  if (min % 1440 === 0) return `${min / 1440} day${min === 1440 ? "" : "s"}`;
  if (min % 60 === 0) return `${min / 60} h`;
  return `${min} min`;
}

/**
 * One type row: its lead chips plus a preset picker.
 * @param {{label: string, leads: number[], onChange: (leads: number[]) => void}} p
 */
function LeadRow({ label, leads, onChange }) {
  const sorted = [...leads].sort((a, b) => b - a);
  const missing = LEAD_PRESETS.filter(([m]) => !leads.includes(m));
  return (
    <div class="lead-row">
      <span class="lead-label">{label}</span>
      <span class="lead-chips">
        {sorted.length ? (
          sorted.map((m) => (
            <button
              key={m}
              type="button"
              class="chip lead-chip"
              title="Remove"
              onClick={() => onChange(leads.filter((x) => x !== m))}
            >
              {leadLabel(m)} <XIcon size={10} />
            </button>
          ))
        ) : (
          <span class="lead-none">none</span>
        )}
        {missing.length ? (
          <select
            class="select lead-add"
            aria-label={`Add a reminder for ${label}`}
            value=""
            onChange={(e) => {
              const m = Number(/** @type {any} */ (e.target).value);
              if (m > 0 && !leads.includes(m)) onChange([...leads, m]);
            }}
          >
            <option value="">+ add</option>
            {missing.map(([m, l]) => (
              <option key={m} value={m}>{l} before</option>
            ))}
          </select>
        ) : null}
      </span>
    </div>
  );
}

/**
 * @param {{settings: any, save: (patch: any) => void}} p
 */
export function RemindersSection({ settings, save }) {
  const rem = settings.reminders || {};
  const quiet = rem.quietHours || {};
  const briefing = rem.briefing || {};
  const leads = rem.leads || {};
  const [testMsg, setTestMsg] = useState("");

  const patch = (p) => save({ reminders: p });
  const setLeads = (type, list) =>
    patch({ leads: { ...leads, [type]: list } });

  const testNotify = async () => {
    if (IS_PREVIEW) {
      setTestMsg("Preview only — nothing sent.");
      return;
    }
    const res = await send({ type: UI.TEST_NOTIFY });
    setTestMsg(res && res.ok === false ? `Could not send: ${res.error}` : "Sent — check your notifications.");
    setTimeout(() => setTestMsg(""), 4000);
  };

  return (
    <div class="opt-stack">
      <Card title="Reminders">
        <Toggle
          label="Deadline and event reminders"
          checked={rem.enabled !== false}
          onChange={(v) => patch({ enabled: v })}
        />
        <p class="help">
          Google Calendar ignores reminders in subscribed feeds — these
          notifications come from the extension.
        </p>

        <Field label="Remind me before" help="Add or remove lead times per type.">
          <div class="lead-table">
            {TYPE_ROWS.map(([type, label]) => (
              <LeadRow
                key={type}
                label={label}
                leads={Array.isArray(leads[type]) ? leads[type] : []}
                onChange={(list) => setLeads(type, list)}
              />
            ))}
          </div>
        </Field>

        <Toggle
          label="Include tentative dates"
          checked={!!rem.includeTentative}
          onChange={(v) => patch({ includeTentative: v })}
        />

        <Field label="Quiet hours" help="Reminders wait until quiet hours end; a reminder whose event has already passed is dropped.">
          <div class="inline-row">
            <Toggle
              label="Quiet hours"
              checked={quiet.enabled !== false}
              onChange={(v) => patch({ quietHours: { ...quiet, enabled: v } })}
            />
            <input
              class="input time-input"
              type="time"
              value={quiet.start || "23:00"}
              disabled={quiet.enabled === false}
              onChange={(e) => patch({ quietHours: { ...quiet, start: /** @type {any} */ (e.target).value } })}
            />
            <span class="help">to</span>
            <input
              class="input time-input"
              type="time"
              value={quiet.end || "08:00"}
              disabled={quiet.enabled === false}
              onChange={(e) => patch({ quietHours: { ...quiet, end: /** @type {any} */ (e.target).value } })}
            />
          </div>
        </Field>

        <Field label="Morning briefing" help="One notification a day with today's classes and deadlines.">
          <div class="inline-row">
            <Toggle
              label="Daily briefing"
              checked={briefing.enabled !== false}
              onChange={(v) => patch({ briefing: { ...briefing, enabled: v } })}
            />
            <input
              class="input time-input"
              type="time"
              value={briefing.time || "08:00"}
              disabled={briefing.enabled === false}
              onChange={(e) => patch({ briefing: { ...briefing, time: /** @type {any} */ (e.target).value } })}
            />
          </div>
        </Field>

        <div class="inline-row">
          <button type="button" class="btn" onClick={testNotify}>
            <BellIcon size={13} /> Send test notification
          </button>
          {testMsg ? <span class="help">{testMsg}</span> : null}
        </div>
      </Card>
    </div>
  );
}
