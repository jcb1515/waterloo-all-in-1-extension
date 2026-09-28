// Small shared building blocks for the settings sections. Field and Toggle
// live in ui/bits.jsx so the side panel uses the same switch markup.

export { Field, Toggle } from "../ui/bits.jsx";

import { useState } from "preact/hooks";

/**
 * "Open side panel" button — asks Chrome to open the extension side panel
 * inside the click. When the API can't do it (preview, or the page has no
 * sidePanel permission path) a fallback hint appears instead.
 * @param {{label?: string, className?: string}} p
 */
export function OpenPanelButton({ label, className }) {
  const [hint, setHint] = useState("");
  const open = async () => {
    try {
      const win = await chrome.windows.getCurrent();
      await chrome.sidePanel.open({ windowId: win.id });
    } catch {
      setHint("Click the extension icon to open the panel.");
    }
  };
  return (
    <>
      <button type="button" class={className || "btn btn-sm"} onClick={open}>
        {label || "Open side panel"}
      </button>
      {hint ? <span class="help"> {hint}</span> : null}
    </>
  );
}

/**
 * @param {{title?: string, children: any, danger?: boolean, id?: string}} p
 */
export function Card({ title, children, danger, id }) {
  return (
    <section class={`card opt-card${danger ? " danger-zone" : ""}`} id={id}>
      {title ? <h3 class="opt-card-title">{title}</h3> : null}
      {children}
    </section>
  );
}

/**
 * Segmented option row.
 * @param {{value: string, options: [string, string][], onChange: (v: string) => void, ariaLabel?: string}} p
 */
export function Segmented({ value, options, onChange, ariaLabel }) {
  return (
    <div class="segmented" role="group" aria-label={ariaLabel}>
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * The "arrives in the next update" placeholder card.
 * @param {{icon: any, title: string, text: string}} p
 */
export function SoonCard({ icon: Icon, title, text }) {
  return (
    <Card>
      <div class="soon-card">
        <span class="soon-icon">
          <Icon size={22} />
        </span>
        <div>
          <h3 class="opt-card-title">{title}</h3>
          <p class="help">{text}</p>
        </div>
      </div>
    </Card>
  );
}
