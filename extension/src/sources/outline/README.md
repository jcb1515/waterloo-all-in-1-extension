# outline adapter

Reads Waterloo course outlines (outline.uwaterloo.ca) — the published course
syllabus pages — into contract `Item`s and `Course`s. One outline page covers a
whole course: class meetings, scheduled midterms, grading schemes, deadline
charts, weekly topics and office hours.

The adapter is a thin pipeline, same shape as `learn`:

- `parsers.js` — pure DOM → data (`parseOutline(document)`). Runs in the
  offscreen document; no `chrome.*`.
- `expand.js` — pure data → items/course (`buildOutline(data, opts)`,
  `readingWeeksOf(data, opts)`, `weeksOf(data, opts)`). No DOM, no `chrome.*`.
- `index.js` — fetches pages (`ctx.fetch`), parses them
  (`ctx.parseHtml`), then expands.
- No `content.js`: outline pages are public — no session, no scraping in-page.
- **W1's offscreen registry must expose `parsers.js` exports as
  `"outline/<exportName>"`** (e.g. `"outline/parseOutline"` for `parseOutline`),
  like it does for `learn/*`.

## Settings

```js
settings: {
  "outline": {
    urls: ["https://outline.uwaterloo.ca/viewer/..."],   // extra outline pages
    files: [{ name: "math117.html", html: "<html>..." }],// saved/pasted pages
    sections: { "MATH 117": ["LEC 002", "TUT 104"] },    // picked sections
    groups:   { "ECE 190": 5 },                          // project group number
    officeHours: true                                    // emit OH series
  }
}
```

- `urls` is unioned with `ctx.courses[].outlineUrl` (Learn TOC links feed it).
- `files` parses saved HTML directly — no fetch.
- `sections[course]` selects which `LEC/TUT/LAB/SEM` rows expand; it's unioned
  with `ctx.courses[code].sections`. With no selection, no classes are emitted
  (a `ctx.log` explains why) — TST exams still emit.
- `groups[course]` picks the matching `Grp a-b:` deadline line in deadline
  charts; with no group, every group line becomes its own `review:"pending"`
  item with a `:g<a>-<b>` id suffix.
- `officeHours` gates the (noisy, pending-review) office-hours series.

## What gets extracted

| DOM | → items |
|---|---|
| `figure.schedule-info` rows for picked sections | `type:class|tutorial|lab`, `category:lecture|tutorial|lab|seminar`, one item per occurrence |
| Schedule rows with single `dates` (no ranges) | `category:"make-up"`, title "Make-up lecture" |
| `[TST]` rows (all sections) | `type:exam`, `category:midterm`, timed, exact |
| Grading-scheme `table.multitable` rows with a parseable date | classify → `startAt/endAt` (exam/quiz/presentation) or `dueAt`; timed = `exact`, all-day = `tentative` |
| Deadline tec-tables (header has a Deadline column) | `dueAt` items; `Grp a-b:`/`All groups:` split per `groups` setting |
| Prose/plan-cell lines with a date + a due/on/quiz/exam trigger word | `tentative`, `review:"pending"` items |
| Office-hours lines (`Tuesdays 10:30am - 12:30pm in EIT 3114`) | weekly `event`/`office-hours`, tentative+pending |

## Item ids

```
outline:MATH117:LEC002:2026-09-14T12:30   class occurrence (kind+section, date+time)
outline:MATH117:exam:midterm[-N]          TST exams (-1/-2 when several)
outline:MATH117:assess:<slug(component)>  grading-scheme rows
outline:ECE190:due:<slug(title)>[:g1-20]  deadline-chart rows
outline:ECE105:text:<slug(title)>[-2]     prose items
outline:ECE190:oh<N>:YYYY-MM-DD           office-hours series
```

## Confidence and review

- **exact + auto**: schedule rows (dates come straight from Quest's ranges),
  TST exams, timed assessment/chart dates.
- **tentative + auto**: all-day assessment dates and windows (e.g. "December 10
  - 23" → all-day start/end, `meta.window`), which end-of-day `dueAt`s can't
  pin down.
- **pending**: prose hits (`method:"text"`), group-split items emitted without
  a chosen group, `weekdayMismatch` hits, and TST rows whose schedule date
  disagrees with the assessment table (`meta.conflict` carries the other date).
- Assessment rows with no parseable date ("TBD", "Near Weekly") emit no item
  but stay in `course.assessments` with `itemId:null`.
- Prose duplicates of scheduled exams are dropped when an exact item of the
  same category exists on the same Toronto date.

## Reading week

Quest schedule ranges often include reading week (e.g. "Sep 9 - Oct 20, Oct 28
- Dec 8" skips midterm week, not Oct 12-16). `readingWeeksOf` collects the real
week: plan-table rows labelled "Reading week" (label dates, else the
calendar-week rule — week 1 is the Mon–Sun week containing the first LEC) and
prose lines that produce a multi-day hit. The adapter unions these across all
outlines plus `ctx.terms[].readingWeek` and passes them to `buildOutline`;
every occurrence inside a reading week is skipped (classes and office hours).

## Privacy

Pages contain instructor names and emails. The adapter keeps them in
`data.text.team` for office-hours/office parsing only — names never reach item
fields beyond `location`/`details` (week topics). Test fixtures are redacted by
`test/fixtures/outline/redact-outlines.mjs` (no `@uwaterloo.ca`, names →
"Instructor").

## Course extras

`course` extends the contract Course: `term`, `sections`, `outlineUrl`,
`weights` (first grading scheme's weighted rows), `assessments` (every
table/chart row: `{component, weight, dateText, itemId, from}`), and
`gradingSchemes` when a page defines more than one.

## VERIFY (unconfirmed against live pages)

- Section pickers use the DOM `"LEC 002"` format; settings must match.
- `TUT`/`LAB`/`SEM` row shapes are assumed identical to `LEC` (same cells).
- `Grp a-b:` parsing assumes that literal prefix in deadline cells.
