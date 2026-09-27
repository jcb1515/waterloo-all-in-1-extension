# Changelog

## 1.0.0

### Email (new)

- Outlook web and Gmail reading goes live: calendar invites become exact
  meeting/interview items and dated "important" mail becomes Review items —
  all passively, only in mail tabs you already have open.
- Separate optional permission per provider (`Read Outlook` / `Read Gmail`
  toggles in Settings → Sources, each with its own browser prompt), plus
  advanced sender/keyword/team/folder filters.
- Email interview, offer and application-deadline items link to the matching
  WaterlooWorks application in the Co-op view.

### Courses

- Course instructors from Portal merge across sections and show on the
  course detail page, with mailto links.
- Learn course grouping; PDF syllabus import (text extracted locally with
  pdf.js); courses feed email sender detection.

### Sources and permissions

- Discord and Email host permissions are optional, granted in-context and
  registered as content scripts only while granted; revoking them removes
  the scripts.
- Passive sources no longer report "Stale" — they age by last successful
  read instead.

### Panel

- Item detail sheet: facts, per-source evidence, notes, subtasks, estimate
  chips, Toronto-aware snooze presets, hide and done — persisted per item.
- Quick add ("+") parses natural phrases ("ECE 105 quiz Friday 3pm") into
  manual items that merge with everything else.
- Teams tab: one card per watched Discord server with meetings, assigned
  tasks, unread channels and this-week items.
- Agenda group headers sum the estimates of open items.

### Calendar and reminders

- Opt-in Google Calendar feed (self-hosted Cloudflare Worker) with stable
  event UIDs, per-event facts, and a class publish window (1 week back,
  configurable weeks ahead).
- One-off `.ics` download reusing the same UIDs.
- Per-type reminder lead times, quiet hours, a morning briefing and a
  weekly digest notification.

### Settings

- Welcome checklist with live status per step.
- Backup export/import (settings, item edits, manual items, outline files).
- Hidden/snoozed items list with Unhide/Unsnooze.

### Packaging

- `npm run package` produces a verified release zip (no dev profile,
  minified). Manifest/package version 1.0.0.

## 0.9.0

- First packaged release candidate: all sources above except email, the
  store listing kit, and the optional-permission plumbing.
