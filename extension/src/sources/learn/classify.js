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
 *   kind/category are the Learn reader's (dropbox|quiz|discussion|content,
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

/**
 * The sentence a date hit sits in: text up to the nearest sentence boundary
 * on each side, whitespace-collapsed, capped at 300 chars. `.`/`!`/`?` only
 * end a sentence when a new uppercase sentence (or the end of the text)
 * follows, so abbreviations ("Ch. 3", "Oct. 9") don't cut it; "\n" always
 * ends one. Shared by the Learn announcement scan and the email rules.
 * @param {string} text @param {number} index @param {number} length
 */
export function sentenceOf(text, index, length) {
  text = String(text || "");
  const isBoundary = (i) => {
    if (text[i] === "\n") return true;
    if (text[i] !== "." && text[i] !== "!" && text[i] !== "?") return false;
    const rest = text.slice(i + 1).replace(/^\s+/, "");
    return rest === "" || /^[A-Z]/.test(rest);
  };
  let start = 0;
  for (let i = index - 1; i >= 0; i--) {
    if (isBoundary(i)) {
      start = i + 1;
      break;
    }
  }
  let end = text.length;
  for (let i = index + length; i < text.length; i++) {
    if (isBoundary(i)) {
      end = i + 1;
      break;
    }
  }
  if (end - start > 300) {
    // A sentence longer than the cap is cropped around the hit, not at its start.
    const mid = index + Math.floor(length / 2);
    start = Math.max(0, mid - 150);
    end = Math.min(text.length, start + 300);
  }
  return text.slice(start, end).replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * Build `meta.facts` from [label, value] pairs: trimmed non-empty values,
 * label <= 40 chars, value <= 300 chars, at most 12 facts (the server
 * renders at most 12 per event). Shared by Learn, Portal and outline.
 * @param {[string, unknown][]} pairs
 * @returns {{label: string, value: string}[]|undefined}
 */
export function factsOf(pairs) {
  const facts = [];
  for (const [label, raw] of pairs || []) {
    const value = String(raw ?? "").trim();
    if (!value) continue;
    facts.push({ label: String(label).slice(0, 40), value: value.slice(0, 300) });
    if (facts.length >= 12) break;
  }
  return facts.length ? facts : undefined;
}
