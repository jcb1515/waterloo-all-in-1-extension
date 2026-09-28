// @ts-check
// Small building blocks shared by the options page and the side panel.

/**
 * @param {{label: string, help?: string, children: any}} p
 */
export function Field({ label, help, children }) {
  return (
    <div class="field">
      <span class="label">{label}</span>
      {children}
      {help ? <p class="help">{help}</p> : null}
    </div>
  );
}

/**
 * Toggle switch row.
 * @param {{checked: boolean, onChange: (v: boolean) => void, label: string, disabled?: boolean}} p
 */
export function Toggle({ checked, onChange, label, disabled }) {
  return (
    <label class={`switch${disabled ? " disabled" : ""}`}>
      <input
        type="checkbox"
        checked={!!checked}
        disabled={!!disabled}
        onChange={(e) => onChange(/** @type {any} */ (e.target).checked)}
      />
      <span class="track" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}
