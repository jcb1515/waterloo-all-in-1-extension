# portal adapter

Reads Portal (portal.uwaterloo.ca) — its JSON API
(`portalapi2.uwaterloo.ca/v2/...`) needs a bearer token, so there is no
background fetch tier. `sync` is a `no-tab` stub that only returns the
accumulated state; data arrives two ways:

1. **Passive observe** — the recorder relays API responses the student
   triggers by browsing (unchanged, always on).
2. **Page-load auto-fetch** — `content.js` (registered on
   `portal.uwaterloo.ca/*`) runs a round on every page load and hourly while
   the tab stays open: the four GETs below, replayed to the background as
   the exact `wa1:observed` "net" payloads the passive path would send, so
   `observe.parse` and downstream merging are identical either way.

### Auto-fetch token rules (hard)

- The token is `localStorage["auth.portal.token"]` — the page's own store,
  shared with the content script. It is used **only** as each request's
  `Authorization: Bearer …` header: never stored, never in a message, log,
  payload or extension storage.
- GET only, and **never the account-refresh endpoint** — a refresh we
  trigger could rotate the token and sign the user out of their Portal tab.
- Missing token → nothing is sent and the summary records `no-token`.
  A 401/403 on the **first** endpoint ends the round (signed out); a 401/403
  later in the round skips only that endpoint. Every response — any status —
  replays like the passive path (a replayed 401 marks the session
  signed-out; other failures land as 0-item readStats).
- **Rounds resume where they stopped.** Hidden tabs freeze (a fetch issued
  just before freezing can hang indefinitely), so a round only advances
  while `document.visibilityState === "visible"`, keeps per-endpoint
  progress in module memory, and continues on `visibilitychange`→visible /
  the Page Lifecycle `resume` event — never repeating an endpoint.
- **Throttle is stamped on completion** (`sessionStorage`
  `wa1:portal:lastFetch`): 30 min after a clean round, 5 min when any
  endpoint failed. A `wa1:portal:inProgress` timestamp marker (2 min TTL)
  keeps a second load from racing a live round. Each request has a 15 s
  timeout.
- **Round summary** (`sessionStorage["wa1:portal:lastRound"]`):
  `{at, error?, results: [{path, status, ms, error?}]}` — path-only URLs,
  `error` one of `timeout`/`network`/`no-token`/`http-<n>`; the token is
  never in it.

- `map.js` — pure mappers (rows -> items + course/term patches). No chrome,
  no fetch, no DOM.
- `index.js` — routes payloads by URL path, folds patches into
  `state.courses`/`state.terms`, returns the contract result.
- `content.js` — the auto-fetch round above (`portalRound`/`portalFetchUrls`
  exported for tests; the page wiring is an IIFE that no-ops off-site).
- `parsers.js` — stub; Portal reads are JSON, there is no HTML parser.

## Timestamps

**Every Portal timestamp is Eastern time** (user-confirmed). `portalInstant`
parses `YYYY-MM-DDTHH:mm(:ss)` as America/Toronto wall time via `zonedIso`;
strings carrying `Z` or a `±hh:mm`/`±hhmm` offset are honoured literally.
`torontoDay` is the Toronto `YYYY-MM-DD` of the same instant.

## Observed endpoints

| URL | scope | effect |
|---|---|---|
| `v2/student/CourseSchedule/` | `portal:schedule` | one item per meeting: LEC/SEM/other -> `class`, TUT -> `tutorial`, LAB -> `lab`, TST -> `exam`/`midterm` "Midterm"; unions `<comp> <sect>` sections into `state.courses[code]` |
| `v2/student/ExamSchedule/` | `portal:exams` | exam items; category midterm (matches the Learn midterm rule) else final, ids carry no date so a moved exam keeps its id (`:2`, `:3` only for true duplicates) |
| `v2/student/CourseEnrollments/…` | `portal:enrollments` | no items; patches `state.courses` (sections union, `outlineURL` -> `outlineUrl` with `https://` prepended, `droppedDate` rows skipped). Both the list (`data.courseEnrollmentData[]`) and per-course (`data[]`) shapes are handled |
| `v2/Calendar/DailyEventsV2` | `portal:events:<start>..<end>` | campus `event`s (`category "campus"`, `review "pending"` — the user imports everything into Review) and `term-date`s; cancelled events, empty titles and `ECE 150 LEC 002`-style class echoes are skipped. `class`/`exam` feeds are dropped entirely (CourseSchedule/ExamSchedule own them); `learn`-feed rows become `portal:learn:<hash(title|startDate)>:<day>` deadline/quiz/exam mirrors; other rows take `portal:event:<feedKey>:<hash(title)>:<day>` — `key` is the feed key, so the title hash is what keeps same-day rows distinct |

## Field rules worth knowing

- **All-day events:** `startAt` is Toronto midnight of the start day. A later
  end day at `00:00` is already exclusive; any other end time is inclusive,
  so `endAt` becomes the *next* day's midnight. Same-day all-day rows get no
  `endAt`.
- **Term dates** build `state.terms[termCode]`: `start`/`end` from
  "lectures/classes begin|end" titles, `readingWeek`, `midtermWeek` and
  `examPeriod` as inclusive `{start, end}` ranges (`termCode` from
  `termCodeFor(startDay)`). On the way out, `termWeeks(start, end)` derives
  `weeks` — week 1 runs from `start` to the following Sunday, later weeks run
  Monday–Sunday clipped to `end`, and reading week counts (outlines number
  it). Weeks are computed at read time, never stored in state.
- **Course accumulation.** Scope-mode merges replace `courses`/`terms`
  wholesale, so every successful observe returns the full accumulated lists
  (`Object.values(state.courses)`/`terms`), not just what this payload saw.
- **Item fields:** `source "portal"`, `confidence "exact"`, `status "open"`,
  `evidence.method "api"` with `portal.uwaterloo.ca/academics` (calendar
  events use `.../calendar`), `seenIn[].scope` = the endpoint scope.
- Exam `location` = `"PAC 1-12 · Seat A12"`, `details` = seat instructions,
  `meta.rawTitle` keeps the original title. Event `meta.feed` = the feed
  `name` when `summary` supplied the title.
- **`meta.facts`** (shared `factsOf` in `learn/classify.js`, label <=40 /
  value <=300 chars, <=12 facts, empty values dropped) puts the detail fields
  the calendar renders onto items:
  - Schedule meetings: Instructor (the accumulated names for
    `"<CODE>|<section>"`), Room (`roomDescription`), Section.
  - Exams: Room (`location`), Seat (`seatCode`), Seat instructions, Duration
    (`end - start` as `"2 h 30 min"` / `"3 h"` / `"50 min"`).
- **Instructors accumulate in state.** Enrollments read
  `instructorData[].instructorDetail` (`firstname`/`lastname`/`username`) into
  `state.instructors["<CODE>|<section>"]` (deduped by name, email =
  `username@uwaterloo.ca`) and union `[{name, email, section}]` into
  `state.courses[code].instructors`. An Instructor fact therefore only
  appears on a meeting when enrollments were observed **before** the
  schedule — same caveat for `course.instructors`.

## Failure semantics

- `payload.status` 401/403 → `complete: false`, `session: "signed-out"`,
  `scope "portal:none"`.
- Non-JSON body or `meta.type !== "success"` → `complete: false`, no session.
- An unmatched URL path → `complete: false`, `scope "portal:none"`.

## Fixtures

`test/fixtures/portal/*.json` are **synthetic** — the real API needs a live
student session, so they were hand-written on the field names in
`captures/discovery/portal-discovery-2026-09-27.json` (which ships shapes
only, no values).

## VERIFY (unconfirmed against live responses)

- `componentCode`/`sectionCode` case ("LEC"/"002") is assumed as seen in the
  discovery shapes.
- Recurring events (`rRule`) are treated as one row per occurrence; Portal's
  expansion behaviour is unverified.
- `CourseEnrollments` rows are trusted to carry `courseSubject` +
  `courseCatalogNumber` (not `courseCode`) as the authority.
- **HYPOTHESIS — DailyEventsV2 query params.** The saved app bundle does not
  name the call (the `$api.calendar` service lives in another chunk), so
  `start`/`end` as `YYYY-MM-DD` in `content.js` is inferred from the
  observed URL shape. Confirm the real param names/format on a live page;
  if they differ, fix `portalFetchUrls` — `observe.parse` already reads
  `start`/`end` for its scope.
