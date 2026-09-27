# lib/textdates — shared text-date extraction

Pulls dated phrases ("due Sunday Sept 20", "Oct. 5-8", "meeting tomorrow at 6pm")
out of outline rows, Learn items, Discord messages and quick-add text. Pure
functions — no DOM, no Node APIs — so it runs in the service worker, offscreen
document, content scripts and tests. Only dependencies: `chrono-node` and `Intl`.

## API

```js
import { extractDates, parseWeekLabel, zonedIso, zonedParts, weekdayOf,
         termYear, termSeason, termCodeFor, inferYear } from "./textdates/index.js";
```

### `extractDates(text, {now, termCode?, tz?}) -> DateHit[]`

`DateHit` is the contract type (`src/core/contract.js`):

```js
{ startAt, endAt?, allDay, text, index, confidence, weekdayMismatch? }
```

- `now` is required context (a `Date`); `tz` defaults to `"America/Toronto"`.
- `startAt`/`endAt` are UTC ISO instants for **wall times in `tz`**, built from
  calendar components with `zonedIso` — results are identical on any machine TZ.
- All-day hits: `allDay: true`, `startAt` = midnight of the first day. A single
  day has no `endAt`; a range's `endAt` is midnight of the day **after** the
  last day (exclusive, like ICS `DTEND`).
- Timed hits: `allDay: false`; `endAt` only when an end time was written.
- `index`/`text` point into the original input:
  `text.slice(h.index, h.index + h.text.length) === h.text`. Hits are sorted
  by `index` and never overlap.
- `weekdayMismatch: true` is set when a written weekday contradicts the written
  date ("Thursday, October 27th" — Oct 27 2026 is a Tuesday). The date wins.

### `parseWeekLabel(text, {now, termCode?}) -> {n, start, end} | null`

Reads outline week-table labels. `start`/`end` are inclusive `YYYY-MM-DD`
strings; `"Week 3"` alone gives `{n: 3, start: null, end: null}`. Returns `null`
for spans ("Week 3-4.5"), missing numbers ("Week (2026)") and non-week text.

### tz helpers

- `zonedIso(y, m, d, h?, mi?, tz?) -> string` — UTC ISO instant of that wall
  time. Fall-back ambiguity resolves to the earlier instant; spring-forward gaps
  shift forward (02:30 -> 03:30 EDT).
- `zonedParts(date, tz?) -> {y, m, d, h, mi, weekday}` — wall components.
- `weekdayOf(y, m, d) -> 0..6` — pure calendar math, 0 = Sunday.

### term helpers

- `termYear(code)`, `termSeason(code)` — 1269 -> 2026 / "fall".
- `termCodeFor(date)` — term containing `date` by Toronto wall date
  (Jan–Apr -> 1, May–Aug -> 5, Sep–Dec -> 9).
- `inferYear(month, day, {now, termCode?})` — the candidate year
  (termYear ± 1, or now's Toronto year ± 1) whose date is closest to the term
  midpoint (winter Mar 1, spring Jul 1, fall Nov 1) or to `now`.

## Confidence rubric

| Written form                              | base  | extras                              |
|-------------------------------------------|-------|-------------------------------------|
| month + day ("Sept 20", "Oct. 5-8")       | 0.80  | +0.10 time, +0.05 explicit year,    |
|                                           |       | +0.05 written weekday that matches  |
| alternatives ("Dec 7/8")                  | 0.60  | +0.10 time                          |
| relative / weekday-only ("tomorrow",      | 0.55  | +0.10 time                          |
|   "friday")                               |       |                                     |

`weekdayMismatch` caps the score at 0.35; all scores cap at 1 and are rounded
to 2 decimals. Ranges take their start side's score.

## Examples

```js
extractDates("Quiz #1 Friday Sept 18", {now, termCode: 1269})
// -> [{ startAt: "2026-09-18T04:00:00.000Z", allDay: true,
//       text: "Friday Sept 18", index: 8, confidence: 0.85 }]

extractDates("Final Exam | December 10 - 23 | 53%", {now, termCode: 1269})
// -> [{ startAt: "2026-12-10T05:00:00.000Z", endAt: "2026-12-24T05:00:00.000Z",
//       allDay: true, ... }]

extractDates("meeting tomorrow at 6pm", {now})   // now = Sat Sep 26 2026 noon EDT
// -> [{ startAt: "2026-09-27T22:00:00.000Z", allDay: false, confidence: 0.65 }]

parseWeekLabel("Week 5(Oct 5-11)", {now, termCode: 1269})
// -> { n: 5, start: "2026-10-05", end: "2026-10-11" }
```

## Notes for maintainers

- chrono parses against a **fake-local reference Date** built from
  `zonedParts(now, tz)`, so "tomorrow"/"friday" resolve in Toronto wall time no
  matter what TZ the machine is in. We then rebuild instants from the parsed
  components, never from chrono's Date objects.
- The input is normalised (en/em dashes -> `-`, digit–Capital glue like
  `Oct 6Grp` -> `Oct 6 Grp`) through a per-character offset map so `index`/`text`
  still refer to the original string.
- On top of chrono we add: bare-day range ends (`through 27`, `& 20`, `/8`),
  times in parentheses or after `at`/`by`/`before` ("`(8:30am)`",
  "`(before 11:59pm)`"), and a fix for glued group labels (`Grp 1-20: Tue Oct 6`,
  where chrono reads "20:" as a time).
- Results are kept only when the matched text contains a month name, weekday
  name, relative day word or ISO date — chrono's bare numeric parses
  ("11-26", "7.5") and time-only fragments are dropped.
