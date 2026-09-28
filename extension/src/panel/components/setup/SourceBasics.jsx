// @ts-check
// The shared top of every source's Setup segment: the "what we read"
// paragraph, then the source's own setup blocks. W1's Sources page frame
// owns the Enabled toggle, permission buttons and sync/open controls, so
// this only explains the source and gates `children` on the toggle state.

/** One "what we read" paragraph per adapter. */
const WHAT_WE_READ = {
  learn: "Reads your courses, assignments, quizzes, grades and announcements while you use Learn. Nothing leaves your browser except your own calendar feed.",
  portal: "Reads your class schedule, sections, final exams (date, time, room and seat) and term dates while you browse Portal.",
  outline: "Reads course outline pages and outline files you add: classes for your section, assessments and weights, and deadlines.",
  outlook: "Reads calendar invites and dated emails in Outlook and Gmail tabs you open. Only the matched sentence is kept — never whole emails or addresses.",
  gcal: "Reads event titles and times from your own Google calendars so nothing is published twice. Subscribed calendars, including this extension's feed, never hide anything.",
  waterlooworks: "Reads your applications, interviews and ranking dates while you browse WaterlooWorks.",
  discord: "Reads messages, events and mentions in the servers and channels you watch, only while Discord is open. Nothing is ever sent to Discord.",
};

/**
 * @param {{sourceId: string, state: any, actions?: any, children?: any}} p
 */
export function SourceBasics({ sourceId, state, children }) {
  const src =
    (state.settings &&
      state.settings.sources &&
      state.settings.sources[sourceId]) ||
    {};
  // gcal is the one source that's off until the user turns it on.
  const enabled = sourceId === "gcal" ? src.enabled === true : src.enabled !== false;

  return (
    <div class="src-sub">
      {WHAT_WE_READ[sourceId] ? <p class="help">{WHAT_WE_READ[sourceId]}</p> : null}
      {enabled ? children : null}
    </div>
  );
}
