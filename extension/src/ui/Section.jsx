// @ts-check
// Titled content section: a small heading with an optional aside (counts,
// "see all" links) and a body.

/**
 * @param {{title?: any, aside?: any, children?: any, class?: string}} props
 */
export function Section({ title, aside, children, class: extraClass }) {
  return (
    <section class={`ui-section${extraClass ? ` ${extraClass}` : ""}`}>
      {title ? (
        <header class="ui-section-head">
          <h3 class="ui-section-title">{title}</h3>
          {aside ? <span class="ui-section-aside">{aside}</span> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}
