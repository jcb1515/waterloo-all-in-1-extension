// @ts-check
// One item row: org colour bar, done toggle, type icon, title, meta with a
// SourceBadge, and a right column that always carries a date —
//  - exam/interview/deadline rows get the key-event block (date + time + room);
//  - rows outside a day group get the compact date block ("Thu Oct 8 · 7:00 pm");
//  - rows under a day-group header may show the bare time.
// Old callers that still pass {actions, done, clashes, items} keep working.

import { rowView } from "../panel/model/agenda.js";
import { orgStyle } from "./colors.js";
import { typeIcon, CheckIcon, MapPinIcon, CircleDashedIcon } from "./icons.jsx";
import { SourceBadge } from "./SourceBadge.jsx";
import { DateBlock } from "./DateBlock.jsx";
import { KEY_TYPES } from "./dateLabel.js";

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
 * The meta-line type label: project deadlines read "Milestone" and the
 * synced "<name> due" item reads "Project due"; everything else uses
 * TYPE_LABELS.
 * @param {any} item
 */
export function typeLabelFor(item) {
  if (item && item.meta && item.meta.projectId) {
    if (item.meta.projectDue) return "Project due";
    if (item.type === "deadline") return "Milestone";
  }
  return TYPE_LABELS[(item && item.type)] || (item && item.type);
}

/**
 * @param {{item: any, now: Date, inDayGroup?: boolean,
 *   onOpen?: (item: any) => void, onToggleDone?: (item: any) => void,
 *   projects?: any[], priority?: string, hideOrg?: boolean,
 *   actions?: any, done?: boolean, clashes?: any[], items?: Record<string, any>}} props
 */
export function ItemRow({
  item,
  now,
  inDayGroup = false,
  onOpen,
  onToggleDone,
  projects,
  priority,
  hideOrg,
  // back-compat signature (components/ItemRow.jsx shim)
  actions,
  done,
  clashes,
  items,
}) {
  const v = rowView(item, now);
  const style = orgStyle(item.org, projects) || {};
  const Icon = typeIcon(item.type);
  const dimmed = done || item.status === "done" || item.status === "submitted";
  const checkable = !NO_CHECK.has(item.type) && (onToggleDone || (actions && actions.toggleDone));
  const key = KEY_TYPES.has(item.type);
  const clash = clashes && clashes.length ? clashes[0] : null;
  const clashNames = clash
    ? clash.itemIds
        .filter((id) => id !== item.id)
        .map((id) => (items && items[id] && items[id].title) || "")
        .filter(Boolean)
        .join(", ")
    : "";

  const open = () => {
    if (onOpen) return onOpen(item);
    if (actions && actions.openItem) return actions.openItem(item);
    if (item.url && actions && actions.open) return actions.open(item.url);
  };
  const toggle = onToggleDone || (actions && actions.toggleDone);

  return (
    <div
      class={`item-row${dimmed ? " dimmed" : ""}${key ? " key-event" : ""} linked`}
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
            toggle(item);
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
          {item.org && !hideOrg ? <span class="chip chip-org">{item.org}</span> : null}
          <SourceBadge item={item} />
          <span class="item-type">{typeLabelFor(item)}</span>
          {item.location && !key ? (
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
        {key || !inDayGroup ? (
          <DateBlock item={item} />
        ) : v.timeLabel ? (
          <span class="item-time">{v.timeLabel}</span>
        ) : null}
      </span>
    </div>
  );
}
