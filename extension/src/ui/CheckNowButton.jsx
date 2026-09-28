// @ts-check
/*
  "Check now" control for a SourceId. Clicking sends UI.CHECK_NOW through
  actions.checkNow; while the run is in flight the button shows a spinner
  and "Checking…"; afterwards the result line comes from checkRunView
  (panel/model/sources.js), with an Open button when the view carries one.
*/

import { useState } from "preact/hooks";
import { checkRunView } from "../panel/model/sources.js";
import { IS_PREVIEW } from "../panel/data.js";
import { sourceLabel } from "./sourceLabel.js";
import { RefreshIcon } from "./icons.jsx";

/**
 * @param {{source: string, state: any, actions: any, now: Date|number,
 *   compact?: boolean, named?: boolean}} props
 *   `named` prefixes the button label with the source name — used where one
 *   tile covers two SourceIds (the email tile's Gmail + Outlook).
 */
export function CheckNowButton({ source, state, actions, now, compact, named }) {
  const view = checkRunView(state, source, now);
  const [pending, setPending] = useState(false);
  const running = pending || view.status === "running";
  const label = named ? `Check ${sourceLabel(source, null)}` : "Check now";

  /** @param {any} e */
  const onCheck = (e) => {
    if (e && e.stopPropagation) e.stopPropagation(); // may sit inside a tile
    if (IS_PREVIEW) {
      // No background in preview — the click is a no-op toast.
      if (actions && actions.toast) actions.toast("Check now runs against the live extension.");
      return;
    }
    setPending(true);
    Promise.resolve(actions.checkNow(source)).finally(() => setPending(false));
  };

  /** @param {any} e */
  const onOpen = (e) => {
    if (e && e.stopPropagation) e.stopPropagation();
    if (view.openUrl) actions.open(view.openUrl, { newTab: true });
  };

  return (
    <span class={`checknow${compact ? " compact" : ""}`}>
      <button
        type="button"
        class="btn btn-sm checknow-btn"
        disabled={running || view.status === "disabled"}
        onClick={onCheck}
      >
        {running ? (
          <>
            <span class="spin checknow-spin" aria-hidden="true">
              <RefreshIcon size={12} />
            </span>
            Checking…
          </>
        ) : (
          label
        )}
      </button>
      {!running && view.text ? (
        <span class="checknow-result">
          {view.text}
          {view.openUrl ? (
            <button type="button" class="linklike checknow-open" onClick={onOpen}>
              Open
            </button>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
