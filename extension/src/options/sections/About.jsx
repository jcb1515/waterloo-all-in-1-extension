// About: version, open-source licenses link, privacy statement.

import { Card } from "../bits.jsx";
import { IS_PREVIEW } from "../../panel/data.js";
import { ExternalLinkIcon } from "../../ui/icons.jsx";

export function AboutSection() {
  let version = "0.0.1";
  let licensesUrl = "/licenses/THIRD_PARTY_NOTICES.txt";
  try {
    if (!IS_PREVIEW) {
      version = chrome.runtime.getManifest().version;
      licensesUrl = chrome.runtime.getURL("licenses/THIRD_PARTY_NOTICES.txt");
    }
  } catch {
    /* preview */
  }
  return (
    <div class="opt-stack">
      <Card title="Waterloo All-in-1">
        <p class="about-version tabular">Version {version}</p>
        <p class="help">
          Every Waterloo deadline, class, interview and meeting in one side panel and one Google
          Calendar.
        </p>
        <p class="about-links">
          <a href={licensesUrl} target="_blank" rel="noreferrer">
            Open-source licenses <ExternalLinkIcon size={12} />
          </a>
        </p>
      </Card>
      <Card title="Privacy">
        <p class="help">Everything stays on this computer unless you turn on calendar sync.</p>
      </Card>
    </div>
  );
}
