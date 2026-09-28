// @ts-check
// "Picked up | Setup | Check"-style segmented control. Shared by the panel
// and options pages.

/**
 * @param {{value: string, options: [string, string][], onChange: (v: string) => void,
 *   ariaLabel?: string}} props
 */
export function Segmented({ value, options, onChange, ariaLabel }) {
  return (
    <div class="segmented" role="group" aria-label={ariaLabel}>
      {options.map(([v, label]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}
