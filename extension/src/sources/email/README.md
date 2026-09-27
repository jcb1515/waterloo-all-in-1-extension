# Email adapter (Outlook web + Gmail) — T3, DOM only

Finds dated things in already-rendered mail: meeting/interview invites and
"important" mail (co-op, Learn, instructors, course-coded, keyworded) that
mention a date. **No network access of any kind**: OWA's tokened API and
Gmail's data endpoints were never captured, so there are no `urlPatterns`
and `sync` is a no-tab stub. Everything arrives as a serialised DOM extract
from `content.js` (a bundled IIFE; bundled separately by `tools/build.mjs`).

## Pipeline

- `content.js` — passive DOM reader. Runs on load, `hashchange`/`popstate`,
  and a MutationObserver debounced to 2s. Sends `MSG.OBSERVED` with
  `{source, kind: "dom", url, body: JSON.stringify(extract), at}` only when
  the extract has messages, deduped by body, capped at 2 MB, `.catch`-ed.
- `dom.js` — `extractFor(doc, href)` → `{v, provider, folder, view, messages}`,
  one per host. `Msg = {key, url, from, fromEmail, subject, preview?,
  receivedText?, receivedAt?, body?, links}`. Bodies exist only in message
  view (≤20,000 chars, `<br>`/block boundaries → `\n`), previews ≤200 chars,
  `receivedAt` = ISO Toronto from a title/text parse (omitted on failure),
  `links` = Teams/Zoom/Meet/WaterlooWorks hrefs with Google `url?q=` wrappers
  unwrapped.
- `rules.js` + `extract.js` — `itemsFromMessage(msg, …)` (pure):
  - **Invites → exact items.** Google-Calendar subjects
    (`Invitation:|Updated invitation|Canceled event|Cancelled event( with note)?: <title> @ <when> (<tz>) (<email>)`),
    a `When:` body line, or a meeting link + timed date. The when-text is
    parsed with `textDates` (Toronto wall time); an absent or Eastern zone is
    `exact`/`auto`, anything else `tentative`/`pending` with `meta.tz`.
    `Canceled event:` keeps `status "cancelled"`. "interview" in the subject
    or a WaterlooWorks sender makes it an `interview`. `meta.facts` carries
    Organizer/Where/Join; `id = <provider>:invite:<key>:<startAt>`.
  - **Important mail → review items.** Sender gate: WaterlooWorks/co-op,
    Learn, a `courses[].instructors[].email` match, a course code in the
    subject, or `settings.teams`/`settings.senders` substrings — OR a keyword
    in the subject. Keyword set: interview, offer, rank(ing), deadline, due,
    extension, midterm, exam, room change, cance(l)led, rescheduled, meeting,
    tapeout, design review ∪ `settings.keywords`. Date hits come from
    `textDates(subject + "\n" + body|preview)`, confidence ≥0.6, not ended
    before `receivedAt − 1d`, and inside a keyword sentence; max 3 per
    message, one per Toronto day. Type maps off the keyword (interview,
    offer-deadline, cycle-date, exam, meeting, deadline, else event); timed
    hits give `startAt`/`endAt` or `dueAt` (all-day deadline → 23:59 ET).
    Always `tentative`/`pending`; `id = <provider>:mail:<key>:<instant>`.

## Settings

`{gmail?, outlook?, folders?, senders?, keywords?, teams?}`

- `settings.gmail` / `settings.outlook` `=== false` → that provider returns
  an empty, incomplete result (`scope "email:off"`).
- `folders` (default `["inbox"]`) — case-insensitive allow-list on the
  extract's folder; `"sent"` yields nothing unless configured. A null folder
  is allowed.
- `senders` / `teams` — case-insensitive substrings matched against the
  sender name/email for the gate; `teams` also supplies `org` fallback.
- `keywords` — extra word-bounded keywords for the hit filter and typing.

## Scope semantics

- A message view whose messages share one key → `email:<provider>:<key>`,
  which equals each item's `seenIn[].scope` — so a re-observed thread
  replaces only its own items.
- Any list view → `email:<provider>:list`, which no item ever carries, so a
  list observation can never delete message items.

## Privacy

- `content.js`/`dom.js`/`index.js` make no requests, no navigation, no
  storage, no token reads (enforced by a static test over `sources/email/*.js`).
- Message bodies, previews and sender emails are transient: items keep at
  most a ≤300-char keyword-sentence `evidence.snippet` plus sender *name*
  (`meta.fromName`, facts "From") — never `fromEmail`, never raw body text.
- Persisted `state` is `{lastSeenAt, counts: {[provider]: n}}` only.

## needs tuning (selectors — all best guesses)

Captured discovery was structural-only (no values); these are educated
guesses from common Gmail/OWA markup. Every reader fails soft.

- Gmail rows `tr.zA`, key `[data-legacy-thread-id]`, sender `.yW [email]`
  (name attr or text), subject `.bog`, preview `.y2` (leading `" - "` cut),
  time `.xW span[title]`; message view `h2.hP`, `div.adn` /
  `[data-legacy-message-id]`, sender `.gD[email]`, time `.g3[title]`,
  body `.a3s`; folder/view from `#<folder>/<id>` hash segments; item URL
  rebuilt as `mail/u/<n>/#<folder>/<key>`.
- Outlook rows `[data-convid]` (prefer `[role=option]`), sender
  `span[title*="@"]`, time `time[datetime]` or a time-ish text line, subject
  = first non-sender/non-time line; message view `[role="main"]` with
  `[role="heading"]`, `[aria-label="Message body"]`,
  `[data-testid="SentReceivedSavedTime"]`, key from the
  `[aria-selected="true"]` row else the `/id/<id>` URL segment; folder from
  `data-folder-name` else the `/mail/` path (skip `0`).
- Link keep-list: `teams.microsoft.com/l/meetup-join`, `zoom.us/j/`,
  `meet.google.com/`, `waterlooworks.uwaterloo.ca`.
- Outlook message views may contain more than one `[data-convid]` doc (e.g.
  a thread pane); the single-key rule in `index.js` then falls back to the
  list scope rather than over-removing.

`parsers.js` stays a stub — there is no fetch tier to parse.
