// Quick add sheet: one free-text line parsed live into editable fields, or
// the same form driven by an existing manual item (Edit mode). Add/Save goes
// through wa1:manual-upsert so manual items merge like any other source.

import { useState } from "preact/hooks";
import { parseQuickAdd, manualItemFrom } from "../../core/quickadd.js";
import { stripProjectPrefix, projectByName, projectById } from "../../core/projects.js";
import { TYPE_LABELS } from "../components/ItemRow.jsx";
import { fmtDay } from "../model/agenda.js";

const TIMED_TYPES = new Set(["exam", "meeting", "interview", "event", "class", "tutorial"]);

const TYPE_OPTIONS = [
  ["task", "Task"],
  ["deadline", "Deadline"],
  ["quiz", "Quiz"],
  ["exam", "Exam"],
  ["presentation", "Presentation"],
  ["meeting", "Meeting"],
  ["interview", "Interview"],
  ["event", "Event"],
  ["lab", "Lab"],
  ["class", "Class"],
];

const pad = (n) => String(n).padStart(2, "0");
const toDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Initial field state from a parsed result or an existing manual item. */
function fieldsFrom(parsed) {
  const anchor = parsed.dueAt || parsed.startAt || "";
  const d = anchor ? new Date(anchor) : null;
  return {
    title: parsed.title || "",
    org: parsed.org || "",
    type: parsed.type || "task",
    date: d ? toDate(d) : "",
    time: d ? toTime(d) : "",
    endTime: parsed.endAt ? toTime(new Date(parsed.endAt)) : "",
    allDay: !!parsed.allDay,
    location: parsed.location || "",
    projectId: parsed.projectId || (parsed.meta && parsed.meta.projectId) || "",
  };
}

/**
 * @param {{state: any, actions: any, now: Date, orgs: string[],
 *   editItem?: any, initialText?: string, onClose: () => void}} props
 */
export function QuickAdd({ state, actions, now, orgs, editItem, initialText = "", onClose }) {
  const [text, setText] = useState(initialText);
  const parseText = (v) => {
    // A leading "#project" routes the item into that project.
    const sp = stripProjectPrefix(v, state.projects);
    const parsed = parseQuickAdd(sp.text, { now, orgs });
    const f = fieldsFrom(parsed);
    const proj = sp.project || projectByName(state.projects, parsed.org);
    if (proj) {
      f.org = proj.name;
      f.projectId = proj.id;
    }
    return f;
  };

  const [fields, setFields] = useState(() =>
    editItem
      ? fieldsFrom(editItem)
      : initialText
        ? parseText(initialText)
        : fieldsFrom({})
  );

  const set = (k, v) => setFields((f) => ({ ...f, [k]: v }));

  const onText = (v) => {
    setText(v);
    setFields(parseText(v));
  };

  const timed = TIMED_TYPES.has(fields.type);

  const save = () => {
    const when = fields.allDay
      ? `${fields.date}T23:59`
      : `${fields.date}T${fields.time || "09:00"}`;
    /** @type {any} */
    const f = {
      title: fields.title.trim() || TYPE_LABELS[fields.type] || "Item",
      org: fields.org.trim(),
      type: fields.type,
      allDay: fields.allDay,
      location: fields.location.trim(),
    };
    if (fields.date) {
      const iso = new Date(when).toISOString();
      if (timed) {
        f.startAt = iso;
        if (!fields.allDay && fields.endTime) {
          f.endAt = new Date(`${fields.date}T${fields.endTime}`).toISOString();
        }
      } else {
        f.dueAt = iso;
      }
    }
    // Keep the item's meta (project link, calendar opt-out) on edit; an org
    // matching a project name links it.
    const meta = { ...((editItem && editItem.meta) || {}) };
    const proj = fields.projectId
      ? projectById(state.projects, fields.projectId)
      : projectByName(state.projects, fields.org);
    if (proj) {
      meta.projectId = proj.id;
      f.org = proj.name;
    }
    if (Object.keys(meta).length) f.meta = meta;
    const item = manualItemFrom(f, { id: editItem && editItem.id, now });
    actions.manualUpsert(item);
    actions.toast(editItem ? "Item updated" : `Added ${item.title}`);
    onClose();
  };

  return (
    <div class="sheet quickadd">
      <section class="card sheet-card">
        {!editItem ? (
          <input
            class="input quickadd-input"
            type="text"
            placeholder='ECE 105 quiz Friday 3pm · Team meeting tomorrow 6-7pm E7 2324'
            aria-label="Quick add text"
            value={text}
            onInput={(e) => onText(/** @type {any} */ (e.target).value)}
            autoFocus
          />
        ) : null}
        <div class="sheet-facts">
          <div class="sheet-fact">
            <dt>Title</dt>
            <dd>
              <input
                class="input"
                type="text"
                value={fields.title}
                aria-label="Title"
                onInput={(e) => set("title", /** @type {any} */ (e.target).value)}
              />
            </dd>
          </div>
          <div class="sheet-fact">
            <dt>Course / team</dt>
            <dd>
              <input
                class="input"
                type="text"
                value={fields.org}
                aria-label="Course or team"
                onInput={(e) => set("org", /** @type {any} */ (e.target).value)}
              />
            </dd>
          </div>
          <div class="sheet-fact">
            <dt>Type</dt>
            <dd>
              <select
                class="select"
                value={fields.type}
                aria-label="Type"
                onChange={(e) => set("type", /** @type {any} */ (e.target).value)}
              >
                {TYPE_OPTIONS.map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </dd>
          </div>
          <div class="sheet-fact">
            <dt>Date</dt>
            <dd class="qa-datetime">
              <input
                class="input"
                type="date"
                value={fields.date}
                aria-label="Date"
                onChange={(e) => set("date", /** @type {any} */ (e.target).value)}
              />
              <label class="qa-allday">
                <input
                  type="checkbox"
                  checked={fields.allDay}
                  onChange={(e) => set("allDay", /** @type {any} */ (e.target).checked)}
                />
                All day
              </label>
            </dd>
          </div>
          {!fields.allDay ? (
            <div class="sheet-fact">
              <dt>{timed ? "Time" : "Due"}</dt>
              <dd class="qa-datetime">
                <input
                  class="input"
                  type="time"
                  value={fields.time}
                  aria-label={timed ? "Start time" : "Due time"}
                  onChange={(e) => set("time", /** @type {any} */ (e.target).value)}
                />
                {timed ? (
                  <input
                    class="input"
                    type="time"
                    value={fields.endTime}
                    aria-label="End time (optional)"
                    onChange={(e) => set("endTime", /** @type {any} */ (e.target).value)}
                  />
                ) : null}
              </dd>
            </div>
          ) : null}
          <div class="sheet-fact">
            <dt>Location</dt>
            <dd>
              <input
                class="input"
                type="text"
                value={fields.location}
                aria-label="Location"
                onInput={(e) => set("location", /** @type {any} */ (e.target).value)}
              />
            </dd>
          </div>
        </div>
        {fields.date ? (
          <p class="help qa-preview">
            {timed ? fmtDay(`${fields.date}T12:00`) : `Due ${fmtDay(`${fields.date}T12:00`)}`}
          </p>
        ) : null}
        <div class="sheet-acts">
          <button
            type="button"
            class="btn btn-primary"
            disabled={!fields.title.trim()}
            onClick={save}
          >
            {editItem ? "Save" : "Add"}
          </button>
          <button type="button" class="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </section>
    </div>
  );
}
