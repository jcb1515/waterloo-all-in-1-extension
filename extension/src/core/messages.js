// @ts-check
/*
  UI-internal runtime message types (panel/options <-> background). These are
  NOT part of the frozen contract — contract.js only carries the capture-side
  message names (wa1:capture / wa1:observed / wa1:discovery / wa1:relay-fetch /
  wa1:tab-ready).
*/
export const UI = Object.freeze({
  /** panel -> background: { type, source? } run a manual sync */
  SYNC: "wa1:sync",
  /** panel -> background: { type, id, patch } merge into userState[id] */
  SET_USER_STATE: "wa1:set-user-state",
  /** panel -> background: { type, url } open or focus a tab */
  OPEN: "wa1:open",
  /** panel -> background: { type, source } drop a source's data */
  CLEAR_SOURCE: "wa1:clear-source",
  /** options -> background: { type } publish the calendar feed now */
  CALENDAR_PUBLISH: "wa1:calendar-publish",
  /** options -> background: { type } delete the feed and disable sync */
  CALENDAR_STOP: "wa1:calendar-stop",
  /** options -> background: { type } fire a sample reminder notification */
  TEST_NOTIFY: "wa1:test-notification",
});
