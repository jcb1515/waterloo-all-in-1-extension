// @ts-check
// Double-injection guard for the owned content scripts. W1 re-injects content
// scripts into open tabs after install/update/startup; the new copy can share
// the old copy's isolated world and its chrome object, so a plain
// chrome.runtime.id probe on the old copy is not enough. This is the
// synchronous DOM-event handshake from the v4 re-injection protocol:
//
//   1. The new copy dispatches "wa1:ping" (detail: its instance name).
//   2. A running owner answers "wa1:pong" with the same detail, but only
//      while its own context resolves chrome.runtime.id — a zombie context's
//      runtime.id throws, so dead instances stay silent.
//   3. No pong -> the new copy dispatches "wa1:supersede"; any registered
//      owner tears itself down (observer, timers, runtime listener, DOM
//      listeners); the new copy then owns the pings.
//
// Local stand-in for W1's src/capture/guard.js — swap the import when that
// lands; the signature matches: guardInstance(name, teardown) -> boolean.

const PING = "wa1:ping";
const PONG = "wa1:pong";
const SUPERSEDE = "wa1:supersede";

/**
 * @param {string} name Instance name used as the event detail.
 * @param {() => void} teardown Runs when a later injection supersedes this one.
 * @returns {boolean} true when this copy owns the page and may proceed.
 */
export function guardInstance(name, teardown) {
  try {
    // Captured per call: this copy's own context binding. A dead context's
    // chrome.runtime.id throws on access, which is what makes the liveness
    // check below honest even when a later injection shares this world.
    const ext = (() => {
      try {
        return chrome;
      } catch {
        return null;
      }
    })();

    let owner = false;
    let torn = false;
    let gotPong = false;

    const onPong = (/** @type {any} */ ev) => {
      if (ev?.detail === name) gotPong = true;
    };
    const onPing = (/** @type {any} */ ev) => {
      try {
        if (ev?.detail !== name || !owner) return;
        if (!ext?.runtime?.id) return;
        document.dispatchEvent(new CustomEvent(PONG, { detail: name }));
      } catch {
        /* a dead context stays silent */
      }
    };
    const onSupersede = (/** @type {any} */ ev) => {
      if (ev?.detail !== name) return;
      owner = false;
      try {
        document.removeEventListener(PING, onPing);
      } catch {
        /* best effort */
      }
      try {
        document.removeEventListener(SUPERSEDE, onSupersede);
      } catch {
        /* best effort */
      }
      if (!torn) {
        torn = true;
        try {
          teardown();
        } catch {
          /* best effort */
        }
      }
    };

    document.addEventListener(PONG, onPong);
    try {
      document.dispatchEvent(new CustomEvent(PING, { detail: name }));
    } finally {
      document.removeEventListener(PONG, onPong);
    }
    if (gotPong) return false;

    document.dispatchEvent(new CustomEvent(SUPERSEDE, { detail: name }));
    owner = true;
    document.addEventListener(PING, onPing);
    document.addEventListener(SUPERSEDE, onSupersede);
    return true;
  } catch {
    // A document that cannot run the handshake still gets one instance.
    return true;
  }
}
