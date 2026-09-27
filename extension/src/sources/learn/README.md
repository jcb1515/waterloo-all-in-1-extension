# Learn adapter (`learn`)

Reads Waterloo Learn (Brightspace/D2L) and returns a contract `SyncResult`. The
adapter wraps `LiveSource` (`live-source.js`, WATnow code, MIT Eric Zou): the
contract's `ctx.fetch` (T1) is injected as its `transport` and `ctx.relay` (T2)
as its `relay`, so session detection, rate limiting and every read keep their
WATnow behaviour. `source.js` / `demo-source.js` / `fixtures.js` belong to the
older background and are untouched.

## Settings slice keys

- `liveBaseOverride` — alternate Learn origin (the local test harness uses it;
  see `liveBase()` in live-source.js). Default `https://learn.uwaterloo.ca`.

## Reads and scopes

Per course org unit (`<ou>`), `readOk` lists every scope that read completely:

- `<ou>:dropbox` — folders + category names + my submissions
- `<ou>:quizzes` — quiz list
- `<ou>:discussions` — forums + topics
- `<ou>:feed` — cross-course `myItems` feed + completions
- `<ou>:calendar` — cross-course `myEvents` calendar
- `<ou>:news` — published, non-hidden announcements
- `<ou>:grades` — grade objects, categories, `myGradeValues` (all three must read)
- `<ou>:toc` — content table of contents

`complete` is true only when the session was fine and every tool, feed,
calendar, news, grades and toc read succeeded for every kept course. Individual
post/attempt checks are fail-soft and do not affect `complete`.

## Session

`checkSession()` asks `whoami` on the worker first, then through an open Learn
tab. Results: `signed-in` (sync ran), `signed-out`, `no-tab` (worker unsigned
and no tab to ask), `unreachable`. A signed-out failure mid-sync returns
`{items: [], complete: false, session: "signed-out"}`.

## Item ids

- `learn:<ou>:<kind>:<toolId>` — kind ∈ `dropbox|quiz|discussion|content`; a
  plain calendar event is `content` with `cal<CalendarEventId>`.
- `learn:<ou>:news:<newsId>:<startAt>` — a date pulled out of an announcement.

`seenIn` entries use scope `<ou>:<tool>`; a merged feed row adds `<ou>:feed`.

## What goes to Review

Only announcement items (`review: "pending"`, `confidence: "tentative"`):
the news title + body is run through `extractDates` and a hit is kept when
confidence ≥ 0.5, the date is not more than a day past, and the hit's sentence
matches `TRIGGER_RE` (due/deadline/moved/exam/… in `classify.js`). Evidence is
just that one sentence (≤ 300 chars, `method: "text"`). All tool items are
`review: "auto"`, `confidence: "exact"`.

## Extra `courses[]` fields (pending contract change)

`LearnCourse = Course & { grades?, syllabusUrls? }`:

- `grades`: per `myGradeValues` entry `{component, category?, points?, max?,
  weight?, display?}`.
- `syllabusUrls`: `[{title, url}]` for TOC topics titled like a syllabus whose
  link ends in `.pdf`.

`weights` stays the contract shape (`{component, weight}[]` from categories,
else grade objects). Item `weight` is filled from `WeightedDenominator` when a
grade value can be matched to an item.

## VERIFY list

- News deep-link shape: `${base}/d2l/le/news/<ou>/<newsId>/view` (assumed).
- Grade↔item linkage: `GradeItemId` on dropbox folders/quizzes and
  `AssociatedToolItemId` on grade objects are assumed; name matching is the
  fallback.
- `myGradeValues` field names (`PointsNumerator`, `WeightedDenominator`,
  `DisplayedGrade`) are as documented; confirm against a real capture.
- Quiz attempts route (`/quizzes/{id}/attempts/`) commonly answers 403 to
  students — handled, but verify whether any student-visible route exists.
- Discussion post `PostingUserId` vs whoami `Identifier` — assumed identical.
