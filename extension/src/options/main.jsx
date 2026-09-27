// Options page shell: sticky left nav + hash-routed sections, saved toast.

import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useStore, IS_PREVIEW } from "../panel/data.js";
import { setSettings } from "../core/store.js";
import { BrandMark } from "../ui/brand.jsx";
import { WelcomeSection } from "./sections/Welcome.jsx";
import { GeneralSection } from "./sections/General.jsx";
import { ProfileSection } from "./sections/Profile.jsx";
import { SourcesSection } from "./sections/SourcesSection.jsx";
import { CalendarSection } from "./sections/Calendar.jsx";
import { RemindersSection } from "./sections/Reminders.jsx";
import { PrivacySection } from "./sections/Privacy.jsx";
import { AboutSection } from "./sections/About.jsx";

const SECTIONS = [
  ["welcome", "Welcome", WelcomeSection],
  ["general", "General", GeneralSection],
  ["profile", "Profile", ProfileSection],
  ["sources", "Sources", SourcesSection],
  ["calendar", "Calendar", CalendarSection],
  ["reminders", "Reminders", RemindersSection],
  ["privacy", "Privacy & discovery", PrivacySection],
  ["about", "About", AboutSection],
];

function currentSection() {
  const h = (location.hash || "#general").slice(1);
  return SECTIONS.some(([id]) => id === h) ? h : "general";
}

function OptionsApp() {
  const state = useStore();
  const [section, setSection] = useState(currentSection);
  const [toast, setToast] = useState(false);
  const toastTimer = useRef(/** @type {any} */ (null));

  useEffect(() => {
    const onHash = () => setSection(currentSection());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const save = useMemo(
    () => (patch) => {
      const done = () => {
        setToast(true);
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(false), 1400);
      };
      if (IS_PREVIEW) {
        done();
        return;
      }
      setSettings(patch).then(done).catch(() => {});
    },
    []
  );

  const found = SECTIONS.find(([id]) => id === section) || SECTIONS[0];
  const activeLabel = found[1];
  const ActiveView = found[2];

  return (
    <div class="opt-page">
      <aside class="opt-nav">
        <div class="brand-lockup">
          <BrandMark size={34} />
          <div class="brand-words">
            <span class="brand-top">Waterloo</span>
            <span class="brand-name">All-in-1</span>
          </div>
        </div>
        <nav class="opt-nav-links" aria-label="Settings sections">
          {SECTIONS.map(([id, label]) => (
            <a
              key={id}
              href={`#${id}`}
              class={id === section ? "active" : ""}
              aria-current={id === section ? "page" : undefined}
            >
              {label}
            </a>
          ))}
        </nav>
      </aside>
      <main class="opt-content">
        <h1 class="opt-heading">{activeLabel}</h1>
        {state.ready ? (
          <ActiveView settings={state.settings} save={save} now={new Date()} state={state} />
        ) : (
          <div class="opt-stack">
            <div class="skeleton" style={{ height: "140px" }} />
            <div class="skeleton" style={{ height: "140px" }} />
          </div>
        )}
      </main>
      <div class={`toast${toast ? " show" : ""}`} role="status">
        Saved
      </div>
    </div>
  );
}

render(<OptionsApp />, document.body);
