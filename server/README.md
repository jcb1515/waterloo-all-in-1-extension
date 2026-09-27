# Waterloo All-in-1 calendar feed

Cloudflare Worker + D1 that turns the extension's merged item list into private,
subscribable `.ics` feeds. The extension publishes items (POST/PUT); Google
Calendar, Apple Calendar, Outlook, etc. subscribe to the returned URLs (GET).

Based on gurshh-rain/uwlearn_assignment_extension `calendar-service`
(MIT, Gurshaan Gill). Legacy v1 assignment payloads and stored rows still work.

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/v1/calendars` | — | Create a feed. 201 → `{feedId, updateToken, feedUrl, groupFeeds, expiresAt, accepted, skipped}` |
| `PUT` | `/v1/calendars/<feedId>.ics` | `Authorization: Bearer <updateToken>` | Republish. Same response minus `updateToken`; refreshes expiry and backfills group aliases |
| `GET` | `/v1/calendars/<feedId>.ics` | URL itself | `text/calendar` feed (main id or a group alias id); `ETag` + `If-None-Match` → 304; `Cache-Control: private, max-age=900` |
| `DELETE` | `/v1/calendars/<feedId>.ics` | `Authorization: Bearer <updateToken>` | Delete feed + aliases → 204 |
| `GET` | `/health` | — | `{ok: true, feeds: <live feed count>}` |

Group alias ids are read-only: PUT/DELETE on them returns 404. Expired feeds
return 410 and are deleted (a daily cron also purges expired feeds and orphan
aliases). Feeds expire one year after their last PUT; PUT refreshes the timer.

## Publish payload (v2)

```json
{
  "version": 2,
  "calendarName": "Waterloo All-in-1",
  "timeZone": "America/Toronto",
  "alarms": { "deadline": [30, 1440], "exam": [1440] },
  "events": [
    {
      "id": "learn:1234:5678",
      "type": "deadline",
      "title": "Quiz #3",
      "org": "ECE 105",
      "dueAt": "2026-10-14T20:00:00Z",
      "url": "https://learn.uwaterloo.ca/d2l/...",
      "status": "open",
      "confidence": "exact",
      "weight": 15,
      "section": "LEC 002",
      "location": "MC 4020",
      "details": "Covers weeks 1–6",
      "source": "learn",
      "seenIn": [{ "source": "learn" }, { "source": "outline" }],
      "calendar": { "uid": "learn-1234-5678@waterloo-all-in-1", "seq": 0 },
      "alarms": [60],
      "feedGroup": "deadlines"
    }
  ]
}
```

Event fields (anything else is ignored):

| Field | Rule |
|---|---|
| `id` | required, string ≤200 chars |
| `type` | required, one of `deadline quiz exam presentation class tutorial lab meeting interview application-deadline offer-deadline cycle-date task event term-date` |
| `title` | required, trimmed, ≤500 chars |
| `source`, `org`, `location`, `section`, `details` | strings, clamped to 50 / 100 / 500 / 50 / 2000 chars |
| `dueAt`, `startAt`, `endAt` | ISO timestamps; a bare `YYYY-MM-DD` is taken literally (no timezone shift) and implies an all-day event |
| `allDay` | boolean; renders `DTSTART;VALUE=DATE` |
| `url` | kept only if `https:`, ≤2000 chars |
| `status` | `open` (default), `submitted`, `done`, `cancelled` |
| `confidence` | `exact` (default) or `tentative` |
| `weight` | finite number 0–100 |
| `seenIn` | `[{source}]`; distinct source ids only |
| `calendar.uid` | ≤200 chars; wins over `id` for the UID |
| `calendar.seq` | int ≥0; client-side floor for SEQUENCE |
| `alarms` | `number[]` minutes before start; overrides the type-level list (even `[]`) |
| `feedGroup` | one of `classes deadlines coop teams other` |

`events` may be empty — that publishes an empty feed (the user removed
everything). Invalid events are **skipped**, not fatal; the response carries
`accepted: n` and `skipped: [{id, reason}]` (first 20) with reasons
`missing id | bad type | missing title | no valid date | duplicate uid`.
400 only when the body isn't JSON or `events` isn't an array.
Limits: 3000 events and 2 MiB per publish; the normalized feed state must also
fit one D1 row (~1.9 MB serialized) — anything beyond gets 413.

### Legacy v1

A body with `assignments` and no `events` is converted from the gurshh shape
`{id, courseId, name, courseName, dueDate, url}` to deadlines with
`uid = <courseId>-<id>@learn.uwaterloo.ca`, preserving the UIDs old feeds
already published. Stored v1 rows (a plain JSON array) render the same way.

## UIDs and SEQUENCE

- `UID = calendar.uid || id`, with `@waterloo-all-in-1` appended when it has no
  `@`. First occurrence wins within one payload; later duplicates are skipped.
- The server tracks `seq` per UID. Unchanged event → `SEQUENCE` and
  `DTSTAMP`/`LAST-MODIFIED` stay put, so republishing identical input is
  byte-identical. A changed event bumps to `max(stored + 1, calendar.seq)`;
  `calendar.seq` acts only as a floor.
- A UID that disappears becomes a tombstone (`{seq, removedAt}`; kept 180 days,
  capped at 5000); if it returns, its SEQUENCE continues upward instead of
  restarting.
- `timeZone` is part of each event's change hash: republishing with a
  different timezone re-dates all-day events and counts as a change.

## Group feeds

Every feed also gets five unguessable alias URLs, one per group:
`classes` ("Classes"), `deadlines` ("Deadlines & exams"), `coop` ("Co-op"),
`teams` ("Teams"), `other` ("Other"). They render the same UIDs/SEQUENCEs,
filtered. An event lands in: its valid `feedGroup`, else `waterlooworks` →
`coop` / `discord` → `teams`, else by type — `class tutorial lab` → classes;
`deadline quiz exam presentation task` → deadlines;
`interview application-deadline offer-deadline cycle-date` → coop;
`meeting event term-date` → other.

## Timing rules

- Timed events render in UTC (`Z` form); no `VTIMEZONE` is emitted. The feed
  carries `X-WR-TIMEZONE` for clients that use it.
- A bare `YYYY-MM-DD` value for `startAt` (or `dueAt` when there's no
  `startAt`) implies `allDay` — as an instant it would land on UTC midnight,
  i.e. the previous evening in local time.
- `allDay` → `DTSTART;VALUE=DATE` is the local (feed timezone) date of
  `startAt || dueAt`. `DTEND` follows the extension's exclusive-end
  convention: a full timestamp `endAt` at exactly local midnight already
  means "the day after the last day" and is used verbatim; a date-only
  `YYYY-MM-DD` `endAt` or any non-midnight timestamp is an inclusive last
  day, so `DTEND` is that local date + 1 day. `DTEND` is always after
  `DTSTART` (a zero-length range becomes start + 1 day).
- `startAt` present → `DTEND` = `endAt` if later, else `dueAt` if later, else
  start + 60 minutes.
- `dueAt` only → `DTSTART` at the due time with no `DTEND` (a deadline, not a
  one-hour block).

## Alarms

`alarms` lists minutes before start, max 3 per event, integers 0–40320 (4
weeks); invalid entries are dropped. Per-event `alarms` overrides the type
list for that event — `[]` disables alarms for it. No alarms are emitted
unless the payload asks. Note: **Google Calendar ignores VALARM in subscribed
feeds**; Apple Calendar and Outlook honour them.

## Rendered-feed cache (free-tier efficiency)

The expensive work (JSON parse → `applyPublish` → ICS render) happens **once at
PUT/POST time**, not on every read. Publish stores state in
`calendar_feeds` plus one pre-rendered ICS row per public feed id in
`calendar_renders` (migration `0003_rendered_feeds.sql`) — six rows per feed:
the main id and the five group aliases. A normal `GET` is then a single D1
primary-key lookup of stored text with an `ETag`; a matching
`If-None-Match` returns `304` with no body. Feeds created before 0003 lazily
backfill their render row on first `GET`.

### Measured CPU (Node 22, median of 7 runs — `test/bench.test.js`)

| Feed size | Payload | JSON.parse | applyPublish | buildCalendar ×6 | Total |
|---|---|---|---|---|---|
| 400 events | 151 KiB | 0.7 ms | 29.6 ms | 201.4 ms | ~232 ms |
| 3000 events | 1.1 MiB | 2.7 ms | 189.7 ms | 1378.0 ms | ~1570 ms |

**These totals do not fit Cloudflare's free-tier 10 ms CPU limit.** Node is a
proxy — V8 on the Workers runtime is the same engine, so order of magnitude
holds. A 3000-event PUT is ~150× the free CPU budget; even a 400-event PUT is
~20×. Rendering all six feeds dominates (a single 3000-event calendar render
is ~230 ms). Options, without changing the client protocol:

- **Workers Paid plan** (~$5/month): the "standard" CPU model allows 30 s —
  trivial headroom at these sizes. This is the realistic choice for >400-event
  feeds.
- **Free tier only**: cap stored events low (~100–200; `MAX_EVENTS`/payload
  size in `worker.js`) and/or lean on the lazy-backfill path — store state at
  PUT and let each feed's first `GET` render (still ~100–200 ms per render at
  3000 events, so still over 10 ms; the cap is the part that makes it fit).
- **Queue/cron rendering**: enqueue a render job at PUT (small CPU), render in
  a Queue consumer — but Queues are also paid-plan only.

### Free-tier capacity estimate

Limits (per day): 100k requests, 10 ms CPU each, 5M D1 rows read, 100k rows
written, 5 GB storage.

- **GETs are cheap**: 1 row read, ~1 ms CPU, `304` for unchanged feeds.
  Google Calendar polls each subscribed feed about every 8–12 h → ~2–3 GETs
  per feed per day. With all six feeds subscribed that's ~18 reads/user/day,
  so the 5M D1 rows-read limit supports ~275k users and isn't binding. The
  100k requests/day cap binds first: **~5.5k users** with all six feeds
  subscribed (proportionally more when users subscribe to fewer feeds; a 304
  still counts as a request but only 1 row).
- **PUTs**: 7 row writes each (1 state + 6 renders) → `100k / 7 ≈ 14k PUTs/day`.
  The extension PUTs only on change — a few/day/user → not the bottleneck.
  CPU, not writes, limits PUT size (above).
- **Storage**: 5 GB ÷ ~1 MB/feed (state + renders) ≈ 5k+ feeds.

## Privacy

- Feed URLs (including the per-group ones) are unguessable secrets — anyone
  holding one can read the whole feed. The extension should treat them as
  credentials.
- The update token is stored only as a SHA-256 hash; losing it means creating
  a new feed.
- Stored per feed: the normalized event list above plus per-UID hash/seq/
  timestamps and tombstones. No credentials, cookies, or page content beyond
  what the events carry.

## Deploy

```sh
npx --yes wrangler@4.129.0 login
npx --yes wrangler@4.129.0 d1 create waterloo-all-in-1-feed
# paste the returned database_id into wrangler.jsonc
npx --yes wrangler@4.129.0 d1 migrations apply waterloo-all-in-1-feed --remote   # 0001 + 0002 + 0003
npx --yes wrangler@4.129.0 deploy
```

Check `https://waterloo-all-in-1-feed.<account>.workers.dev/health`, then give
the worker URL to the extension (the calendar client setting; the host goes in
the manifest's `host_permissions`). No secrets are needed.

## Verify locally

No third-party dependencies:

```sh
npm test
```
