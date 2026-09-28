# Google Calendar (gcal) — passive reader for duplicate suppression

Reads whatever the user has open on `calendar.google.com` — event chips in
day/week/month/schedule views plus any open event-detail popup — and keeps a
rolling `state.events` of what is already on their calendar. It produces **no
Items**; W1's `suppressAgainstCalendar` compares Item candidates against this
state and sets `meta.onCalendar = "google"` on matches so nothing is published
twice.

**Passive only.** No fetch/XHR/WebSocket, no navigation or clicks, no storage
or tokens. The extract carries only `title`, `startAt`, `endAt`, `allDay` and
`calendarKind` — never descriptions, guests, locations, owners, response
statuses, event ids or calendar ids.

## Extract (content.js → observe.parse)

`gcalExtract(doc, href, {now})` (dom.js) returns:

```js
{ v: 1,
  view: "day" | "week" | "month" | "schedule" | "other",
  range: {start, end} | null,          // half-open ISO instants at Toronto midnights
  events: [{title, startAt, endAt?, allDay, calendarKind}] }
```

- **view** is DOM-first: a top-level `[data-viewkey]` in caps (`"WEEK"`,
  `"DAY"`, `"MONTH"`, `"AGENDA"`, `"CUSTOM_DAYS"`) — the view-switcher
  menuitems carry the same attribute in lowercase and are ignored. The URL
  path `/calendar/u/<n>/r/<view>/<y>/<m>/<d>` is the fallback
  (`day`→day, `week`/`customweek`→week, `month`→month, `agenda`→schedule).
- **range** is the visible window, DOM-first: `[data-date]` day stamps
  inside the `[data-is-column-view-context]` grid (min..max, half-open
  Toronto midnights — the sidebar month picker's stamps are *outside*
  that container and never count), then the `[role="columnheader"]`
  "Sun27"-style day numbers resolved against the anchor, then the title
  ("… Week of September 27, 2026"), then the URL. Fall-back computation:
  day `[d, d+1)`; week `[Sunday on/before d, +7)`; month `[Sunday
  on/before the 1st, +42 days)`; schedule/other `null` (never deletes).
- **events** come from `[data-eventid]` chips (`aria-label`, else the
  visually-hidden leaf whose text starts with a month-date, a time range
  or "All day" — a year in the text is preferred — else the element text)
  and an open `[role="dialog"]` detail popup (heading + a
  `"Tuesday, September 29 ⋅ 1:00 – 1:30pm"` when-line, `⋅`/`·`/`•` normalised,
  parsed with textdates now-relative).
- **Chip labels** (`parseChipLabel`, exported) are comma-separated segments:
  `"1pm to 1:30pm, <title>, …, September 29, 2026"`, `"All day, <title>, …"`,
  plus the long-span heads `"September 8, 2026 at 8am to December 23, 2026
  at 11:59pm, <title>, …"` (midnight-to-midnight reads as all-day) and the
  single-point `"September 27, 2026 at 12:59am, <title>, …"`.
  The title is the first segment after the prefix — **a title containing a
  comma is truncated at that comma (accepted)**. Middle segments (owner,
  response, location) are discarded. No date segment → the anchor date. An
  all-day range end is the exclusive midnight after the last day; a timed end
  earlier than the start rolls to the next day. A `Calendar: <name>` middle
  segment names the chip's calendar: it marks the event `subscribed` unless
  the decoded event id already says `own`.
- **Dedupe** is lowercase title + startAt; on a tie the better calendarKind
  wins (own > subscribed > unknown), so an open popup merges with its chip
  and a multi-day event's one-chip-per-day cells collapse to one event.

## calendarKind (data-eventid)

`data-eventid` decodes (base64, url-safe tolerant, padding optional) to
`"<eventId> <calendarId>"`:

| calendarId | kind |
|---|---|
| the signed-in address (incl. the `@m` → `@gmail.com` shorthand) | `own` |
| `@group.calendar.google.com` (but not `group.v.`) | `own` |
| `@import.calendar.google.com` (this is what our own feed subscription looks like) | `subscribed` |
| `group.v.calendar.google.com` (holidays etc.) | `subscribed` |
| any other address | `subscribed` |
| undecodable / missing | `unknown` |

The signed-in address is read with email's `accountEmail` (`a[aria-label^="Google Account:"]`) — compare only, never serialised.

## observe.parse / state

`observe.parse` validates each event (string title ≤ 200, valid ISO startAt,
optional valid endAt, boolean allDay, known calendarKind) and maintains:

```js
state = { events: GcalEvent[], lastSeenAt }
```

`events` = previous events **minus** those whose `startAt` falls inside the
new `range` (when non-null — a null range never deletes), **plus** the new
events; deduped (own wins), kept inside `[now − 1 day, now + 60 days]`,
sorted by startAt, capped at 500 (nearest to now kept). Result is always
`{items: [], complete: true, readOk: ["gcal"], scope: "gcal",
session: "signed-in", state}`; bad JSON → `{items: [], complete: false,
scope: "gcal", state: prev}`.

## Probe / checklist

`probe(doc, href)` → `{page, counts, ok, hints}` backs W1's "Check readers"
screen — counts only, no text or ids. Pages: `gcal-day`, `gcal-week`,
`gcal-month`, `gcal-schedule`, `gcal-other`, `unknown`. Counts: `eventChips`,
`labeled` (chips `parseChipLabel` accepts), `decodedIds`, `own`/`subscribed`/
`unknown` (the extract's kind split), `detailPopup` (0/1), `account` (0/1).
`ok` = a view page with `labeled > 0`. `CHECKLIST` is the open-these-pages
list (`{id, label, how, page}`).

## Handoff notes for W1

- The extract shape above is what `payload.body` contains (JSON-stringified);
  `state.events` is the merged shape described under "observe.parse / state".
- `suppressAgainstCalendar` should compare **only `calendarKind === "own"`**
  events — never `subscribed` or `unknown`, so the user's subscription to our
  own feed can't suppress the items it came from.
- Wiring still needed: manifest optional host `https://calendar.google.com/*`,
  registry entry, the contract Source id, and the Settings toggle.

## VERIFY (unconfirmed against live pages)

- Confirmed on a real Week render: `[data-viewkey]` on `<body>`, the
  `[data-is-column-view-context]` container, `[role="columnheader"]` day
  columns, the hidden description leaf in each chip, the long-span and
  single-point label heads, and `Calendar: <name>` segments.
- Still unconfirmed: day/month/schedule view DOM markers (the fixture
  shapes are extrapolations), the `role="dialog"` popup when-line on the
  real page, and the `@m`/`@import`/`group.v` id classification against
  a wider set of real ids.
- The account-button selector is shared with Gmail and assumed identical.
