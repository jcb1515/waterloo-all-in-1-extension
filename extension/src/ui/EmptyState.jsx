// @ts-check
// Empty/placeholder panel: icon, title, one line of body copy, optional
// actions below.

/**
 * @param {{icon?: any, title: any, text?: any, children?: any}} props
 */
export function EmptyState({ icon: Icon, title, text, children }) {
  return (
    <div class="empty-state">
      {Icon ? (
        <span class="empty-state-icon" aria-hidden="true">
          <Icon size={22} />
        </span>
      ) : null}
      <div class="empty-state-title">{title}</div>
      {text ? <div class="empty-state-text">{text}</div> : null}
      {children}
    </div>
  );
}
