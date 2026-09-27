// The All-in-1 mark: a gold tile with a charcoal orbit ring and a dot on it —
// "everything around you, in one place". Used in the panel header and settings.

/**
 * @param {{size?: number}} props
 */
export function BrandMark({ size = 28 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      role="img"
      aria-label="Waterloo All-in-1"
    >
      <rect width="128" height="128" rx="36" fill="#FED34C" />
      <circle cx="64" cy="64" r="38" fill="none" stroke="#15171C" stroke-width="14" />
      <circle cx="90.9" cy="37.1" r="7" fill="#15171C" />
    </svg>
  );
}
