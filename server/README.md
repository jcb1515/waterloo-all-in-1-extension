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
| `GET` | `/v1/calendars/<feedId>.ics` | URL itself | `text/calendar` feed (main id or a group alias id) |
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
npx --yes wrangler@4.129.0 d1 migrations apply waterloo-all-in-1-feed --remote   # 0001 + 0002
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
