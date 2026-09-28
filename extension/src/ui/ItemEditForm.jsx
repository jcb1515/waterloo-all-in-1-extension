// Inline item edit form — shared by the Review card and the item sheet's
// "Edit & add". Edits become a userState.override patch; the caller decides
// what else the save writes (accepting the review, adding to the calendar).

import { useState } from "preact/hooks";

const EDITABLE_TYPES = [
  ["deadline", "Deadline"],
  ["quiz", "Quiz"],
  ["exam", "Exam"],
  ["presentation", "Presentation"],
  ["meeting", "Meeting"],
  ["interview", "Interview"],
  ["event", "Event"],
  ["task", "Task"],
];

/** Types that anchor on startAt rather than dueAt. */
const TIMED_TYPES = new Set(["exam", "meeting", "interview", "event", "class", "tutorial"]);

/**
 * @param {{item: any, onSave: (override: any) => void,
 *   onCancel: () => void}} props
 */
export function ItemEditForm({ item, onSave, onCancel }) {
  const anchor = item.startAt || item.dueAt || "";
  const d0 = anchor ? new Date(anchor) : new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const toDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const toTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  const [title, setTitle] = useState(item.title || "");
  const [type, setType] = useState(item.type || "deadline");
  const [date, setDate] = useState(toDate(d0));
  const [time, setTime] = useState(item.allDay ? "23:59" : toTime(d0));
  const [allDay, setAllDay] = useState(!!item.allDay);
  const [endTime, setEndTime] = useState(item.endAt ? toTime(new Date(item.endAt)) : "");

  const save = () => {
    const timed = TIMED_TYPES.has(type);
    const override = { title: title.trim() || item.title, type, allDay };
    const when = allDay ? `${date}T23:59` : `${date}T${time || "09:00"}`;
    const iso = new Date(when).toISOString();
    if (timed) {
      override.startAt = iso;
      override.dueAt = null;
      override.endAt = !allDay && endTime ? new Date(`${date}T${endTime}`).toISOString() : null;
    } else {
      override.dueAt = iso;
      override.startAt = null;
      override.endAt = null;
    }
    onSave(override);
  };

  return (
    <div class="review-edit">
      <input
        class="input"
        type="text"
        value={title}
        aria-label="Title"
        onInput={(e) => setTitle(/** @type {any} */ (e.target).value)}
      />
      <div class="review-edit-row">
        <select class="select" value={type} aria-label="Type" onChange={(e) => setType(/** @type {any} */ (e.target).value)}>
          {EDITABLE_TYPES.map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
        <input class="input" type="date" value={date} aria-label="Date" onChange={(e) => setDate(/** @type {any} */ (e.target).value)} />
        <label class="review-allday">
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(/** @type {any} */ (e.target).checked)} />
          All day
        </label>
      </div>
      {!allDay ? (
        <div class="review-edit-row">
          <input class="input" type="time" value={time} aria-label={TIMED_TYPES.has(type) ? "Start time" : "Time"} onChange={(e) => setTime(/** @type {any} */ (e.target).value)} />
          {TIMED_TYPES.has(type) ? (
            <input class="input" type="time" value={endTime} aria-label="End time (optional)" onChange={(e) => setEndTime(/** @type {any} */ (e.target).value)} />
          ) : null}
        </div>
      ) : null}
      <div class="review-acts">
        <button type="button" class="btn btn-sm btn-primary" onClick={save}>Save</button>
        <button type="button" class="btn btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
