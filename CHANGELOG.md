# Changelog

## 1.3.0 — 2026-09-28

### To-dos from everywhere

- **One To-do list for every source**: replies, interview bookings, offer
  responses, rankings, forms, documents, fees and "apply" deadlines now
  come from WaterlooWorks, Gmail, Outlook and Discord, grouped Overdue /
  Today / This week / Later / No date. Every row shows its full date, its
  sources, **Done**, **Snooze** and **Open** (straight to the email or
  WaterlooWorks page).
- **No double to-dos**: the same ask from different places (say, an
  interview-booking email and the WaterlooWorks time-slot page) becomes one
  to-do, with WaterlooWorks' version preferred. Booking the interview on
  WaterlooWorks ticks the to-do off by itself.
- **Rankings stay at one to-do per work term**, even now that WaterlooWorks
  reports it too, and the calendar shows the co-op "rankings close" date
  only once.
- To-dos without a real due date sit under **No date** and never go to your
  calendar.

### Easier to use

- **Visible Add buttons**: "+ Add to-do" in To-do, "+ Add" in Upcoming, and
  a "+" on every Calendar day that fills in the date for you.
- **New More menu**: a full-width list of Courses, Co-op, Teams and
  Projects with a short description and a count for each ("1 interview",
  "5 this week"). It works with the arrow keys and Esc.
- The tab strip fits the side panel at every width without cutting off
  "Upcoming" or "More".
- **Get set up ticks right away**: a row shows "Opened" as soon as you click
  Open and "Read" once the page is read, even if the site had nothing new.
  Source tiles use the same rule, so a tile no longer says "stale" right
  after you've opened the site. If an opened source still hasn't been read
  after 30 minutes, its tile says so.
- **Overdue shows only real work**: past co-op dates, events and term dates
  no longer appear as "late". Upcoming shows items up to two weeks overdue;
  the To-do tab keeps the rest.
- **Clashes are real clashes**: all-day items (like a co-op interview
  period) no longer "clash" with every class that week.

### Sources and reading

- **Mail is read automatically** from an open Gmail or Outlook tab. The
  first read covers the last 30 days (7–90, your choice), then only newer
  mail every 30 minutes. Reading never changes what shows as unread. The
  guided mail scan is gone.
- **Google Calendar duplicate check** reads your own calendars' export
  every 6 hours, and when you open the panel if the last check is over 30
  minutes old.
- **WaterlooWorks dashboard events** (info sessions, workshops) are picked
  up. Ones you're registered for go on your calendar; the rest wait in
  Review.
- **My Jobs folders**: saved jobs you still qualify for and haven't applied
  to get an "Apply" to-do due at the posting deadline.
- Course outline dates that landed in the wrong year (for example a
  symposium showing as "308 days late") now use the term's year.

### Privacy

- PRIVACY.md now covers the automatic mail read (including how Outlook's
  own sign-in token is used inside the Outlook tab and never stored), the
  Google Calendar export, WaterlooWorks events and My Jobs folders.

## 1.2.0 — 2026-09-28

### New panel

- **New navigation**: Upcoming, To-do, Calendar, Sources and More, with
  per-source badges and the full date shown on every row — no more
  guessing which "Friday" an item means.
- **Per-source pages** in Sources: each reader gets a page with what it
  **Picked up**, its **Setup** steps, and its **Check** reader status.
- **Get set up** card: one checklist that tracks which sources you've
  opened and which still need a first visit, and **Needs a visit** nudges
  in Upcoming when a source hasn't been read in a while (snoozable).

### Sources and reading

- **Portal auto-fetch**: opening the Portal tab once is enough — the
  extension now walks your schedule and exam pages on its own.
- **WaterlooWorks in-tab refresh**: the extension refreshes your
  applications, interviews and dashboard inside an open WaterlooWorks
  tab, with a switch in Settings → Sources to turn it off.
- **Gmail unread feed**: dated "important" mail is read from Gmail's own
  Atom feed — more reliable detection and it works without the reading
  pane.
- **Course outline refresh**: outline deadlines are re-read in the open
  outline tab, so late additions show up on their own.
- Email detection improvements: better sender, keyword and title handling
  across Outlook, Gmail and Discord, including generic-subject fallbacks
  and stale-date filtering.
- **Check readers** now re-probe shortly after a page finishes loading,
  so slow sites (like the WaterlooWorks dashboard) report "Read" once
  they actually render instead of staying "not read".

### Duplicate fixes

- **Already-split items re-merge**: duplicates created by older versions
  (e.g. a course midterm captured separately from Portal and the outline)
  re-cluster on the next sync — one entry, and the stray copy disappears
  from your calendar.
- **Publish guard covers all-day vs timed pairs**: an all-day outline
  deadline and the same timed Learn deadline on the same day now publish
  once (the timed one wins). Real clashes — different courses, different
  days — still stay separate.
- **Rankings to-dos**: one "Submit your rankings" to-do per work term,
  the earliest upcoming deadline for the term you're actually in —
  instead of one per cycle across every term.
- **Portal no longer duplicates Learn deadlines or class/exam entries**:
  Portal's calendar mirror of Learn items is matched onto the real item
  instead of publishing twice, and **course outlines fold restated
  deadlines** (a deadline repeated in the outline text joins the assessed
  row instead of appearing twice).
- **Co-op dates re-map after updates**: WaterlooWorks cycle-date items
  keep their identity across portal updates, so no stale duplicates.
- Old Portal calendar entries from earlier versions are **cleaned up
  automatically**, and three events that had been hidden by a clash now
  show.

### Under the hood

- **Shared calendar server built in**: the Google Calendar feed is served
  by our own infrastructure — no third-party service to configure.
- **Reminder pause**: pause reminders temporarily instead of turning them
  off and forgetting to turn them back on.

## 1.1.0

### To-do and Projects (new)

- A **To-do** tab: a quick-add box, filter chips, and auto-completing
  tasks — Learn submissions, WaterlooWorks applies and offers, interview
  slot picks, email replies and book-a-calls, and derived study prep all
  finish themselves when the source shows it happened.
- A **Projects** tab: make your own projects with a colour, due date and
  milestones/tasks; they land in the agenda, the calendar feed (per-item
  and per-project opt-outs) and the To-do tab. `#project` quick-add.
- Customisable panel tabs: reorder and hide tabs in Settings → General.

### Email and Discord tasks

- Email detection fixes: a looser sender gate, a bulk-mail filter,
  call/meeting keyword coverage and employer senders counted.
- Reply-needed tasks ("Reply to …") and book-a-call tasks ("Book a call
  with …") from Outlook, Gmail and Discord — auto-completing on "You
  replied" / "Invite received".
- **Scan my mail** — guided per-provider walk through older mail, driven
  by clicks from the extension, never on its own.

### Duplicate protection

- Gmail calendar invites mark items "On your Google Calendar" and keep
  them off the published feed.
- Org-aware cross-source matching (course codes and team names), a
  publish-time guard that collapses same-event stragglers, and the new
  **Google Calendar** reader: enable it in Settings → Sources and events
  already on your own calendar are skipped automatically. It reads titles
  and times only, from your own calendars only — never subscribed
  calendars (so the extension's own feed can't suppress itself) and never
  sends anything anywhere.

### Reliability

- **Health check** in Settings → About: audits the store for malformed
  items, duplicates, orphans and secrets hygiene, with safe fixes and a
  downloadable report; runs weekly in the background.
- **Check readers** in the panel's Sources overlay: per-source checklists
  that verify each reader sees what it expects on the pages you open,
  with counts-only probes and a redacted report download.

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
