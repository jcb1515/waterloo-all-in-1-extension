// Review view: dates found inside announcement/message text, waiting for a
// quick accept / edit / dismiss. Each card shows the evidence snippet with
// the matched date text highlighted.

import { useMemo, useState } from "preact/hooks";
import { extractDates } from "../../lib/textdates/index.js";
import { fmtDay, fmtTime, fmtRange } from "../model/agenda.js";
import { pendingReviewItems } from "../model/review.js";
import { GroupHeader } from "../components/GroupHeader.jsx";
import { typeIcon, CheckIcon, XIcon, PencilIcon, ExternalLinkIcon, InboxIcon } from "../../ui/icons.jsx";

const SOURCE_LABELS = {
  learn: "Learn",
  outline: "Course outline",
  portal: "Portal",
  waterlooworks: "WaterlooWorks",
  discord: "Discord",
  outlook: "Outlook",
  gmail: "Gmail",
  manual: "Manual",
};

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
 * Find the matched date text inside the evidence snippet so it can be
 * highlighted: re-extract dates and pick the hit whose startAt/endAt matches
 * the item's anchor. Returns [before, match, after] or null.
 */
function evidenceHighlight(item, snippet, now, termCode) {
  if (!snippet) return null;
  const anchor = item.dueAt || item.startAt;
  if (!anchor) return null;
  const aMs = Date.parse(anchor);
  try {
    for (const hit of extractDates(snippet, { now, termCode })) {
      const hMs = Date.parse(hit.startAt);
      const eMs = hit.endAt ? Date.parse(hit.endAt) : NaN;
      if (hMs === aMs || eMs === aMs) {
        const i = hit.index;
        return [snippet.slice(0, i), snippet.slice(i, i + hit.text.length), snippet.slice(i + hit.text.length)];
      }
    }
  } catch {
    /* extraction is best-effort */
  }
  return null;
}

/** Proposed date/time line: "Fri, Oct 3 · 4:30–6:20 PM" or "… · All day". */
function proposedWhen(item) {
  const a = item.startAt || item.dueAt;
  if (!a) return "No date";
  const d = fmtDay(a);
  if (item.allDay) return `${d} · All day`;
  const t = item.startAt && item.endAt ? fmtRange(item.startAt, item.endAt) : fmtTime(a);
  return `${d} · ${t}`;
}

/** Inline edit form for one pending item. */
function EditForm({ item, onSave, onCancel }) {
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

/** One pending item card. */
function ReviewCard({ item, now, termCode, editing, onEdit, actions }) {
  const Icon = typeIcon(item.type);
  const hl = useMemo(
    () => evidenceHighlight(item, item.evidence && item.evidence.snippet, now, termCode),
    [item, now, termCode]
  );
  const openUrl = item.url || (item.meta && item.meta.listUrl) || (item.evidence && item.evidence.url);

  if (editing) {
    return (
      <div class="card review-card">
        <EditForm
          item={item}
          onSave={(override) => actions.setUserState(item.id, { review: "accepted", override })}
          onCancel={onEdit}
        />
      </div>
    );
  }

  return (
    <div class="card review-card">
      <div class="review-head">
        <span class="item-icon" aria-hidden="true"><Icon size={16} /></span>
        <span class="review-title">{item.title}</span>
        {item.org ? <span class="chip chip-org">{item.org}</span> : null}
      </div>
      <div class="review-when tabular">{proposedWhen(item)}</div>
      {item.evidence && item.evidence.snippet ? (
        <p class="review-evidence">
          {hl ? (
            <>
              {hl[0]}<mark>{hl[1]}</mark>{hl[2]}
            </>
          ) : (
            item.evidence.snippet
          )}
        </p>
      ) : null}
      <div class="review-foot">
        <span class="review-src">{SOURCE_LABELS[item.source] || item.source}</span>
        {openUrl ? (
          <button
            type="button"
            class="btn btn-sm btn-ghost"
            onClick={() => actions.open(openUrl)}
          >
            Open source <ExternalLinkIcon size={11} />
          </button>
        ) : null}
      </div>
      <div class="review-acts">
        <button
          type="button"
          class="btn btn-sm btn-primary"
          onClick={() => actions.setUserState(item.id, { review: "accepted" })}
        >
          <CheckIcon size={12} /> Add
        </button>
        <button type="button" class="btn btn-sm" onClick={onEdit}>
          <PencilIcon size={12} /> Edit
        </button>
        <button
          type="button"
          class="btn btn-sm"
          onClick={() => actions.dismissReview(item)}
        >
          <XIcon size={12} /> Dismiss
        </button>
      </div>
    </div>
  );
}

/**
 * @param {{state: any, actions: any, now: Date, onBack: () => void}} props
 */
export function Review({ state, actions, now }) {
  const { upcoming, past } = useMemo(
    () => pendingReviewItems(state.items, state.userState, now),
    [state.items, state.userState, now]
  );
  const [editingId, setEditingId] = useState(() => (query0("edit") ? "first" : null));
  const [pastOpen, setPastOpen] = useState(false);
  const termCode = state.settings && state.settings.termCode;

  const dismiss = (item) => {
    actions.setUserState(item.id, { review: "dismissed" });
    actions.toast(`${item.title} dismissed`, {
      label: "Undo",
      run: () => actions.setUserState(item.id, { review: null }),
    });
  };

  const cardActions = { ...actions, dismissReview: dismiss };
  const total = upcoming.length + past.length;
  const editFirst = editingId === "first" ? (upcoming[0] || past[0] || {}).id : null;

  return (
    <div class="review">
      {total === 0 ? (
        <div class="card empty-card">
          <InboxIcon size={20} />
          <h3>Nothing to review</h3>
          <p class="help">
            Dates found in announcements, emails and messages show up here for a quick check.
          </p>
        </div>
      ) : null}

      {upcoming.map((it) => (
        <ReviewCard
          key={it.id}
          item={it}
          now={now}
          termCode={termCode}
          editing={editingId === it.id || editFirst === it.id}
          onEdit={() => setEditingId((cur) => (cur === it.id ? null : it.id))}
          actions={cardActions}
        />
      ))}

      {past.length ? (
        <section class="agenda-group">
          <GroupHeader
            label="Past"
            count={past.length}
            collapsed={!pastOpen}
            onToggle={() => setPastOpen((v) => !v)}
          />
          <div class="review-past-acts">
            <button
              type="button"
              class="btn btn-sm btn-ghost"
              onClick={() => {
                for (const it of past) actions.setUserState(it.id, { review: "dismissed" });
              }}
            >
              Dismiss all past
            </button>
          </div>
          {pastOpen ? (
            <>
              {past.map((it) => (
                <ReviewCard
                  key={it.id}
                  item={it}
                  now={now}
                  termCode={termCode}
                  editing={editingId === it.id || editFirst === it.id}
                  onEdit={() => setEditingId((cur) => (cur === it.id ? null : it.id))}
                  actions={cardActions}
                />
              ))}
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function query0(name) {
  try {
    return new URLSearchParams(location.search).get(name);
  } catch {
    return null;
  }
}
