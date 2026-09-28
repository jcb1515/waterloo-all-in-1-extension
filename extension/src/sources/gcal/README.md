# Google Calendar (gcal) — duplicate suppression

Two readers keep a rolling `state.events` of what is already on the user's
calendar, and it produces **no Items**; W1's `suppressAgainstCalendar`
compares Item candidates against this state and sets
`meta.onCalendar = "google"` on matches so nothing is published twice.

- **Export read (sync, every 6 h)** — `exporticalzip` from the service
  worker via `ctx.fetch` (the same URL is 403 from a page tab). The zip
  holds only the user's OWN calendars, so everything it yields is
  `calendarKind: "own"`.
- **Passive DOM read (observe)** — whatever the user has open on
  `calendar.google.com`: chips in day/week/month/schedule views plus an
  open event-detail popup. This is where subscribed calendars (including
  our own feed) live — the export never contains them.

**Passive only in the page.** The content script sends no request
(fetch/XHR/WebSocket), never navigates or clicks, never touches storage or
tokens. The extract carries only `title`, `startAt`, `endAt`, `allDay` and
`calendarKind` — never descriptions, guests, locations, owners, response
statuses, event ids or calendar ids. The export read keeps only SUMMARY,
DTSTART/DTEND/DURATION, RRULE, EXDATE, RECURRENCE-ID, STATUS and UID while
parsing — nothing else leaves the ICS.

## Export read (index.js sync → zip.js → ics.js)

`GET https://calendar.google.com/calendar/u/<account>/exporticalzip` with
`{binary: true}` (account from `settings.sources.gcal.account`, default 0):

- `status 0` → `error {code: "unreachable"}`.
- login redirect, HTML content-type or a body that isn't `PK`
  → `session: "signed-out"`, state preserved.
- `zip.js` reads the central directory (methods 0/8, deflate-raw via
  `DecompressionStream`) with caps: ≤ 50 entries, ≤ 20 MB per entry, ≤ 40
  MB total. Entries named `@import.calendar.google.com` or
  `@group.v.calendar.google.com` are skipped, and any calendar whose
  `X-WR-CALNAME`/`PRODID` contains "Waterloo All-in-1" (defensive — the
  export only holds own calendars).
- `ics.js` unfolds lines and reads VEVENTs only; RRULEs (FREQ
  DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL, BYDAY incl.
  ordinals, BYMONTHDAY, BYMONTH) expand in the event's own wall-clock
  zone so a DST flip keeps the local time; ≤ 1000 occurrences per event;
  EXDATE removes slots; RECURRENCE-ID overrides replace or cancel (a
  cancelled master drops). Floating times read as America/Toronto;
  Windows TZIDs map to their IANA names; unknown zones fall back to
  Toronto.
- Only occurrences overlapping `[now − 7 d, now + 120 d]` are kept; the
  DOM observe path uses the same window. `state.events` = own ICS events
  ∪ DOM-read events of other kinds still in-window, deduped
  (title+startAt, own wins), capped at 3000 nearest to now.
  `state.ics = {at, calendars, events}` — counts only.
- **Fallback:** `settings.sources.gcal.icalUrls` — secret iCal addresses
  the user pastes in Setup (validated against
  `^https://calendar\.google\.com/calendar/ical/`, used only when the
  export fails, parsed the same way). They live in local settings, are
  never logged, and never reach items, evidence or state.

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
  the decoded event id already says `own` — and `Calendar: Waterloo
  All-in-1` (or a `<CODE> · <Label>` feed title) marks it `wa1`, our own
  feed, which never suppresses the items it came from. A non-own chip with
  no `Calendar:` segment is `unknown` — the event id alone (even `@import`)
  can't prove which feed it came from.
- **Dedupe** is lowercase title + startAt; on a tie the better calendarKind
  wins (own > wa1 > subscribed > unknown), so an open popup merges with its chip
  and a multi-day event's one-chip-per-day cells collapse to one event.

## calendarKind (data-eventid)

`data-eventid` decodes (base64, url-safe tolerant, padding optional) to
`"<eventId> <calendarId>"`:

| calendarId | kind |
|---|---|
| the signed-in address (incl. the `@m` → `@gmail.com` shorthand) | `own` |
| `@group.calendar.google.com` (but not `group.v.`) | `own` |
| `@import.calendar.google.com` (this is what our own feed subscription looks like) | `subscribed` — `wa1` when the label/title identifies it as Waterloo All-in-1 |
| `group.v.calendar.google.com` (holidays etc.) | `subscribed` |
| any other address | `subscribed` |
| undecodable / missing | `unknown` |

The signed-in address is read with email's `accountEmail` (`a[aria-label^="Google Account:"]`) — compare only, never serialised.

## observe.parse / state

`observe.parse` validates each event (string title ≤ 200, valid ISO startAt,
optional valid endAt, boolean allDay, known calendarKind) and maintains:

```js
state = { events: GcalEvent[], lastSeenAt, ics? }
```

`events` = previous events **minus** those whose `startAt` falls inside the
new `range` — only when the payload's `settled === true` (the content
script marks a read settled once the grid's chip set is unchanged for
1.5 s, or 5 s for an empty grid; an unsettled read merges without ever
deleting) — **plus** the new events; deduped (own wins), kept inside
`[now − 7 days, now + 120 days]` (same window as the export read), sorted
by startAt, capped at 3000 (nearest to now kept). Result is always
`{items: [], complete: true, readOk: ["gcal"], scope: "gcal", state}`;
bad JSON → `{items: [], complete: false, scope: "gcal", state: prev}`.

The content script re-sends the last read at least every 30 min
(heartbeat) so an open tab keeps `lastSeenAt` fresh even when nothing
changes.

## Probe / checklist

`probe(doc, href)` → `{page, counts, ok, hints}` backs W1's "Check readers"
screen — counts only, no text or ids. Pages: `gcal-day`, `gcal-week`,
`gcal-month`, `gcal-schedule`, `gcal-other`, `unknown`. Counts: `eventChips`,
`labeled` (chips `parseChipLabel` accepts), `decodedIds`, `own`/`subscribed`/
`wa1`/`unknown` (the extract's kind split), `detailPopup` (0/1), `account` (0/1).
`ok` = a view page with `labeled > 0`. `CHECKLIST` is the open-these-pages
list (`{id, label, how, page}`).

## Handoff notes for W1

- The extract shape above is what `payload.body` contains (JSON-stringified);
  `state.events` is the merged shape described under "observe.parse / state".
- `suppressAgainstCalendar` compares **`own` + `subscribed`** events — never
  `wa1` or `unknown`. `wa1` is our own feed (the "Calendar: Waterloo
  All-in-1" chip label, an ICS `X-WR-CALNAME`/`PRODID` saying so, a feed-url
  host, or defensively any `<CODE> · <Label>` title); it must never suppress
  the items it republishes. Stored `subscribed` events carrying the feed
  title migrate to `wa1` on the next read.
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
