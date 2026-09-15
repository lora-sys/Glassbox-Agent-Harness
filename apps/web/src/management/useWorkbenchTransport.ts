import { useCallback, useEffect, useRef } from "react";
import { createWorkbenchTransport } from "./workbench-transport";
import { ManagementApiError } from "./errors";

export function useWorkbenchTransport(token: string | null) {
  const transport = useRef<ReturnType<typeof createWorkbenchTransport> | null>(null);
  useEffect(() => {
    const current = createWorkbenchTransport({ readToken: () => token });
    transport.current = current;
    return () => {
      current.dispose();
      if (transport.current === current) transport.current = null;
    };
  }, [token]);
  const request = useCallback(
    (path: string, init?: RequestInit) => {
      if (!transport.current) return Promise.reject(new ManagementApiError("ABORTED"));
      return transport.current.request(path, init);
    },
    [token],
  );
  const openSocket = useCallback(
    (sessionId: string, signal?: AbortSignal) => {
      if (!transport.current) return Promise.reject(new ManagementApiError("ABORTED"));
      return transport.current.openSocket(sessionId, signal);
    },
    [token],
  );
  return { request, openSocket };
}
