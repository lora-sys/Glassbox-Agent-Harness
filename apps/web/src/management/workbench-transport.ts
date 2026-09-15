import { managementFetch, readManagementAccess } from "./access";
import { ManagementApiError } from "./errors";

interface TransportOptions {
  fetch?: typeof globalThis.fetch;
  readToken?: () => string | null;
  createSocket?: (url: string) => WebSocket;
  timeoutMs?: number;
}

export function createWorkbenchTransport(options: TransportOptions = {}) {
  const pending = new Set<AbortController>();
  const sockets = new Set<WebSocket>();
  let disposed = false;

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    if (disposed || init.signal?.aborted) throw new ManagementApiError("ABORTED");
    const token = (options.readToken ?? readManagementAccess)();
    const controller = new AbortController();
    pending.add(controller);
    let rejectDeadline: (error: ManagementApiError) => void = () => undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const onAbort = () => rejectDeadline(new ManagementApiError("ABORTED"));
    const relayAbort = () => controller.abort();
    controller.signal.addEventListener("abort", onAbort, { once: true });
    init.signal?.addEventListener("abort", relayAbort, { once: true });
    const timer = setTimeout(() => {
      rejectDeadline(new ManagementApiError("TIMEOUT"));
      controller.abort();
    }, options.timeoutMs ?? 15000);
    const perform = async () => {
      const response = await managementFetch(
        path,
        { ...init, signal: controller.signal },
        { token, fetch: options.fetch },
      );
      if (!response.ok)
        throw new ManagementApiError(
          response.status === 404
            ? "NOT_AVAILABLE"
            : response.status === 400
              ? "INVALID_INPUT"
              : "SERVER_ERROR",
        );
      if (
        response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json"
      )
        throw new ManagementApiError("INVALID_RESPONSE");
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (reader) {
        const cancel = () => {
          void reader.cancel().catch(() => undefined);
        };
        controller.signal.addEventListener("abort", cancel, { once: true });
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 16 * 1024 * 1024) {
              cancel();
              throw new ManagementApiError("TOO_LARGE");
            }
            chunks.push(chunk.value);
          }
        } finally {
          controller.signal.removeEventListener("abort", cancel);
          reader.releaseLock();
        }
      }
      const buffer = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.byteLength;
      }
      let text: string;
      let value: unknown;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
        value = JSON.parse(text);
      } catch {
        throw new ManagementApiError("INVALID_RESPONSE");
      }
      if (!value || typeof value !== "object" || (token && JSON.stringify(value).includes(token)))
        throw new ManagementApiError("INVALID_RESPONSE");
      if ("error" in value && value.error) throw new ManagementApiError("SERVER_ERROR");
      return new Response(text, {
        status: response.status,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      return await Promise.race([perform(), deadline]);
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", relayAbort);
      controller.signal.removeEventListener("abort", onAbort);
      pending.delete(controller);
      controller.abort();
    }
  }

  async function openSocket(sessionId: string, signal?: AbortSignal): Promise<WebSocket> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/u.test(sessionId))
      throw new ManagementApiError("INVALID_INPUT");
    const response = await request("/api/manage/ws-ticket", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
      signal,
    });
    const value: unknown = await response.json();
    if (
      !value ||
      typeof value !== "object" ||
      !("ticket" in value) ||
      typeof value.ticket !== "string" ||
      !/^[a-zA-Z0-9_-]{20,128}$/u.test(value.ticket)
    )
      throw new ManagementApiError("INVALID_RESPONSE");
    if (disposed || signal?.aborted) throw new ManagementApiError("ABORTED");
    const socket = (options.createSocket ?? ((url) => new WebSocket(url)))(
      `/ws?sessionId=${encodeURIComponent(sessionId)}&ticket=${encodeURIComponent(value.ticket)}`,
    );
    sockets.add(socket);
    const onAbort = () => {
      socket.close();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.addEventListener(
      "close",
      () => {
        sockets.delete(socket);
        signal?.removeEventListener("abort", onAbort);
      },
      { once: true },
    );
    return socket;
  }

  return {
    request,
    openSocket,
    dispose() {
      disposed = true;
      for (const controller of pending) controller.abort();
      for (const socket of sockets) socket.close();
      pending.clear();
      sockets.clear();
    },
  };
}
