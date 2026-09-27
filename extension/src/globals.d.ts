// Baked in by tools/build.mjs via esbuild `define` — the contents of the
// gitignored repo-root dev-profile.json, or null when it doesn't exist.
// See dev-profile.example.json for the shape (DEFAULT_SETTINGS overrides).
declare const __WA1_DEV_PROFILE__: Record<string, any> | null;

// Baked in by tools/build.mjs from the WA1_CALENDAR_SERVICE_URL environment
// variable ("" when unset): a hosted feed server URL a released build can
// ship as the default calendar.serviceUrl. Saved settings still win.
declare const __WA1_CALENDAR_SERVICE_URL__: string;
