// @ts-check
/*
  Local-time date helpers shared by the panel models and UI. The formatters
  take anything Date can construct (Date, ms, ISO string) and render in the
  browser's local timezone.
*/

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** @param {any} d @returns {Date} */
const asDate = (d) => (d instanceof Date ? d : new Date(d));

/** A new Date at local 00:00 of the same day. @param {any} d */
export function startOfDay(d) {
  const x = asDate(d);
  return new Date(x.getFullYear(), x.getMonth(), x.getDate());
}

/** "7:05 PM" — 12-hour clock, no leading zero, uppercase AM/PM. @param {any} d */
export function fmtTime(d) {
  const x = asDate(d);
  const h = x.getHours() % 12 || 12;
  const m = String(x.getMinutes()).padStart(2, "0");
  return `${h}:${m} ${x.getHours() < 12 ? "AM" : "PM"}`;
}

/** "Thu, Sep 17" @param {any} d */
export function fmtDate(d) {
  const x = asDate(d);
  return `${WEEKDAYS[x.getDay()]}, ${MONTHS[x.getMonth()]} ${x.getDate()}`;
}

/** "Sep 17" @param {any} d */
export function fmtShortDate(d) {
  const x = asDate(d);
  return `${MONTHS[x.getMonth()]} ${x.getDate()}`;
}

/** "Thu" @param {any} d */
export function fmtWeekdayShort(d) {
  return WEEKDAYS[asDate(d).getDay()];
}
