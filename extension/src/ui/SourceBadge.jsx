// @ts-check
// Where-an-item-came-from badge: a coloured source dot plus a short name.
// Several sources collapse to "Portal +2" with every name in the tooltip.
// All label logic lives in ./sourceLabel.js (pure, tested).

import { sourceBadge } from "./sourceLabel.js";

/**
 * @param {{item: any, class?: string}} props
 */
export function SourceBadge({ item, class: extraClass }) {
  const b = sourceBadge(item);
  if (!b) return null;
  return (
    <span
      class={`src-badge${extraClass ? ` ${extraClass}` : ""}`}
      style={{ "--src": b.color }}
      title={b.extra > 0 ? b.title : undefined}
    >
      <span class="src-dot" aria-hidden="true" />
      <span class="src-name">{b.label}</span>
      {b.extra > 0 ? <span class="src-more">+{b.extra}</span> : null}
    </span>
  );
}
