// @ts-check
// Post-update re-sync: an extension upgrade can change adapter mappings
// (e.g. WaterlooWorks co-op important-dates categories), so interval-syncing
// adapters run once right after onInstalled("update") instead of waiting
// for their next alarm.

/**
 * Adapters that re-sync after an extension update: real sync impls on a
 * repeating interval (observe-only and interval-less adapters gain nothing).
 * @param {({id: string, sync?: Function, intervalMinutes?: number} | null)[] | null | undefined} adapters
 * @returns {{id: string, sync?: Function, intervalMinutes?: number}[]}
 */
export function adaptersToSyncOnUpdate(adapters) {
  return /** @type {{id: string, sync?: Function, intervalMinutes?: number}[]} */ (
    (adapters || []).filter(
      (a) => a && typeof a.sync === "function" && Number(a.intervalMinutes) > 0
    )
  );
}
