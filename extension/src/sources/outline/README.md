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
- `index.js` — fetches pages (T1 `ctx.fetch`, T2 `ctx.relay`), parses them
  (`ctx.parseHtml`), then expands.
- `content.js` — passive DOM snapshotter (T3) on `/viewer/view/` pages.
- **W1's offscreen registry must expose `parsers.js` exports as
  `"outline/<exportName>"`** (e.g. `"outline/parseOutline"` for `parseOutline`),
  like it does for `learn/*`.

## Reads (tiers)

outline.uwaterloo.ca sits behind UW SSO (Duo) — it is *not* public.

- **T1** `ctx.fetch(url)` — works while the SSO cookie is valid.
- **T2** `ctx.relay("https://outline.uwaterloo.ca", path)` — the generic
  recorder answers in an open outline tab; tried only when T1 failed *and* the
  URL's host is `outline.uwaterloo.ca`.
- **T3** `content.js` on `/viewer/view/` pages sends the rendered
  `documentElement.outerHTML` as a `wa1:observed` payload (at load, debounced
  1.5 s on mutations, hash-deduped, max 5 sends, bodies over 3 MB skipped).
  `observe.parse` runs `parseOutline` on it, expands with the same options as
  sync, and records `state.seenUrls[code] = url` so a later sync refetches
  pages the student actually visited.
- **Files** (`settings.files`) — saved HTML parsed directly, no fetch; a
  `{name, text}` entry (pre-extracted PDF text) goes to `parseSyllabusText`
  instead (see below).

## Network

While **any** `outline.uwaterloo.ca` tab is open and not frozen,
`content.js` runs an in-tab fetch round (`outlineRound`, same shape as
Portal's): it read-only-loads `chrome.storage.local` (`courses[*].outlineUrl`
— written by Portal enrollments — plus `wa1Settings.sources.outline.urls`),
keeps only `https://outline.uwaterloo.ca/viewer/view/…` urls (deduped by
origin+pathname), and GETs each sequentially with `credentials: "include"`
and a 15 s timeout. Every page replays as the same `wa1:observed`
`kind:"dom"` payload the passive snapshotter sends, so `observe.parse`
expands it identically — this is how outlines the student never opens get
read (the daily background sync only sees `settings.urls`).

A sign-in page (401/403, a redirect off the outline host, or an
`LOGIN_WORDS` body) stops the round and sends nothing further; any other
failure skips that URL. Throttle is a `sessionStorage` stamp
(`wa1:outline:lastFetch`, `{at, ok}`): at most one round per 6 h per tab,
5 min retry after a failure, plus a 2 min in-progress marker
(`wa1:outline:inProgress`) so two loads can't race. Rounds are resumable
across tab freezes — a Page Lifecycle `freeze` bumps a generation, the
in-flight URL re-issues once on resume, and its late settle is dropped.

No tokens, no `chrome.storage` writes anywhere — the static test fails on
any `fetch(` outside `content.js` or any non-`viewer/view/` request.

## PDF syllabi

Some courses (e.g. ENGL 192) have no outline page — only a PDF syllabus.

- `pdf.js` `pdfText(bytes)` — `pdfjs-dist` (legacy build) → plain text; lines
  are rebuilt from text-item y-positions/`hasEOL`, pages joined with `\n\n`.
  Environment-neutral (no DOM, no `chrome`); intended to run on the options
  page at file-pick time — **W1 wiring request is open**.
- `syllabus.js` `parseSyllabusText(text, {now, termCode, sections})` — pure
  text → `{code, term, section, room, title, items, course, skippedClasses}`.
  Ligatures are normalised. It reads the header (`ENGL 192: …`,
  `Fall 2026 | Section 008 | Room: DWE 1515`, `Class Hours: T/Th, 1:00pm-
  2:20pm`), expands class meetings between the first and last "Course
  Schedule" week dates minus `/no class/` lines (reading week, midterm week),
  and maps "Outline of Assignments" + `Complete…:`/`Attend…:` schedule lines
  to items. Single dates → 23:59 `dueAt` (exact/auto, `meta.timeAssumed`);
  ranges → all-day windows (tentative/pending, `meta.window`). Schedule lines
  whose Toronto day/window and title-or-weight match an existing assessment
  merge into it rather than duplicating. All evidence is `method: "text"`.
- Classes are emitted only when `settings.sections[code]` is empty or
  contains `"LEC <section>"` — otherwise they're counted in
  `skippedClasses` and logged. "By appointment" office hours emit no series.
- Assumptions: the `Assignment N: <title>—<w>% … | Due: <date>` outline shape,
  the `Complete/Attend:` schedule convention, and a `… Grade Breakdown` list
  for `course.weights`. Non-ENGL-192-style syllabi may parse partially.
- `settings.files` accepts `{name, html}` (outline page) or `{name, text}`
  (syllabus text). A syllabus's items/course join the result directly; its
  code goes to `readOk`, and a bad text file sets `complete: false`.
- Fixture: `test/fixtures/outline/ENGL192-syllabus.txt` is generated by
  `redact-syllabus.mjs` from the raw capture (names → "Instructor", emails →
  `{email}`); the raw PDF/txt stay outside git.

`isLoginShell(res)` recognises an SSO detour: `loginRedirect`, a final URL off
`outline.uwaterloo.ca`, or a 2xx body matching
`/duo|shibboleth|saml|oidc|adfs|idp\.uwaterloo|sign[ -]?in|log[ -]?in/i`.

`session` in the SyncResult: `"signed-in"` when any URL read succeeded, else
`"signed-out"` when a login shell was seen, else absent. A failed URL sets
`complete: false` and stays out of `readOk`, so stored items from it are kept.
`state` is always returned (`{...prev, seenUrls}`).

## Settings

```js
settings: {
  "outline": {
    urls: ["https://outline.uwaterloo.ca/viewer/..."],   // extra outline pages
    files: [{ name: "math117.html", html: "<html>..." },// saved/pasted pages
            { name: "engl192.txt",    text: "..." }],    // PDF-syllabus text
    sections: { "MATH 117": ["LEC 002", "TUT 104"] },    // picked sections
    groups:   { "ECE 190": 5 },                          // project group number
    officeHours: true                                    // emit OH series
  }
}
```

- `urls` is unioned with `ctx.courses[].outlineUrl` (Learn TOC links feed it).

## Section precedence

The profile's `settings.sections` are defaults; Portal's enrollment sections
win. `pickSections(profile, portal)` groups both lists by component kind
(LEC/TUT/LAB/SEM/TST): kinds Portal lists use Portal's sections, kinds it
doesn't fall back to the profile. When both list a kind and disagree, the
pick emits a `SyncResult.updates` entry (`kind: "review"`, id
`outline:section-mismatch:<CODE>:<kind>:<portal>|<profile>`) so the panel can
flag the stale profile. Outline/syllabus `Course` objects deliberately carry
**no** `sections` — Portal is the only writer of that field, so a stale
profile choice can never resurrect an old section's classes.
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
`data.text.team` for office-hours parsing, and the schedule table's
`.instructor-info` name lands in `meta.facts` on class items (the "Instructor"
fact below). Names still never reach `location`/`details` or the evidence
snippet. Test fixtures are redacted by
`test/fixtures/outline/redact-outlines.mjs` (no `@uwaterloo.ca`, names →
"Instructor").

## `meta.facts`

Class/tutorial/lab items carry `meta.facts` (shared `factsOf` in
`learn/classify.js`): `Instructor` (the `.instructor-info` cell, rowspan-aware),
`Week topic` (the same text as `details` from the plan table), and `Office
hours` (the first team-text line the office-hours parsing reads — also
`course.officeHours`). Midterm/final items that got an exam-coverage note carry
a `Covers` fact with it. Syllabus classes carry `Instructor` (the
`Instructor:` header line) and `Office hours` (the `Office Hours:` header line,
which also becomes `course.officeHours`).

## Course extras

`course` extends the contract Course: `term`, `outlineUrl`, `officeHours`
(first office-hours line), `weights` (first grading scheme's weighted rows),
`assessments` (every table/chart row: `{component, weight, dateText, itemId,
from}`), and `gradingSchemes` when a page defines more than one. `sections`
comes only from `ctx.courses` (Portal) merged with `settings.sections` via
`pickSections` — Portal wins per component kind and a disagreement emits a
review `update`.

## VERIFY (unconfirmed against live pages)

- Section pickers use the DOM `"LEC 002"` format; settings must match.
- `TUT`/`LAB`/`SEM` row shapes are assumed identical to `LEC` (same cells).
- `Grp a-b:` parsing assumes that literal prefix in deadline cells.

## Probe / checklist

`probe.js` (`probe(doc, href)` → `{page, counts, ok, hints}`) backs W1's
"Check readers" screen — **counts only**, no text or ids. It reuses
`parseOutline`'s selectors: page `outline` needs a `/viewer/view/` URL with
outline content; `login` is a non-outline host or a page without outline
content whose text matches `LOGIN_WORDS` (the same regex `isLoginShell`
uses — real outlines can contain "log in" nav links, so the word match
only counts without `.outline-courses`); `outline-other` is on-host but not
a usable viewer page. `ok` = outline + `title` + (`scheduleRows` or
`assessmentRows`) > 0. `CHECKLIST` is the open-these-pages list for the
Check screen (`{id, label, how, page}`).
