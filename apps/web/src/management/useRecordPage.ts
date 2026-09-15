import { useCallback, useEffect, useState } from "react";
import { failureMessage, ManagementApiError } from "./errors";

/** Keeps one bounded page. Parent identity changes remount the reader to discard old scope data. */
export function useRecordPage<T extends { nextCursor: string | null }>(
  load: (cursor: string | undefined, signal: AbortSignal) => Promise<T>,
  options: { active?: boolean; pollMs?: number } = {},
) {
  const [data, setData] = useState<T | null>(null);
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const active = options.active !== false;
  const pollMs = options.pollMs ?? 0;
  const cursor = cursors[page];

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      setLoading(true);
      try {
        const result = await load(cursor, controller.signal);
        if (cursor !== undefined && result.nextCursor === cursor)
          throw new ManagementApiError("INVALID_RESPONSE");
        if (!controller.signal.aborted) {
          setData(result);
          setError("");
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setData(null);
          setError(failureMessage(error));
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          if (pollMs > 0)
            timer = setTimeout(() => {
              void read();
            }, pollMs);
        }
      }
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [load, cursor, active, pollMs, revision]);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  function next() {
    if (loading || !data?.nextCursor) return;
    setCursors((values) => [...values.slice(0, page + 1), data.nextCursor!]);
    setData(null);
    setError("");
    setLoading(true);
    setPage((value) => value + 1);
  }
  function previous() {
    if (loading || page === 0) return;
    setData(null);
    setError("");
    setLoading(true);
    setPage((value) => value - 1);
  }
  function first() {
    setCursors([undefined]);
    setData(null);
    setError("");
    setLoading(true);
    setPage(0);
    refresh();
  }
  return { data, page, loading, error, refresh, next, previous, first };
}
