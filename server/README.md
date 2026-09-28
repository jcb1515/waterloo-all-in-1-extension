# Waterloo All-in-1 calendar feed

Cloudflare Worker + D1 that turns the extension's merged item list into private,
subscribable `.ics` feeds. The extension publishes items (POST/PUT); Google
Calendar, Apple Calendar, Outlook, etc. subscribe to the returned URLs (GET).

Based on gurshh-rain/uwlearn_assignment_extension `calendar-service`
(MIT, Gurshaan Gill). Legacy v1 assignment payloads and stored rows still work.

> **Operator note:** the extension's builds default to the maintainer's
> deployment of this Worker (`package.json` → `config.calendarServiceUrl`).
> If you run your own, point Settings → Calendar → Feed server URL at it, or
> bake it in with `WA1_CALENDAR_SERVICE_URL` at build time.

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
| `facts` | `[{label, value}]` adapter-supplied details; strings only, trimmed, label ≤40 chars, value ≤300, max 12, duplicate labels dropped (first wins, case-insensitive) |
| `feedGroup` | one of `classes deadlines coop teams other` |

`events` may be empty — that publishes an empty feed (the user removed
everything). Invalid events are **skipped**, not fatal; the response carries
`accepted: n` and `skipped: [{id, reason}]` (first 20) with reasons
`missing id | bad type | missing title | no valid date | duplicate uid`.
400 only when the body isn't JSON or `events` isn't an array.

`facts` render in DESCRIPTION as `Label: value` lines, right after the
details block and before `Sources:`/`Open:`; a fact whose label is Weight,
Section, Location, Where or Room (case-insensitive) is skipped when the
event's own field already renders that line. Facts are part of the
event-change hash, so a fact change bumps `SEQUENCE`.
Limits: 3000 events (configurable via the `MAX_EVENTS` var — see
[Operator knobs](#operator-knobs)) and 2 MiB per publish; the normalized feed
state must also fit one D1 row (~1.9 MB serialized) — anything beyond gets 413.

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

### Measured CPU (Node 24, median of 7 runs — `test/bench.test.js`)

Each publish renders every VEVENT once and reuses the block across all six
feeds (`renderAllFeeds`), so the render phase is O(events), not O(events ×
feeds). `foldIcsLine`/`stableHash`/`formatIcsDate` are allocation-free fast
paths (byte-identical output, pinned by equivalence tests) and
`Intl.DateTimeFormat` instances are cached per timeZone.

| Feed size | Payload | JSON.parse | applyPublish | render all 6 feeds | serializeState | Total |
|---|---|---|---|---|---|---|
| 400 events | 151 KiB | 0.7 ms | 6.4 ms | 7.1 ms | 1.3 ms | **~15 ms** |
| 3000 events | 1.1 MiB | 2.9 ms | 33.4 ms | 32.5 ms | 8.5 ms | **~77 ms** |

**A 3000-event PUT still does not fit the free tier's 10 ms CPU limit** —
Node is a proxy, but ~8× over holds order-of-magnitude. The largest publish
that completes the full PUT path (parse + applyPublish + render + serialize)
in under ~8 ms is **≈300 events** (~7.9 ms); ~350 events already measures
~10 ms. Realistic student feeds (a few hundred items) sit right at the edge.
Options, without changing the client protocol:

- **Workers Paid plan** (~$5/month): the "standard" CPU model allows 30 s —
  headroom for the 3000-event ceiling. The realistic choice for heavy users.
- **Free tier only**: lower `MAX_EVENTS` (~300) in `worker.js` so oversized
  publishes get 413 instead of silently exceeding CPU — or rely on the
  lazy-backfill path to move render cost onto the first GET (a single-feed
  render of 3000 events is ~15 ms, still over 10 ms, so the cap is what
  makes it fit).
- **Queue/cron rendering**: enqueue a render job at PUT — but Queues are
  paid-plan only too.

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
- **POSTs**: on a shared server also bound by `MAX_FEEDS`/`CREATES_PER_IP_PER_DAY`
  (below). `MAX_FEEDS` does a `COUNT(*)` over feed rows once per POST — reads
  every feed row, but POSTs are rare (one per user per year), so the cost is
  negligible at this scale.

## Operator knobs

All optional `vars` in `wrangler.jsonc` (or the dashboard); every value is
validated and falls back to the default when missing, malformed, or out of
range — a typo can never break the worker.

| Var | Default | Effect |
|---|---|---|
| `MAX_EVENTS` | `3000` | Max events per publish (POST **and** PUT), int 1–3000. **Set ~600 on the free plan** so an oversized publish gets a clean 413 instead of a CPU-limit kill (a 600-event PUT measures ~20 ms Node-side; ~300 is the ~8 ms fit). |
| `MAX_FEEDS` | unset (unlimited) | When the live feed count is already this high, POST → `503 {error: "This server is full"}`. |
| `CREATES_PER_IP_PER_DAY` | `10` | Per-IP feed-creates per UTC day. Over → `429` + `Retry-After` (seconds to UTC midnight). |
| `RATE_SALT` | `"waterloo-all-in-1"` | Salt for the per-IP quota hash. Set as a secret: `npx wrangler secret put RATE_SALT`. Rotating it just resets everyone's daily keys. |

The rate-limit table stores `sha256(ip | UTC day | RATE_SALT)` truncated to
32 hex chars — raw IPs are never stored — and the daily cron deletes rows
from previous days. Requests without `CF-Connecting-IP` (local dev) are
never limited; only POST counts (PUT/GET/DELETE are untouched).

## Privacy

- Feed URLs (including the per-group ones) are unguessable secrets — anyone
  holding one can read the whole feed. The extension should treat them as
  credentials.
- The update token is stored only as a SHA-256 hash; losing it means creating
  a new feed.
- Stored per feed: the normalized event list above plus per-UID hash/seq/
  timestamps and tombstones. No credentials, cookies, or page content beyond
  what the events carry.

### Privacy for a shared server

One deployment can serve many students — but the trust boundary moves to the
operator:

- **The operator can read every user's published events in D1** — titles,
  times, locations, `details`/`facts`, plus per-event change history. Feed
  state and the pre-rendered ICS rows are plain text rows.
- **Feed URLs are the only access control.** A leaked `feedUrl` (or group
  alias URL) exposes that calendar to anyone, until the feed is deleted.
- **Users should only publish to a server run by someone they trust.**
  The server never sees anything the user didn't publish — Learn,
  WaterlooWorks, Discord data that wasn't turned into feed items never
  leaves the extension — but everything published is fully readable by
  whoever runs the database.
- IPs are never stored: the create-rate-limit key is a salted one-way hash
  (`sha256(ip | day | RATE_SALT)`).

## Deploy

Fresh deploy checklist (from `server/`):

```sh
# 1. Log in to Cloudflare
npx --yes wrangler@4.129.0 login

# 2. Create the D1 database
npx --yes wrangler@4.129.0 d1 create waterloo-all-in-1-feed
#    -> paste the printed database_id into wrangler.jsonc

# 3. Apply migrations 0001–0004 remotely
npx --yes wrangler@4.129.0 d1 migrations apply waterloo-all-in-1-feed --remote

# 4. Optional: operator knobs (see "Operator knobs")
#    add  vars = { MAX_EVENTS = 600, MAX_FEEDS = 150, CREATES_PER_IP_PER_DAY = 10 }
#    to wrangler.jsonc, and set the salt as a secret:
npx --yes wrangler@4.129.0 secret put RATE_SALT

# 5. Deploy
npx --yes wrangler@4.129.0 deploy

# 6. Smoke-test
curl https://waterloo-all-in-1-feed.<account>.workers.dev/health
# -> {"ok":true,"feeds":0}
```

### Pointing the extension at it

Two ways (the extension's Calendar settings are W1's):

- Per user: paste the worker URL into **Settings → Calendar → Feed server**.
- At build time: set `WA1_CALENDAR_SERVICE_URL` in the environment (e.g. a
  `dev-profile.json`-adjacent env var) so the bundled default already points
  at your server.

### Upgrading an existing deployment

```sh
npx --yes wrangler@4.129.0 d1 migrations apply waterloo-all-in-1-feed --remote
npx --yes wrangler@4.129.0 deploy
```

New migrations apply in order; already-applied ones are skipped. Feeds,
aliases and renders survive deploys — nothing else to migrate.

### Deleting feeds / wiping

- One feed: `DELETE /v1/calendars/<feedId>.ics` with the user's
  `Authorization: Bearer <updateToken>` — or delete the row directly:
  `npx wrangler d1 execute waterloo-all-in-1-feed --remote --command
  "DELETE FROM calendar_feeds WHERE id='<feedId>'"` (aliases and renders
  are removed by the daily cron's orphan cleanup).
- Everything: `npx wrangler d1 execute waterloo-all-in-1-feed --remote
  --command "DELETE FROM calendar_renders; DELETE FROM calendar_feed_aliases;
  DELETE FROM calendar_feeds; DELETE FROM create_limits;"`

### Watching for trouble

Cloudflare dashboard → Workers → `waterloo-all-in-1-feed` → **Metrics**:
watch *exceeded CPU* (oversized publishes — lower `MAX_EVENTS`), request
volume vs. the 100k/day free cap, and D1 rows read/written. Worker errors
show under **Logs** / `wrangler tail`.

## Verify locally

No third-party dependencies:

```sh
npm test
```
