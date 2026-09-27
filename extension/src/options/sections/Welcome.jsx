// @ts-check
// Welcome: a short setup checklist with live status from sourceState/settings.
// Opened automatically on install (options.html#welcome) and pinned first in
// the nav.

import { Card } from "../bits.jsx";
import { CheckIcon } from "../../ui/icons.jsx";

/** @param {{ok?: boolean, label: string, todo?: string}} p */
function StatusChip({ ok, label, todo }) {
  if (ok) {
    return (
      <span class="badge badge-ok">
        <CheckIcon size={11} /> {label}
      </span>
    );
  }
  return <span class="badge badge-muted">{todo || "Not yet"}</span>;
}

/** @param {{n: number, title: any, done?: boolean, children?: any}} p */
function Step({ n, title, done, children }) {
  return (
    <li class="welcome-step">
      <span class={`welcome-num${done ? " done" : ""}`} aria-hidden="true">
        {done ? <CheckIcon size={13} /> : n}
      </span>
      <div class="welcome-body">
        <p class="welcome-title">{title}</p>
        {children ? <p class="help">{children}</p> : null}
      </div>
    </li>
  );
}

const LEARN_URL = "https://learn.uwaterloo.ca/";
const WW_URL = "https://waterlooworks.uwaterloo.ca/";

/**
 * @param {{settings: any, state: any}} p
 */
export function WelcomeSection({ settings, state }) {
  const ss = ((state && state.sourceState) || {});
  const learnOk = !!(ss.learn && ss.learn.lastOkAt);
  const outlineUrls = (settings.sources && settings.sources.outline && settings.sources.outline.urls) || {};
  const outlineCount = Array.isArray(outlineUrls)
    ? outlineUrls.length
    : Object.keys(outlineUrls).length;
  const watched = (settings.sources && settings.sources.discord && settings.sources.discord.watched) || {};
  const watchedCount = Object.keys(watched).length;
  const sectionCount = Object.keys(((settings.profile && settings.profile.sections) || {})).length;

  return (
    <div class="opt-stack">
      <Card title="Get set up">
        <p class="help">
          Six quick steps — everything happens in your browser, nothing is sent
          anywhere until calendar sync ships.
        </p>
        <ol class="welcome-list">
          <Step
            n={1}
            done={learnOk}
            title={
              <>
                Sign in to <a href={LEARN_URL} target="_blank" rel="noreferrer">Learn</a> in a tab{" "}
                <StatusChip ok={learnOk} label="Connected" />
              </>
            }
          >
            Open learn.uwaterloo.ca and sign in like normal — the extension reads
            deadlines and classes with your existing session.
          </Step>
          <Step n={2} done={sectionCount > 0} title={<>Check your sections and tutorials <a class="welcome-link" href="#profile">Profile</a></>}>
            These fill in automatically from Portal once Portal support arrives;
            until then, add them under Profile so the agenda shows your section only.
            {sectionCount > 0 ? ` ${sectionCount} set.` : ""}
          </Step>
          <Step n={3} done={outlineCount > 0} title={<>Add course outlines <a class="welcome-link" href="#sources">Sources</a></>}>
            Paste each course's outline URL under Sources → Course outlines
            (file import is coming).{outlineCount > 0 ? ` ${outlineCount} added.` : ""}
          </Step>
          <Step n={4} done={!!(ss.waterlooworks && ss.waterlooworks.lastOkAt)} title={<>WaterlooWorks: just browse it <a class="welcome-link" href={WW_URL} target="_blank" rel="noreferrer">Open</a></>}>
            No sync button needed — applications and interviews update while you
            browse the site.
          </Step>
          <Step n={5} done={watchedCount > 0} title={<>Discord: pick the servers to watch <a class="welcome-link" href="#sources">Sources</a></>}>
            Read-only and passive — the extension never posts or fetches; it only
            notes dated messages in servers you already read.
            {watchedCount > 0 ? ` ${watchedCount} watched.` : ""}
          </Step>
          <Step n={6} done={false} title={<>Google Calendar <a class="welcome-link" href="#calendar">Calendar</a></>}>
            Coming soon: one subscribed calendar, no duplicates.
          </Step>
        </ol>
      </Card>

      <Card title="The side panel">
        <p class="help">
          Click the toolbar icon to open the agenda panel: today's classes and
          deadlines, what's next, and what changed. Press <kbd>/</kbd> there to
          search.
        </p>
      </Card>
    </div>
  );
}
