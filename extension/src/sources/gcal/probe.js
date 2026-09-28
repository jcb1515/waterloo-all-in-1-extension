// @ts-check
/*
  Reader probe for W1's "Check readers" screen: counts how many of the
  selectors the Google Calendar reader depends on actually hit on the
  current page. Pure and never throws — counts only, no text, names, ids
  or addresses.
*/

import { accountEmail } from "../email/dom.js";
import { decodeCalId, gcalExtract, gcalView, labelOf, parseChipLabel, popupEvent } from "./dom.js";
import { GCAL } from "./selectors.js";

const HINT_CHIPS = "No events visible — pick a week that has events.";
const HINT_SOME = "Some events couldn't be read — please report this page.";
const HINT_ACCOUNT =
  "Couldn't detect your Google account — your own events may not be recognised.";
const HINT_OPEN = "Open calendar.google.com.";

/** Pages the user should open to verify this reader. `page` is the probe
 *  page kind the item expects. */
export const CHECKLIST = [
  {
    id: "gcal-week",
    page: "gcal-week",
    label: "Week view with a few events",
    how: "Open Google Calendar in Week view on a week that has events.",
  },
  {
    id: "gcal-month",
    page: "gcal-month",
    label: "Month view",
    how: "Switch to Month view.",
  },
  {
    id: "gcal-schedule",
    page: "gcal-schedule",
    label: "Schedule view",
    how: "Switch to Schedule view.",
  },
  {
    id: "gcal-event",
    page: "gcal-week",
    label: "One open event",
    how: "Click an event so its details popup shows.",
  },
];

const UNKNOWN = { page: "unknown", counts: {}, ok: false, hints: [HINT_OPEN] };
const VIEW_PAGES = new Set(["gcal-day", "gcal-week", "gcal-month", "gcal-schedule"]);

/**
 * @param {any} doc   a DOM Document (linkedom or real)
 * @param {string} href
 * @returns {{page: string, counts: Record<string, number>, ok: boolean, hints: string[]}}
 */
export function probe(doc, href) {
  try {
    if (!doc || typeof doc.querySelectorAll !== "function") return { ...UNKNOWN };
    /** @type {URL} */
    let u;
    try {
      u = new URL(String(href || ""));
    } catch {
      return { ...UNKNOWN };
    }
    if (u.hostname !== "calendar.google.com") return { ...UNKNOWN };

    const ex = gcalExtract(doc, href);
    const page = VIEW_PAGES.has(`gcal-${ex.view}`) ? `gcal-${ex.view}` : "gcal-other";
    const account = accountEmail(doc) ? 1 : 0;
    /** @type {string[]} */
    const hints = [];

    if (!VIEW_PAGES.has(page)) {
      hints.push(HINT_OPEN);
      return { page, counts: { account }, ok: false, hints };
    }

    // Chips outside dialogs, the same set gcalExtract reads.
    const { date } = gcalView(u, new Date());
    const chips = [...doc.querySelectorAll(GCAL.chip)].filter(
      (el) => !(el.closest && el.closest(GCAL.dialog)),
    );
    let labeled = 0;
    let decodedIds = 0;
    for (const el of chips) {
      if (parseChipLabel(labelOf(el), { fallbackDate: date })) labeled++;
      if (decodeCalId(el.getAttribute("data-eventid"))) decodedIds++;
    }
    const dialogs = [...doc.querySelectorAll(GCAL.dialog)];
    const detailPopup = dialogs.some((d) => popupEvent(d, new Date(), "")) ? 1 : 0;
    /** @type {Record<string, number>} */
    const counts = {
      eventChips: chips.length,
      labeled,
      decodedIds,
      own: ex.events.filter((e) => e.calendarKind === "own").length,
      subscribed: ex.events.filter((e) => e.calendarKind === "subscribed").length,
      unknown: ex.events.filter((e) => e.calendarKind === "unknown").length,
      detailPopup,
      account,
    };
    const ok = labeled > 0;
    if (!chips.length) hints.push(HINT_CHIPS);
    else if (labeled < chips.length) hints.push(HINT_SOME);
    if (!account) hints.push(HINT_ACCOUNT);
    return { page, counts, ok, hints };
  } catch {
    return { ...UNKNOWN };
  }
}
