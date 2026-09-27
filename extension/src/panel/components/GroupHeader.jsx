// Shared collapsible group header used by Agenda, Review and any grouped list.

import { ChevronRightIcon } from "../../ui/icons.jsx";

/**
 * @param {{label: string, count?: number|string, tone?: string,
 *   collapsed: boolean, onToggle: () => void, extra?: any}} p
 */
export function GroupHeader({ label, count, tone, collapsed, onToggle, extra }) {
  return (
    <button
      type="button"
      class={`group-head${tone ? ` tone-${tone}` : ""}`}
      aria-expanded={!collapsed}
      onClick={onToggle}
    >
      <span class={`chev${collapsed ? "" : " open"}`} aria-hidden="true">
        <ChevronRightIcon size={13} />
      </span>
      {label}
      {count != null ? <span class="count">{count}</span> : null}
      {extra || null}
    </button>
  );
}
