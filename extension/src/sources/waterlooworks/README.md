# WaterlooWorks adapter

WaterlooWorks is Orbis with a Vue UI: every data load is a POST with a
per-session encrypted `action` token, so background fetch (T1) and tab-relay
replay (T2) can't reproduce them. This adapter is **T3 only**:

- Window 1's recorder forwards page-network responses whose URL matches
  `OBSERVE_PATTERNS` (see `selectors.js`) as `kind: "net"` ObservedPayloads.
- `content.js` (no imports, no requests) snapshots the rendered DOM —
  h1–h4, tables, and label/value blocks under `/myAccount/` — as
  `kind: "dom"` payloads, throttled and hash-deduped. Snapshots mark the root
  element `data-wa1-complete="1"` once `readyState === "complete"` and 3 s
  have passed since load; an incomplete snapshot never flags `needsUpdate`.
- Both land in `observe.parse`, which renders HTML through
  `ctx.parseHtml(body, "waterlooworks/parseAll", {url})` → `parsers.js`
  (pure functions, offscreen document).

## What each page yields

| Page | Section | Yields |
|---|---|---|
| `co-op/full/applications.htm` | applications grid | `Application[]` (status via `status.js`), diffed by `diff.js` → `state.applications` + `SyncResult.updates`. Grids opened filtered to one status ("View") are normal — absent apps are carried, never treated as removed |
| `co-op/full/interviews.htm` | interviews list | `Item[]` type `interview` (startAt from "Interview Date / Time"; cancelled when schedule/confirmation says so) |
| `interviews.htm` detail view | interview detail | booked → same `interview:<jobId>` item enriched (When/Where/interviewer/method/instructions); unbooked + available slots → `timeslot:<jobId>` deadline item (earliest slot −24 h, WW's own auto-pick rule) |
| `dashboard.htm` | event registrations | `Item[]` type `event` |
| `dashboard.htm` | messages inbox | `state.messages` (≤50, newest first; `{subject, receivedAt, from, priority}`) + pending Review items for dates in subjects |
| `co-op/full/jobs.htm` | posting | `Item` type `application-deadline` while the deadline is in the future; `fields` keeps short label/value pairs |
| message detail | message detail | `state.messageDetails` (≤50, deduped by subject+createdAt, metadata only) + pending Review items for dates in subject+body. `bodyText` is transient — **never persisted**; each item stores only the ≤300-char sentence with the date |
| rankings tab | rankings | `state.rankings = {term, open, note, at}` — open-layout unknown, comment in `parsers.js` |
| `/notLoggedIn.htm` | session | `session: "signed-out"`, cached items kept |
| `uwaterloo.ca/co-operative-education/important-dates` (sync, daily) | coop-dates | `Item[]` type `cycle-date` (`review:"auto"`): postings open/close, interview ranges, rankings, match results, work-term dates, direct offers |

**Message dates.** `messageDateItems` (map.js) runs `ctx.textDates`
(extractDates) over `subject + "\n" + bodyText` for a detail read, or the
subject alone for an inbox row, with `now` = the message's send time (so
relative dates resolve from when it was sent) and `termCode` from
`termCodeFor`. Hits below 0.6 confidence or more than a day before `sentAt`
are dropped. Items are `review: "pending"`, `confidence: "tentative"`, keyed
by `hashString(normalizedSubject | torontoDay(sentAt))` — the inbox row and
the detail page hash to one key, so a later read of either replaces that
message's items instead of duplicating. `lastGood["message-dates"]`
accumulates per message key (60-day prune, cap 300).

The detail scopes share item ids with the list scope; the adapter merges by id
(detail wins for `startAt`/`endAt`/`location`/`meta.prep`, `details` lines are
concatenated de-duplicated, list first).

**Unified scope.** Every WW item reports `seenIn[].scope = "waterlooworks"` and
every `observe.parse` result returns `scope: "waterlooworks"` (plus
`readOk: ["waterlooworks"]` when any section read). W1's scope-mode fold drops
stored items whose `seenIn` scope equals the result scope, so one scope makes
the adapter's `lastGood` union authoritative — the returned `items` are always
the full current picture, on every return path (JSON body, signed-out,
incomplete DOM included). Per-section detail lives only inside state, keyed by
the `detectPage` names.

**Per-job accumulation.** `posting` and `interview-detail` pages describe one
job each, so `lastGood` for those scopes accumulates: a read replaces only that
job's items (a posting with no future deadline removes its old deadline item; a
booked detail removes its timeslot item). Stale items are pruned at 14 days
(postings, by `dueAt`) / 30 days (details, by `endAt||startAt||dueAt`), capped
at 200 items per scope (oldest dropped). `interviews` and `events` are whole
tables → plain replace.

## Adapter state

```js
{
  applications: Application[],         // after diffApplications
  // item scopes, keyed by detectPage names:
  lastGood:    { interviews, "interview-detail", events, posting,
                 "message-dates", "coop-dates":
                   { items: Item[], at: string } },
  coopDates:   { fetchedAt },          // 24 h throttle for the public page
  needsUpdate: { [section]: true },    // expected section missing on a loaded page
  lastReadOk:  string[],               // sections that read OK on the last payload
  lastSeenAt:  string,
  messages:    [{ subject, receivedAt, from, priority }],
  messageDetails: [...],               // see privacy note above
  rankings:    { term, open, note, at },
  signedOutAt: string,
  lastJsonAt:  string,                 // WW POSTs return JSON we can't map yet
}
```

`sync()` (`intervalMinutes: 1440`) returns the cached union with
`session: "no-tab"`. It also fetches the public co-op important-dates page
(plain GET — the only request this adapter makes) at most once per 24 h
(`state.coopDates.fetchedAt`), parses it via `waterlooworks/parseCoopDates`,
and caches the mapped items in `lastGood["coop-dates"]`. A successful read
returns `complete: true` — the union is authoritative, so a date removed from
the page drops out; on failure/throttle `complete: false` keeps the cache.
Application Updates ride on
`SyncResult.updates` (never persisted): ids are replay-stable —
`<appId>:<status>` for a status change, `<appId>:new` for a first-seen
application — so the core's id-based dedupe makes replays free.

## Settings

- `coopDates: false` — disables the daily important-dates fetch.
- `coopDatesUrl` — overrides the page URL (default
  `https://uwaterloo.ca/co-operative-education/important-dates`).

## Co-op cycle dates

`parseCoopDates` reads the month-calendar `<details>` blocks
("<Month> <Year> calendar of dates"): each cell's first line is the day,
a strong-only line is the cycle label for the events that follow,
"Application limit" lines are skipped, and "9 a.m."/"2 p.m."/"noon"/"by end
of day" give `time`/`endOfDay`. `coopDateItems` keeps co-op lines (holidays,
classes and exams drop out), collapses a cycle's "Interviews" days into one
all-day range per work term (exclusive-midnight end), and builds date-free
ids (`waterlooworks:cycle:<workTerm>:<cycle>:<category>` + `-2` collision
suffixes) so a moved date stays the same item. `workTerm` comes from the
entry's month: Sep–Dec Y → Winter Y+1, Jan–Apr → Spring Y, May–Aug → Fall Y.

## Still unknown

- The grids' JSON response shape (recorder should capture one; `parse`
  stores `lastJsonAt` and returns empty until it exists).
- Posting page layout beyond label/value pairs (labels seen so far are in
  `selectors.js`; new ones fall through to `fields` automatically).
- Whether the slot-pick deadline is exactly "24 h before the first slot" —
  implemented from WW's own auto-pick message.
- Offers/employment records beyond the applications grid statuses.
- Open-rankings layout.
- Job posting links — WW links need session tokens, so items carry no `url`.

## Interview prep available now

`meta.prep` on interview items: `format`/`method`, `location`/`where`,
`interviewer`, `interviewType`, `bookingPermission`, `confirmedAt`,
`instructions`, `postingTitle`, `jobId`, `employer`.

## Maintaining

**Where the selectors and regexes live.** `selectors.js` holds every URL
pattern (`OBSERVE_PATTERNS` for the recorder), the page-detection regexes
and the per-section CSS selectors/label lists. `parsers.js` holds the
text regexes (logged-out wording, slot/row formats, the co-op calendar
layout) — new page wording goes there, not in `index.js`. `map.js` turns
parsed sections into Items and owns the `meta.facts` lists; `status.js`
owns the application-status vocabulary; `dates.js` the Toronto-local
conversions.

**Turning a saved page into a fixture.** Save the rendered page (or copy
the network body from a capture), redact, then drop it into
`test/fixtures/waterlooworks/`. Redaction rules: no names, emails,
student numbers or employer contacts; no message bodies (placeholder
sentences only); no session material — WW embeds encrypted `action`
tokens in every form/link, strip or replace them; job ids, titles and
rooms may stay as placeholders (`400001`, "Employer A"). Raw captures
stay outside git in `captures/` (gitignored).

**Tests.** `node --test "test/waterlooworks/*.test.js"` runs everything;
one file at a time with `node --test test/waterlooworks/<name>.test.js`.
`parsers.test.js` — each section parser against its fixture;
`map.test.js` — item mapping and `meta.facts`; `diff.test.js` —
application status diffs; `dates.test.js` — Toronto conversions;
`status.test.js` — status normalization; `adapter.test.js` — end-to-end
parse/sync including the accumulator caps; `fuzz.test.js` — ~300
deterministic malformed payloads plus a 1000-read growth bound.

**Open / needs tuning.** The grids' JSON response shape is still unknown
(the recorder should capture one; `lastJsonAt` is stored meanwhile).
Offers/employment records, the open-rankings layout (only
`rankings-closed` is captured), posting fields beyond the known labels
(new labels fall through to `fields` automatically), and whether the
auto-pick deadline is exactly 24 h before the first slot.
