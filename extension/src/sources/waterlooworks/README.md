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
| `co-op/full/applications.htm` | applications grid | `Application[]` (status via `status.js`), diffed by `diff.js` → `state.applications` + `state.lastUpdates`. Grids opened filtered to one status ("View") are normal — absent apps are carried, never treated as removed |
| `co-op/full/interviews.htm` | interviews list | `Item[]` type `interview` (startAt from "Interview Date / Time"; cancelled when schedule/confirmation says so) |
| `interviews.htm` detail view | interview detail | booked → same `interview:<jobId>` item enriched (When/Where/interviewer/method/instructions); unbooked + available slots → `timeslot:<jobId>` deadline item (earliest slot −24 h, WW's own auto-pick rule) |
| `dashboard.htm` | event registrations | `Item[]` type `event` |
| `dashboard.htm` | messages inbox | `state.messages` only (≤50, newest first; `{subject, receivedAt, from, priority}`) — message → Review items is Phase 2 |
| `co-op/full/jobs.htm` | posting | `Item` type `application-deadline` while the deadline is in the future; `fields` keeps short label/value pairs |
| message detail | message detail | `state.messageDetails` (≤50, deduped by subject+createdAt). **Body, To and Created By are never extracted or stored** |
| rankings tab | rankings | `state.rankings = {term, open, note, at}` — open-layout unknown, comment in `parsers.js` |
| `/notLoggedIn.htm` | session | `session: "signed-out"`, cached items kept |

The detail scopes share item ids with the list scope; the adapter merges by id
(detail wins for `startAt`/`endAt`/`location`/`meta.prep`, list otherwise).

## Adapter state

```js
{
  applications: Application[],         // after diffApplications
  lastGood:    { [scope]: { items: Item[], at: string } },  // item scopes
  needsUpdate: { [scope]: true },      // expected section missing on a loaded page
  lastUpdates: Update[],               // Update hand-off — the core reads these
                                       // from state until W1 decides otherwise
  lastSeenAt:  string,
  messages:    [{ subject, receivedAt, from, priority }],
  messageDetails: [...],               // see privacy note above
  rankings:    { term, open, note, at },
  signedOutAt: string,
  lastJsonAt:  string,                 // WW POSTs return JSON we can't map yet
}
```

`sync()` only returns cached items + `complete:false` + `session:"no-tab"` —
the core surfaces "open WaterlooWorks to refresh".

## Settings

None yet.

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
