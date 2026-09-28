// @ts-check
// Re-export shim — the component moved to src/ui/ItemRow.jsx. Kept so callers
// on other streams (Coop.jsx, Teams.jsx) keep importing this path; the new
// component accepts both the old {actions, done, clashes, items} props and
// the new {onOpen, onToggleDone, inDayGroup} contract.

export { ItemRow, TYPE_LABELS, typeLabelFor } from "../../ui/ItemRow.jsx";
