// Profile: current term (read-only), course sections, and course groups.
// These teach the source adapters which section/group variants are yours.

import { useState } from "preact/hooks";
import { Card, Field } from "../bits.jsx";
import { normCourseCode } from "../../core/contract.js";
import { TrashIcon, PlusIcon } from "../../ui/icons.jsx";

const TERM_NAMES = { 1: "Winter", 5: "Spring", 9: "Fall" };

/** 1269 -> "Fall 2026 (1269)" */
function termLabel(code) {
  const s = String(code);
  if (s.length !== 4) return String(code);
  const yy = Number(s.slice(1, 3));
  const mm = Number(s[3]);
  const name = TERM_NAMES[mm] || `Term ${mm}`;
  return `${name} ${2000 + yy} (${code})`;
}

/**
 * @param {{settings: any, save: (patch: any) => void}} p
 */
export function ProfileSection({ settings, save }) {
  const sections = (settings.profile && settings.profile.sections) || {};
  const groups = (settings.profile && settings.profile.groups) || {};

  const setSections = (next) => save({ profile: { sections: next } });
  const setGroups = (next) => save({ profile: { groups: next } });

  return (
    <div class="opt-stack">
      <Card title="Term">
        <p class="term-line">
          <span class="tabular">{termLabel(settings.termCode || 1269)}</span>
        </p>
        <p class="help">Detected automatically — editing arrives with the Portal source.</p>
      </Card>

      <Card title="Sections">
        <p class="help">
          Which section you're in, per course — the agenda filters out events for other sections.
        </p>
        <Table
          cols={["Course", "Sections"]}
          rows={Object.entries(sections).map(([code, list]) => [code, list])}
          renderRow={(code, list) => [code, (list || []).join(", ")]}
          onRemove={(code) => {
            const next = { ...sections };
            delete next[code];
            setSections(next);
          }}
          onAdd={(code, value) =>
            setSections({
              ...sections,
              [code]: value.split(",").map((s) => s.trim()).filter(Boolean),
            })
          }
          placeholders={["ECE 105", "LEC 002, TUT 104"]}
          emptyHint="Filled automatically from Portal, or add your own."
        />
      </Card>

      <Card title="Groups">
        <p class="help">For group deliverables — which group you're in, per course.</p>
        <Table
          cols={["Course", "Group"]}
          rows={Object.entries(groups).map(([code, g]) => [code, g])}
          renderRow={(code, g) => [code, g]}
          onRemove={(code) => {
            const next = { ...groups };
            delete next[code];
            setGroups(next);
          }}
          onAdd={(code, value) => setGroups({ ...groups, [code]: value })}
          placeholders={["ECE 190", "5"]}
          emptyHint="Filled automatically from Portal, or add your own."
        />
      </Card>
    </div>
  );
}

/**
 * Two-column editable table with add/remove rows.
 * @param {{cols: string[], rows: [string, any][], renderRow: Function, onRemove: Function, onAdd: Function, placeholders: string[], emptyHint?: string}} p
 */
function Table({ cols, rows, renderRow, onRemove, onAdd, placeholders, emptyHint }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const add = () => {
    const code = normCourseCode(a);
    if (!code || !b.trim()) return;
    onAdd(code, b.trim());
    setA("");
    setB("");
  };
  return (
    <div class="edit-table-wrap">
      {rows.length ? null : <p class="help">{emptyHint || "Nothing here yet."}</p>}
    <table class="edit-table">
      <thead>
        <tr>
          <th>{cols[0]}</th>
          <th>{cols[1]}</th>
          <th class="row-act" aria-label="Remove" />
        </tr>
      </thead>
      <tbody>
        {rows.map(([code, v]) => (
          <tr key={code}>
            {renderRow(code, v).map((cell, i) => (
              <td key={i}>{cell}</td>
            ))}
            <td class="row-act">
              <button
                type="button"
                class="btn-icon"
                aria-label={`Remove ${code}`}
                onClick={() => onRemove(code)}
              >
                <TrashIcon size={14} />
              </button>
            </td>
          </tr>
        ))}
        <tr class="add-row">
          <td>
            <input
              class="input"
              value={a}
              placeholder={placeholders[0]}
              onInput={(e) => setA(/** @type {any} */ (e.target).value)}
            />
          </td>
          <td>
            <input
              class="input"
              value={b}
              placeholder={placeholders[1]}
              onInput={(e) => setB(/** @type {any} */ (e.target).value)}
            />
          </td>
          <td class="row-act">
            <button type="button" class="btn-icon" aria-label="Add" onClick={add} disabled={!a.trim() || !b.trim()}>
              <PlusIcon size={15} />
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    </div>
  );
}
