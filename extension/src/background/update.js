// @ts-check
// Post-update re-sync: an extension upgrade can change adapter mappings
// (e.g. WaterlooWorks co-op important-dates categories), so interval-syncing
// adapters run once right after onInstalled("update") instead of waiting
// for their next alarm.

/**
 * Adapters that re-sync after an extension update: real sync impls on a
 * repeating interval (observe-only and interval-less adapters gain nothing).
 * @param {{sync?: Function, intervalMinutes?: number}[] | null | undefined} adapters
 */
export function adaptersToSyncOnUpdate(adapters) {
  return (adapters || []).filter(
    (a) => a && typeof a.sync === "function" && a.intervalMinutes > 0
  );
}
