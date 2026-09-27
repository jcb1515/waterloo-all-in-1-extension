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

## What it stores

The extension stores data in `chrome.storage.local`, which stays on your
device:

- extracted items (deadlines, classes, events, applications);
- your settings and profile choices (sections, groups, watched sources);
- per-source sync status (last success time, error state).

No passwords, session tokens or credentials are stored.

## What it sends

- **Today: nothing.** No data leaves your device.
- **Discord is read-only and passive**: the extension makes no requests to
  Discord and never accesses your account token. It only notes dated
  messages in servers you already read while browsing.
- **Calendar sync (when it ships) is opt-in.** If you turn it on, only
  event data — titles, times, locations — is sent to the calendar feed
  server you configure (self-hosted; see `server/`). Nothing else is
  transmitted.

## Third parties

No analytics, advertising networks or third-party data processors are
involved. The optional calendar feed server is one you host or choose
yourself.

## Your choices

- Disable or clear any source in the options page; the Sources tab has a
  per-source "Clear data" button.
- Uninstalling the extension removes all stored data.

## Contact

This is an open-source project — questions and issues can be raised on the
repository's issue tracker:

https://github.com/jcb1515/waterloo-all-in-1-extension

_Not affiliated with or endorsed by the University of Waterloo._
