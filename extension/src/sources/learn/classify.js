// @ts-check
/* Maps a Learn item's title/kind/category to the contract's {type, category}.
   Pure: no fetch, no chrome, no Date. */

const FINAL_RE = /\b(final exam|final examination)\b/i;
const MIDTERM_RE = /\b(midterm|mid-term|term test)\b/i;
const PRESENTATION_RE = /\b(presentation|pitch|demo day|showcase)\b/i;
const DUEISH_RE = /\b(due|deadline|submi\w*)\b/i;

/**
 * Words that make an announcement sentence date-worthy. Checked against the
 * sentence containing a date hit, never the whole news body.
 */
export const TRIGGER_RE =
  /\b(due|deadline|submi\w*|mid-?terms?|term tests?|exams?|finals?|quiz(?:zes)?|tests?|labs?|assignments?|presentations?|moved|rescheduled|postponed|cancell?ed|rooms?|extensions?|extended)\b/i;

/**
 * @param {{title?: string, kind?: string, category?: string}} row
 *   kind/category are WATnow's (dropbox|quiz|discussion|content,
 *   assignment|lab|quiz|discussion|content).
 * @returns {{type: string, category: string|undefined}}
 */
export function classify({ title, kind, category } = {}) {
  const t = String(title || "");
  if (FINAL_RE.test(t)) return { type: "exam", category: "final" };
  if (MIDTERM_RE.test(t)) return { type: "exam", category: "midterm" };
  if (PRESENTATION_RE.test(t)) return { type: "presentation", category: "presentation" };
  if (kind === "quiz") return { type: "quiz", category: "quiz" };
  return { type: "deadline", category };
}

/** True when a sentence reads like a deadline rather than an event. */
export function isDueish(sentence) {
  return DUEISH_RE.test(String(sentence || ""));
}
