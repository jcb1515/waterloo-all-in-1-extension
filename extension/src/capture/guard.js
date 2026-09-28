// @ts-check
/*
  Double-injection handshake for isolated-world content scripts.

  After an extension reload a re-injected copy can share the same isolated
  world as an orphaned copy whose chrome.runtime is dead — a plain global
  flag can't tell "still alive" from "zombie", so instances talk over
  synchronous DOM CustomEvents:

    wa1:ping       detail = name — a new instance asking "is a live copy here?"
    wa1:pong       detail = name — a live copy answers INSIDE its ping
                   listener, and only while its own chrome.runtime.id exists
    wa1:supersede  detail = name — the newcomer evicts orphans; a superseded
                   instance runs its teardown (observers, timers, listeners)

  dispatchEvent is synchronous, so a pong listener registered before the
  ping is dispatched is guaranteed to see it.

  Usage at the top of a content script:
      if (!guardInstance("wa1:recorder", teardown)) return;
*/

const PING = "wa1:ping";
const PONG = "wa1:pong";
const SUPERSEDE = "wa1:supersede";

/**
 * Build the event with the document's OWN CustomEvent when there is one —
 * DOM shims (linkedom) stamp fields on dispatch and reject foreign Event
 * instances.
 * @param {any} target @param {string} type @param {string} detail
 */
function mkEvent(target, type, detail) {
  const CE =
    (target && target.defaultView && target.defaultView.CustomEvent) ||
    (typeof CustomEvent !== "undefined" ? CustomEvent : null);
  if (CE) return new CE(type, { detail });
  // Last resort for fakes that only need {type, detail}.
  return { type, detail };
}

/**
 * @param {string} name    this script's identity (one per injected bundle)
 * @param {() => void} [teardown]  called when a newer instance supersedes us
 * @param {any} [doc]      document — injectable for tests
 * @returns {boolean} true when this instance should run, false when a live
 *   copy already owns this world
 */
export function guardInstance(name, teardown, doc) {
  const target =
    doc !== undefined ? doc : typeof document !== "undefined" ? document : null;
  if (!target || typeof target.addEventListener !== "function") return true;

  let ponged = false;
  const onPong = (/** @type {Event} */ e) => {
    if (/** @type {CustomEvent} */ (e).detail === name) ponged = true;
  };
  target.addEventListener(PONG, onPong);
  try {
    target.dispatchEvent(mkEvent(target, PING, name));
  } finally {
    target.removeEventListener(PONG, onPong);
  }
  if (ponged) return false; // a live copy already runs this world

  // No live copy — tell any orphan to tear down, then install our own
  // ping/supersede listeners (after the dispatch, so we can't evict
  // ourselves).
  target.dispatchEvent(mkEvent(target, SUPERSEDE, name));
  let dead = false;
  const onPing = (/** @type {Event} */ e) => {
    if (/** @type {CustomEvent} */ (e).detail !== name || dead) return;
    // Answer only while this instance's extension context is alive — an
    // orphaned copy has chrome.runtime but an undefined id.
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) {
      target.dispatchEvent(mkEvent(target, PONG, name));
    }
  };
  const onSupersede = (/** @type {Event} */ e) => {
    if (/** @type {CustomEvent} */ (e).detail !== name || dead) return;
    dead = true;
    target.removeEventListener(PING, onPing);
    target.removeEventListener(SUPERSEDE, onSupersede);
    try {
      if (teardown) teardown();
    } catch {
      /* teardown must never break the page */
    }
  };
  target.addEventListener(PING, onPing);
  target.addEventListener(SUPERSEDE, onSupersede);
  return true;
}
