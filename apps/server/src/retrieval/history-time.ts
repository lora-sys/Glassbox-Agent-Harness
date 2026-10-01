/** History uses Date.parse's existing input formats and integer millisecond precision. */
export function historyTimestamp(value: unknown, errorCode = "invalid_history_timestamp"): number {
  if (typeof value !== "string") throw new Error(errorCode);
  const timestamp = Date.parse(value);
  if (!Number.isSafeInteger(timestamp)) throw new Error(errorCode);
  return timestamp;
}

export function historyTimeWindow(input: { since?: unknown; until?: unknown }): {
  since?: string;
  until?: string;
  sinceMs?: number;
  untilMs?: number;
} {
  const sinceMs =
    input.since === undefined
      ? undefined
      : historyTimestamp(input.since, "invalid_history_time_bound");
  const untilMs =
    input.until === undefined
      ? undefined
      : historyTimestamp(input.until, "invalid_history_time_bound");
  if (sinceMs !== undefined && untilMs !== undefined && sinceMs > untilMs)
    throw new Error("invalid_history_time_range");
  return {
    ...(sinceMs === undefined ? {} : { since: new Date(sinceMs).toISOString(), sinceMs }),
    ...(untilMs === undefined ? {} : { until: new Date(untilMs).toISOString(), untilMs }),
  };
}

export function historyLimit(value: unknown, fallback: number, maximum: number): number {
  const limit = value === undefined ? fallback : value;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > maximum)
    throw new Error("invalid_history_limit");
  return limit;
}
