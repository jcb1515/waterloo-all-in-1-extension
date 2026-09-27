// Editable checklist bound to userState[item.id].subtasks — shared by the
// Co-op prep cards and the item detail sheet's subtasks.

import { useState } from "preact/hooks";
import { checklistFor } from "../model/coop.js";
import { PlusIcon, XIcon } from "../../ui/icons.jsx";

/**
 * @param {{item: any, us: any, actions: any, withDefaults?: boolean}} props
 *   withDefaults=false leaves the list empty instead of prefilling the
 *   interview-prep defaults (used by the item sheet's generic subtasks).
 */
export function Checklist({ item, us, actions, withDefaults = true }) {
  const tasks =
    withDefaults || (us && Array.isArray(us.subtasks) && us.subtasks.length)
      ? checklistFor(item, us)
      : [];
  const [draft, setDraft] = useState("");
  const persist = (list) => actions.setUserState(item.id, { subtasks: list });
  return (
    <ul class="prep-check" aria-label="Checklist">
      {tasks.map((t, i) => (
        <li key={`${t.text}-${i}`}>
          <label>
            <input
              type="checkbox"
              checked={t.done}
              onChange={() =>
                persist(tasks.map((x, j) => (j === i ? { ...x, done: !x.done } : x)))
              }
            />
            <span class={t.done ? "done" : ""}>{t.text}</span>
          </label>
          <button
            type="button"
            class="btn-icon prep-del"
            aria-label={`Remove "${t.text}"`}
            onClick={() => persist(tasks.filter((_, j) => j !== i))}
          >
            <XIcon size={12} />
          </button>
        </li>
      ))}
      <li>
        <input
          class="input prep-add"
          type="text"
          placeholder="Add a step…"
          value={draft}
          aria-label="Add a checklist step"
          onInput={(e) => setDraft(/** @type {any} */ (e.target).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) {
              persist([...tasks, { text: draft.trim(), done: false }]);
              setDraft("");
            }
          }}
        />
        <button
          type="button"
          class="btn-icon"
          aria-label="Add step"
          onClick={() => {
            if (draft.trim()) {
              persist([...tasks, { text: draft.trim(), done: false }]);
              setDraft("");
            }
          }}
        >
          <PlusIcon size={13} />
        </button>
      </li>
    </ul>
  );
}
