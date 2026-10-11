// Only repository-owned, non-mutating Owner-private baseline cases are eligible.
const FIXED_READ_CASE_IDS = new Set([
  "qq-group-a-root-files-read",
  "qq-group-a-info-read",
  "ops-status-read",
  "qq-account-status-read",
  "qq-managed-groups-inventory-read",
]);

export function isFixedPreRunReadCase(id) {
  return typeof id === "string" && FIXED_READ_CASE_IDS.has(id);
}
