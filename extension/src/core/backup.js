// @ts-check
/*
  Settings backup: pure helpers for the About section's export/import.

  The payload carries only user-owned data: settings, per-item edits
  (userState), manual items and imported outline files. It never includes
  `calendarFeed` (feed url/token secrets), source raws or discovery data.
*/

export const BACKUP_VERSION = 1;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Download name for the export: waterloo-all-in-1-backup-YYYY-MM-DD.json.
 * @param {Date} [now]
 */
export function backupFileName(now = new Date()) {
  return `waterloo-all-in-1-backup-${now.toISOString().slice(0, 10)}.json`;
}

/**
 * Build the backup payload.
 * @param {{settings?: any, userState?: any, manualItems?: any[],
 *   outlineFiles?: any[], projects?: any[], now?: Date}} input
 */
export function buildBackup({
  settings,
  userState,
  manualItems,
  outlineFiles,
  projects,
  now = new Date(),
} = {}) {
  return {
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    settings: isObj(settings) ? settings : {},
    userState: isObj(userState) ? userState : {},
    manualItems: Array.isArray(manualItems) ? manualItems : [],
    outlineFiles: Array.isArray(outlineFiles) ? outlineFiles : [],
    projects: Array.isArray(projects) ? projects : [],
  };
}

/**
 * Validate a parsed backup file. Returns `{ok:false, error}` or
 * `{ok:true, summary}` where summary counts what's inside.
 * @param {any} obj
 */
export function validateBackup(obj) {
  if (!isObj(obj)) return { ok: false, error: "That file isn't a backup." };
  if (obj.version !== BACKUP_VERSION)
    return { ok: false, error: `Unsupported backup version ${String(obj.version)}.` };
  for (const key of ["settings", "userState"]) {
    if (obj[key] != null && !isObj(obj[key]))
      return { ok: false, error: `Backup field "${key}" is malformed.` };
  }
  for (const key of ["manualItems", "outlineFiles", "projects"]) {
    if (obj[key] != null && !Array.isArray(obj[key]))
      return { ok: false, error: `Backup field "${key}" is malformed.` };
  }
  const settings = isObj(obj.settings) ? obj.settings : {};
  const userState = isObj(obj.userState) ? obj.userState : {};
  const manualItems = Array.isArray(obj.manualItems) ? obj.manualItems : [];
  const outlineFiles = Array.isArray(obj.outlineFiles) ? obj.outlineFiles : [];
  const projects = Array.isArray(obj.projects) ? obj.projects : [];
  return {
    ok: true,
    summary: {
      settingsSections: Object.keys(settings).length,
      itemEdits: Object.keys(userState).length,
      manualItems: manualItems.length,
      outlineFiles: outlineFiles.length,
      projects: projects.length,
    },
  };
}

/**
 * Produce the storage writes for an import. Settings, manual items and
 * outline files are replaced; userState is merged per id with the imported
 * values winning. Projects are replaced only when the backup carries them —
 * an older backup without the key keeps the existing list.
 * @param {any} backup a backup that passed validateBackup
 * @param {{userState?: any}} current current storage slices used for merging
 */
export function applyBackup(backup, { userState } = {}) {
  return {
    settings: isObj(backup.settings) ? backup.settings : {},
    userState: { ...(isObj(userState) ? userState : {}), ...(isObj(backup.userState) ? backup.userState : {}) },
    manualItems: Array.isArray(backup.manualItems) ? backup.manualItems : [],
    outlineFiles: Array.isArray(backup.outlineFiles) ? backup.outlineFiles : [],
    ...(Array.isArray(backup.projects) ? { projects: backup.projects } : {}),
  };
}
