// One agenda row: org colour bar, done toggle, type icon, title, meta, and a
// right-aligned tabular time column (countdown / late / status).

import { rowView } from "../model/agenda.js";
import { orgStyle } from "../../ui/colors.js";
import { typeIcon, CheckIcon, MapPinIcon, CircleDashedIcon } from "../../ui/icons.jsx";

export const TYPE_LABELS = {
  deadline: "Deadline",
  quiz: "Quiz",
  exam: "Exam",
  presentation: "Presentation",
  class: "Class",
  tutorial: "Tutorial",
  lab: "Lab",
  meeting: "Meeting",
  interview: "Interview",
  "application-deadline": "Application",
  "offer-deadline": "Offer deadline",
  "cycle-date": "Cycle date",
  task: "Task",
  event: "Event",
  "term-date": "Term date",
};

const NO_CHECK = new Set(["class", "tutorial", "exam", "term-date"]);

/**
 * @param {{item: any, now: Date, actions: any, done?: boolean,
 *   clashes?: any[], items?: Record<string, any>, priority?: string,
 *   projects?: any[]}} props
 */
export function ItemRow({ item, now, actions, done, clashes, items, priority, projects }) {
  const v = rowView(item, now);
  const style = orgStyle(item.org, projects) || {};
  const Icon = typeIcon(item.type);
  const dimmed = done || item.status === "done" || item.status === "submitted";
  const checkable = !NO_CHECK.has(item.type);
  const clash = clashes && clashes.length ? clashes[0] : null;
  const clashNames = clash
    ? clash.itemIds
        .filter((id) => id !== item.id)
        .map((id) => (items && items[id] && items[id].title) || "")
        .filter(Boolean)
        .join(", ")
    : "";

  const open = () => {
    if (actions.openItem) actions.openItem(item);
    else if (item.url) actions.open(item.url);
  };

  return (
    <div
      class={`item-row${dimmed ? " dimmed" : ""} linked`}
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
      {checkable ? (
        <button
          type="button"
          class={`check${dimmed ? " on" : ""}`}
          aria-label={dimmed ? "Mark not done" : "Mark done"}
          aria-pressed={dimmed}
          onClick={(e) => {
            e.stopPropagation();
            actions.toggleDone(item);
          }}
        >
          <CheckIcon size={14} />
        </button>
      ) : (
        <span class="check-spacer" aria-hidden="true" />
      )}
      <span class="item-icon" aria-hidden="true">
        <Icon size={17} />
      </span>
      <span class="item-main">
        <span class="item-title">
          {priority === "high" && !dimmed ? (
            <span class="pri-high" title="High priority" aria-label="High priority">!</span>
          ) : null}
          {item.title}
        </span>
        <span class="item-meta">
          {item.org ? <span class="chip chip-org">{item.org}</span> : null}
          <span class="item-type">{TYPE_LABELS[item.type] || item.type}</span>
          {item.location ? (
            <span class="item-loc">
              <MapPinIcon size={11} /> {item.location}
            </span>
          ) : null}
          {item.weight != null ? <span class="badge badge-muted tabular">{item.weight}%</span> : null}
          {item.meta && item.meta.onCalendar ? (
            <span
              class="badge badge-muted"
              title="On your Google Calendar — the feed skips it to avoid a duplicate"
            >
              On your Google Calendar
            </span>
          ) : null}
          {item.confidence === "tentative" ? (
            <span class="badge badge-tentative">
              <CircleDashedIcon size={11} /> Tentative
            </span>
          ) : null}
          {v.movedFrom ? (
            <span class="badge badge-warn" title="Rescheduled">
              Moved · was <s>{v.movedFrom}</s>
            </span>
          ) : null}
          {clash ? (
            <span
              class={`badge ${clash.severity === "severe" ? "badge-danger" : "badge-warn"}`}
              title={clashNames ? `Overlaps ${clashNames}` : "Overlaps another item"}
            >
              Clash
            </span>
          ) : null}
        </span>
      </span>
      <span class="item-right tabular">
        {v.statusLabel ? (
          <span class="item-status ok">
            <CheckIcon size={12} /> {v.statusLabel}
          </span>
        ) : null}
        {v.lateLabel && !dimmed ? <span class="item-late">{v.lateLabel}</span> : null}
        {v.countdown && !v.lateLabel ? <span class="item-countdown">{v.countdown}</span> : null}
        {v.timeLabel ? <span class="item-time">{v.timeLabel}</span> : null}
      </span>
    </div>
  );
}
