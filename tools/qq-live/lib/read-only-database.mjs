import { DatabaseSync } from "node:sqlite";

export const READ_ONLY_DATABASE_TIMEOUT_MS = 5000;

export function openReadOnlyDatabase(path, { timeout = READ_ONLY_DATABASE_TIMEOUT_MS } = {}) {
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > READ_ONLY_DATABASE_TIMEOUT_MS)
    throw new RangeError("Read-only database timeout must be a non-negative integer.");
  return new DatabaseSync(path, { readOnly: true, timeout });
}
