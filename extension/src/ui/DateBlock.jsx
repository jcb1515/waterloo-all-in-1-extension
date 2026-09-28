// @ts-check
// Compact "Thu Oct 8 · 7:00 pm" block for rows outside a day group, and the
// bold key-event variant (date + time + room) for exams, interviews and
// deadlines. A time is only ever rendered together with its date.

import { dateBlockFor } from "./dateLabel.js";

/**
 * @param {{item: any}} props
 */
export function DateBlock({ item }) {
  const b = dateBlockFor(item);
  if (!b) return null;
  return (
    <span class={`date-block${b.key ? " key" : ""}`}>
      <span class="date-block-day">{b.date}</span>
      {b.time ? <span class="date-block-time"> · {b.time}</span> : null}
      {b.room ? <span class="date-block-room"> · {b.room}</span> : null}
    </span>
  );
}
