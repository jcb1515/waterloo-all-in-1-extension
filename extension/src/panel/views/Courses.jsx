// Courses view: one card per course, and a detail page with the assessments
// table, grading-scheme selector, the grade calculator, this week's topics
// and the course's upcoming items.

import { useMemo, useState } from "preact/hooks";
import { courseCards, courseItems, gradeSummary, weekTopics } from "../model/courses.js";
import { fmtDay, fmtTime } from "../model/agenda.js";
import { orgStyle } from "../../ui/colors.js";
import { ItemRow } from "../components/ItemRow.jsx";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  GraduationCapIcon,
} from "../../ui/icons.jsx";

const pct = (n) => (n == null ? "—" : `${Math.round(n * 10) / 10}%`);

function query0(name) {
  try {
    return new URLSearchParams(location.search).get(name);
  } catch {
    return null;
  }
}

/* --------------------------------- detail --------------------------------- */

/** Assessments table + grade calculator for one course. */
function CourseDetail({ card, state, actions, now, onBack }) {
  const { course, code } = card;
  const schemes = Array.isArray(course.gradingSchemes) ? course.gradingSchemes : [];
  const [schemeIdx, setSchemeIdx] = useState(0);
  const [target, setTarget] = useState(80);
  const scheme = schemes.length ? schemes[Math.min(schemeIdx, schemes.length - 1)] : null;
  const summary = useMemo(
    () => gradeSummary(course, { scheme, target }),
    [course, scheme, target]
  );

  const list = useMemo(
    () => courseItems(state.items, state.userState, code, now),
    [state.items, state.userState, code, now]
  );
  const upcoming = list.filter((it) => {
    const a = it.dueAt || it.startAt;
    return it.status === "open" && a && Date.parse(a) >= now.getTime();
  });
  const topics = weekTopics(list, now);
  const officeHours = course.officeHours || (course.meta && course.meta.officeHours) || null;
  const instructors = (Array.isArray(course.instructors) ? course.instructors : []).filter(
    (i) => i && i.name
  );

  // Assessments table: prefer the outline's dated assessment rows when present.
  const assessments = Array.isArray(course.assessments) && course.assessments.length
    ? course.assessments
    : summary.components.map((c) => ({
        component: c.component,
        weight: c.weight,
        dateText: "",
        itemId: null,
      }));

  const statusOf = (a) => {
    const it = a.itemId ? state.items[a.itemId] : null;
    if (it) {
      if (it.status === "done") return { label: "Done", cls: "st-done" };
      if (it.status === "submitted") return { label: "Submitted", cls: "st-done" };
      const anchor = it.dueAt || it.startAt;
      if (anchor) {
        return {
          label: it.confidence === "tentative" ? `${fmtDay(anchor)}?` : fmtDay(anchor),
          cls: it.confidence === "tentative" ? "st-tent" : "st-next",
        };
      }
    }
    if (a.dateText) return { label: a.dateText, cls: "st-next" };
    return { label: "TBD", cls: "st-tbd" };
  };

  return (
    <div class="course-detail">
      <button type="button" class="btn btn-sm btn-ghost course-back" onClick={onBack}>
        <ArrowLeftIcon size={13} /> Courses
      </button>

      <div class="card course-detail-head">
        <span class="chip chip-org" style={orgStyle(code)}>{code}</span>
        <h3>{course.name || code}</h3>
        <p class="help">
          {card.sections.join(" · ")}
          {card.group ? ` · Group ${card.group}` : ""}
        </p>
      </div>

      {schemes.length > 1 ? (
        <label class="course-scheme">
          Grading scheme
          <select
            class="select"
            value={schemeIdx}
            onChange={(e) => setSchemeIdx(Number(/** @type {any} */ (e.target).value))}
          >
            {schemes.map((s, i) => (
              <option key={i} value={i}>{s.name || `Scheme ${i + 1}`}</option>
            ))}
          </select>
        </label>
      ) : null}

      {assessments.length ? (
        <div class="card">
          <table class="assess-table">
            <thead>
              <tr>
                <th>Component</th>
                <th class="num">Weight</th>
                <th class="num">Grade</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {assessments.map((a, i) => {
                const comp = summary.components.find((c) => c.component === a.component);
                const st = statusOf(a);
                return (
                  <tr key={i} class={st.cls === "st-tent" ? "tent" : ""}>
                    <td>{a.component}</td>
                    <td class="num tabular">{a.weight != null ? `${a.weight}%` : "—"}</td>
                    <td class="num tabular">
                      {comp && comp.grade
                        ? comp.grade.display ||
                          (typeof comp.grade.points === "number" && comp.grade.max
                            ? `${comp.grade.points}/${comp.grade.max}`
                            : "—")
                        : "—"}
                    </td>
                    <td class={`assess-when ${st.cls}`}>{st.label}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      <div class="card grade-card">
        <div class="grade-head">
          <h3>Grade calculator</h3>
          <label class="grade-target">
            Target{" "}
            <input
              class="input num-input"
              type="number"
              min={50}
              max={100}
              value={target}
              onChange={(e) =>
                setTarget(Math.max(50, Math.min(100, Number(/** @type {any} */ (e.target).value) || 80)))
              }
            />
            %
          </label>
        </div>
        {summary.current == null ? (
          <p class="help">No grades yet — the weights above are what's on the outline.</p>
        ) : (
          <>
            <p class="grade-line">
              <strong>{pct(summary.current)}</strong> over{" "}
              <span class="tabular">{Math.round(summary.gradedWeight)}%</span> graded ·{" "}
              <span class="tabular">{Math.round(summary.remainingWeight)}%</span> remaining
            </p>
            {summary.secured ? (
              <p class="grade-verdict ok">
                {summary.target}% is secured — even 0 on the rest keeps you at {pct(summary.current)}.
              </p>
            ) : summary.notReachable ? (
              <p class="grade-verdict danger">
                {summary.target}% isn't reachable on the remaining work (would need{" "}
                {pct(summary.needed)}).
              </p>
            ) : summary.needed != null ? (
              <p class="grade-verdict">
                Needs <strong>{pct(summary.needed)}</strong> on the remaining work for {summary.target}%.
              </p>
            ) : null}
          </>
        )}
        <p class="help">
          Based on the outline weights and Learn grades — your instructor's rules may differ.
        </p>
      </div>

      {topics.length ? (
        <div class="card">
          <h3>This week</h3>
          {topics.map((t, i) => (
            <p key={i} class="course-topic">{t}</p>
          ))}
        </div>
      ) : null}

      {instructors.length ? (
        <div class="card">
          <h3>Instructors</h3>
          {instructors.map((i) => (
            <p key={`${i.name}|${i.section || ""}`} class="course-topic">
              {i.name}
              {i.section ? <span class="help"> · {i.section}</span> : null}
              {i.email ? (
                <>
                  {" "}
                  · <a href={`mailto:${i.email}`}>{i.email}</a>
                </>
              ) : null}
            </p>
          ))}
        </div>
      ) : null}

      {officeHours ? (
        <div class="card">
          <h3>Office hours</h3>
          {(Array.isArray(officeHours) ? officeHours : [officeHours]).map((o, i) => (
            <p key={i} class="course-topic">{o}</p>
          ))}
        </div>
      ) : null}

      {upcoming.length ? (
        <section class="agenda-group">
          <h3 class="coop-h">Upcoming</h3>
          <div class="card row-card" role="list">
            {upcoming.map((it) => (
              <ItemRow key={it.id} item={it} now={now} actions={actions} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/* ---------------------------------- list ---------------------------------- */

/** @param {{state: any, actions: any, now: Date}} props */
export function Courses({ state, actions, now }) {
  const cards = useMemo(
    () => courseCards(state.courses, state.items, state.userState, now),
    [state.courses, state.items, state.userState, now]
  );
  const [selCode, setSelCode] = useState(() => query0("course"));
  const sel = selCode ? cards.find((c) => c.code === selCode) : null;

  if (sel) {
    return (
      <CourseDetail
        card={sel}
        state={state}
        actions={actions}
        now={now}
        onBack={() => setSelCode(null)}
      />
    );
  }

  return (
    <div class="courses">
      {!cards.length ? (
        <div class="card empty-card">
          <GraduationCapIcon size={20} />
          <h3>No courses yet</h3>
          <p class="help">
            Courses appear once Learn or an outline syncs. Check Sources if it's been a while.
          </p>
        </div>
      ) : null}
      {cards.map((c) => (
        <button
          key={c.code}
          type="button"
          class="card course-card"
          onClick={() => setSelCode(c.code)}
        >
          <div class="course-card-head">
            <span class="chip chip-org" style={orgStyle(c.code)}>{c.code}</span>
            <span class="course-name">{c.name}</span>
            <ChevronRightIcon size={14} />
          </div>
          <p class="course-meta">
            {c.sections.join(" · ")}
            {c.group ? ` · Group ${c.group}` : ""}
            {c.upcomingCount ? ` · ${c.upcomingCount} upcoming` : ""}
          </p>
          <p class="course-next tabular">
            {c.nextClass
              ? `Next class ${fmtDay(c.nextClass.startAt)} ${fmtTime(c.nextClass.startAt)}${c.nextClass.location ? ` · ${c.nextClass.location}` : ""}`
              : "No upcoming classes"}
            {c.nextDue ? ` — next due: ${c.nextDue.title} (${fmtDay(c.nextDue.dueAt)})` : ""}
          </p>
          <div class="course-links" onClick={(e) => e.stopPropagation()}>
            {c.learnUrl ? (
              <button type="button" class="btn btn-sm btn-ghost" onClick={() => actions.open(c.learnUrl)}>
                Learn <ExternalLinkIcon size={11} />
              </button>
            ) : null}
            {c.outlineUrl ? (
              <button type="button" class="btn btn-sm btn-ghost" onClick={() => actions.open(c.outlineUrl)}>
                Outline <ExternalLinkIcon size={11} />
              </button>
            ) : null}
            {c.syllabusUrls.map((s, i) => (
              <button
                key={i}
                type="button"
                class="btn btn-sm btn-ghost"
                onClick={() => actions.open(s.url)}
              >
                {s.title || "Syllabus"} <ExternalLinkIcon size={11} />
              </button>
            ))}
          </div>
        </button>
      ))}
    </div>
  );
}
