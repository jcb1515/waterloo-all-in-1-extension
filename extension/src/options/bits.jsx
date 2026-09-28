// Small shared building blocks for the settings sections. Field and Toggle
// live in ui/bits.jsx so the side panel uses the same switch markup.

export { Field, Toggle } from "../ui/bits.jsx";

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
