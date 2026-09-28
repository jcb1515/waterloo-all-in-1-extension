# Privacy Policy — Waterloo All-in-1

_Last updated: 2025._

## Summary

Waterloo All-in-1 processes everything locally in your browser. It does not
send your data to anyone, does not store passwords or tokens, and does not
include analytics or third-party trackers.

## What the extension reads

The extension reads content on the University of Waterloo and related sites
you visit — Learn, Waterloo's course-outline site, Portal, WaterlooWorks,
Discord, Outlook and Gmail — to extract dated items such as deadlines,
classes, applications, interviews and events. It reads only pages that you
can already see with your own logged-in session.

**Portal (portal.uwaterloo.ca).** While you have any Portal page open, the
extension asks Portal for four things: your course enrolments, class
schedule, exam schedule, and the university calendar for the next four
months. It asks from inside that Portal tab, using the sign-in Portal
already has, at most once every 30 minutes and only while the tab stays
open. Your Portal sign-in token is used only as the header of those four
requests. It is never saved, never copied into the extension's storage,
never logged and never sent anywhere else, and the extension never
refreshes or extends your Portal session. The replies are turned into
calendar items on your computer, and only those items (course, date, time,
room, seat) are stored. If you're signed out, nothing is fetched.

## What it stores

The extension stores data in `chrome.storage.local`, which stays on your
device:

- extracted items (deadlines, classes, events, applications);
- your settings and profile choices (sections, groups, watched sources);
- per-source sync status (last success time, error state).

No passwords, session tokens or credentials are stored.

## What it sends

- **By default: nothing.** No data leaves your device.
- **Discord is read-only and passive**: the extension makes no requests to
  Discord and never accesses your account token. It only notes dated
  messages in servers you already read while browsing.
- **Calendar sync is opt-in.** If you turn it on, only event data —
  titles, times, locations — is sent to the calendar feed server so
  Google Calendar can subscribe. See "The shared calendar server" below.
  Nothing else is transmitted.

## Optional permissions

Discord, the email sites (Outlook, Gmail) and Google Calendar are
**optional host permissions**. The browser asks for them only when you
enable those sources — in Settings → Sources, the panel's Sources overlay
or the Welcome checklist. Without the grant, the extension simply doesn't
read those sites; everything else keeps working. Revoking a grant in the
browser's extension details stops the reading; clearing the source in
Settings → Sources removes its stored data.

**Google Calendar** (`calendar.google.com`) is the duplicate check:
when enabled, the extension reads event titles and times from your *own*
calendars only — no descriptions, guests or locations, and never from
subscribed calendars (including the extension's own published feed). What
it reads is only ever compared against your items locally; it is never
published or sent anywhere.

**Email** compares your account address against senders to detect your
own replies — the address itself is never stored or sent.

**Check readers** (panel → Sources → Check readers) run counts-only
probes on pages you open and can download a diagnostic report — the
report contains counts and redacted structural outlines only, never page
text, names or addresses.

## The shared calendar server

The extension ships pointing at a shared feed server operated by the
extension's maintainer on **Cloudflare Workers + D1**
(`waterloo-all-in-1-feed.jb-wat.workers.dev`). It is only used when you
turn calendar sync on — Settings → Calendar, the panel's Calendar tab or
the Welcome step. You can point the extension at your own Worker instead
(Settings → Calendar → Feed server URL; see `server/README.md`).

When sync is on, the server stores, per feed:

- the **published event fields** — titles, start/end times, locations
  and links for the items you publish (the exact list the feed serves as
  an `.ics` calendar);
- a **SHA-256 hash of your update token** — the raw token is never
  stored, it's how your browser (and only your browser) can update or
  delete the feed;
- a **salted SHA-256 hash of your IP address, scoped to the UTC day**,
  used only for the daily feed-create rate limit. Raw IPs are never
  stored and the hash changes every day.

Feeds expire **one year after their last publish** and are then deleted
(a daily job purges expired feeds). Deleted events are kept as
tombstones inside the feed for up to 180 days so a stale republish can't
resurrect them — tombstones die with the feed. "Stop syncing and delete
feed" in Settings → Calendar issues a DELETE that removes the feed, its
rendered calendars and its aliases immediately.

**Anyone with the feed link can read the feed** — that's how Google
Calendar subscribes. The link is a long random id; treat it as private.

The server has no analytics, no ads and no tracking. The source is in
`server/`; self-hosters can deploy the same Worker.

## Third parties

No analytics, advertising networks or third-party data processors are
involved. The only server involved is the calendar feed server above —
the maintainer's shared one, or your own.

## Your choices

- Disable or clear any source in the options page; the Sources tab has a
  per-source "Clear data" button.
- Uninstalling the extension removes all stored data.

## Contact

This is an open-source project — questions and issues can be raised on the
repository's issue tracker:

https://github.com/jcb1515/waterloo-all-in-1-extension

_Not affiliated with or endorsed by the University of Waterloo._
