# Waterloo All-in-1

A Chrome/Edge (MV3) browser extension that finds every dated thing in a UW
student's life — Learn deadlines, class and exam schedules, WaterlooWorks
applications and interviews, design-team meetings from Discord, and events
from Outlook/Gmail — and publishes them to one Google Calendar subscription
with no duplicates.

It works with the logins you already have in your browser: no API keys, no
passwords, no OAuth. Data stays in `chrome.storage.local`; the only thing
that leaves your machine is the calendar feed you turn on.

## Credits

Built on two MIT-licensed projects:

- [gurshh-rain/uwlearn_assignment_extension](https://github.com/gurshh-rain/uwlearn_assignment_extension)
  (Gurshaan Gill) — merged with its git history; the original extension files
  live in `legacy/gurshh/` and the Cloudflare Worker calendar feed in `server/`.
- [EricJujianZou/watnow](https://github.com/EricJujianZou/watnow) (Eric Zou) —
  the Learn side panel, reminders and live Learn reader, now under
  `extension/src/` (Umami analytics removed).

Upstream licenses are in `licenses/`.

## Development

```
npm install          # once per worktree
npm run build        # bundle extension/ into dist/
npm run dev          # rebuild on change
npm test             # node --test + server worker tests
npm run typecheck    # tsc --noEmit (files opt in with // @ts-check)
```

## Loading in Edge

1. `npm run build`
2. `edge://extensions` → enable **Developer mode** → **Load unpacked** → pick
   this repo's `dist/` folder.
3. After a rebuild, press **Reload** on the extension card, then refresh any
   site tabs.

See `AGENTS.md` for the repo layout and worktree rules, and `docs/` / the
master plan for the roadmap.
