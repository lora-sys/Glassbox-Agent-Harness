import { decodeDoctor, decodeModelList, decodeModelResult, decodeStatus } from "./schema";
import type { ModelSave } from "./schema";
import {
  RUN_INTEGRITY_SUITE,
  type ChannelSaveInput,
  type ClaudeExecutorSettings,
} from "@glassbox/contracts";
import { decodeChannelList, decodeChannelResult } from "./channel-schema";
import {
  decodeConversations,
  decodeRuns,
  decodeRunResult,
  decodeDeliveries,
  decodeTrace,
} from "./records-schema";
import { decodeEvalPage, decodeEvalResult } from "./eval-schema";
import { decodeExecutorList, decodeExecutorResult } from "./executor-schema";

import { ManagementApiError } from "./errors";
import { isManagementToken, managementFetch } from "./access";
export { isManagementToken } from "./access";

export function takeFragmentToken(
  location: Pick<Location, "hash" | "pathname" | "search">,
  history: Pick<History, "replaceState" | "state">,
): string | null {
  const params = new URLSearchParams(location.hash.replace(/^#/u, ""));
  if (!params.has("access_token")) return null;
  const token = params.get("access_token") ?? "";
  // Remove credentials before making requests or rendering a link from this URL.
  history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  return isManagementToken(token) ? token : null;
}

interface ApiOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export function createManagementApi(token: string, options: ApiOptions = {}) {
  const fetchRequest = options.fetch ?? globalThis.fetch;

  async function request<T>(
    path: string,
    decode: (value: unknown) => T,
    input?: {
      body?: unknown;
      signal?: AbortSignal;
      query?: { cursor?: string; conversationId?: string };
      maxResponseBytes?: number;
      timeoutMs?: number;
    },
  ): Promise<T> {
    if (!isManagementToken(token)) throw new ManagementApiError("UNAUTHORIZED");
    if (!/^\/[a-zA-Z0-9_/-]+$/u.test(path)) throw new ManagementApiError("INVALID_INPUT");
    const query = new URLSearchParams();
    if (input?.query?.cursor !== undefined) {
      if (!/^[A-Za-z0-9_-]{1,4096}$/u.test(input.query.cursor))
        throw new ManagementApiError("INVALID_INPUT");
      query.set("cursor", input.query.cursor);
    }
    if (input?.query?.conversationId !== undefined) {
      if (!/^[A-Za-z0-9-]{1,80}$/u.test(input.query.conversationId))
        throw new ManagementApiError("INVALID_INPUT");
      query.set("conversationId", input.query.conversationId);
    }
    if (input?.signal?.aborted) throw new ManagementApiError("ABORTED");
    const body = input?.body === undefined ? undefined : JSON.stringify(input.body);
    if (body && new TextEncoder().encode(body).byteLength > 65536)
      throw new ManagementApiError("TOO_LARGE");
    const controller = new AbortController();
    let timedOut = false;
    let rejectDeadline: (error: ManagementApiError) => void = () => undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const onAbort = () => {
      rejectDeadline(new ManagementApiError("ABORTED"));
      controller.abort();
    };
    input?.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => {
        timedOut = true;
        rejectDeadline(new ManagementApiError("TIMEOUT"));
        controller.abort();
      },
      options.timeoutMs ?? input?.timeoutMs ?? 15000,
    );
    const perform = async () => {
      const response = await managementFetch(
        `/api/manage${path}${query.size ? `?${query.toString()}` : ""}`,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body,
          signal: controller.signal,
          redirect: "error",
          credentials: "same-origin",
          cache: "no-store",
        },
        { token, fetch: fetchRequest },
      );
      if (response.redirected || (response.status >= 300 && response.status < 400))
        throw new ManagementApiError("INVALID_RESPONSE");
      if (response.status === 401) throw new ManagementApiError("UNAUTHORIZED");
      if (response.status === 403) throw new ManagementApiError("FORBIDDEN");
      if (response.status === 404)
        throw new ManagementApiError(
          path.startsWith("/runs/") ? "RECORD_UNAVAILABLE" : "NOT_AVAILABLE",
        );
      if (response.status === 409 && path.startsWith("/channels"))
        throw new ManagementApiError("CHANNEL_ACTIVE");
      if (response.status === 409 && path.startsWith("/runs/"))
        throw new ManagementApiError("RUN_CHANGED");
      if (response.status === 409 && path.startsWith("/executors"))
        throw new ManagementApiError("EXECUTOR_BUSY");
      if (
        [502, 503, 504].includes(response.status) &&
        response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
          "application/json"
      )
        throw new ManagementApiError("SERVICE_UNAVAILABLE");
      const limit = options.maxResponseBytes ?? input?.maxResponseBytes ?? 2 * 1024 * 1024;
      const declaredLength = response.headers.get("content-length");
      if (declaredLength && /^\d+$/u.test(declaredLength) && Number(declaredLength) > limit)
        throw new ManagementApiError("TOO_LARGE");
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
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > limit) {
              cancel();
              throw new ManagementApiError("TOO_LARGE");
            }
            chunks.push(part.value);
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
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
      } catch {
        throw new ManagementApiError("INVALID_RESPONSE");
      }
      if (!response.ok) {
        throw new ManagementApiError(
          response.status === 400
            ? path.startsWith("/channels")
              ? "INVALID_CHANNEL"
              : path.startsWith("/executors")
                ? "INVALID_EXECUTOR"
                : path.startsWith("/runs") || path === "/conversations"
                  ? "INVALID_RECORD_INPUT"
                  : "INVALID_CONFIGURATION"
            : "SERVER_ERROR",
        );
      }
      if (value && typeof value === "object" && "error" in value)
        throw new ManagementApiError("SERVER_ERROR");
      // Management responses must never return bearer or submitted API credentials.
      const serialized = JSON.stringify(value);
      const submittedKey =
        input?.body && typeof input.body === "object" && "apiKey" in input.body
          ? input.body.apiKey
          : null;
      const submittedToken =
        input?.body && typeof input.body === "object" && "token" in input.body
          ? input.body.token
          : null;
      if (
        serialized.includes(token) ||
        (typeof submittedKey === "string" &&
          submittedKey.length > 0 &&
          serialized.includes(submittedKey)) ||
        (typeof submittedToken === "string" &&
          submittedToken.length > 0 &&
          serialized.includes(submittedToken))
      )
        throw new ManagementApiError("INVALID_RESPONSE");
      return decode(value);
    };
    try {
      return await Promise.race([perform(), deadline]);
    } catch (error) {
      if (error instanceof ManagementApiError) throw error;
      throw new ManagementApiError(
        timedOut ? "TIMEOUT" : controller.signal.aborted ? "ABORTED" : "CONNECTION_FAILED",
      );
    } finally {
      clearTimeout(timer);
      input?.signal?.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }

  return {
    request,
    status: (signal?: AbortSignal) => request("/status", decodeStatus, { signal }),
    doctor: (signal?: AbortSignal) => request("/doctor", decodeDoctor, { signal }),
    models: (signal?: AbortSignal) => request("/models", decodeModelList, { signal }),
    saveModel: (body: ModelSave, signal?: AbortSignal) =>
      request("/models", decodeModelResult, { body, signal }),
    channels: (signal?: AbortSignal) => request("/channels", decodeChannelList, { signal }),
    saveChannel: (body: ChannelSaveInput, signal?: AbortSignal) =>
      request("/channels", decodeChannelResult, { body, signal }),
    connectChannel: (id: string, signal?: AbortSignal) =>
      request(channelActionPath(id, "connect"), decodeChannelResult, { body: {}, signal }),
    disconnectChannel: (id: string, signal?: AbortSignal) =>
      request(channelActionPath(id, "disconnect"), decodeChannelResult, { body: {}, signal }),
    conversations: (query: { cursor?: string } = {}, signal?: AbortSignal) =>
      request("/conversations", decodeConversations, { query, signal }),
    runs: (query: { cursor?: string; conversationId?: string } = {}, signal?: AbortSignal) =>
      request(
        "/runs",
        (value) => {
          const page = decodeRuns(value);
          if (
            query.conversationId &&
            page.items.some((run) => run.conversationId !== query.conversationId)
          )
            throw new ManagementApiError("INVALID_RESPONSE");
          return page;
        },
        { query, signal, maxResponseBytes: 8 * 1024 * 1024 },
      ),
    run: (id: string, signal?: AbortSignal) =>
      request(runPath(id), (value) => decodeRunResult(value, id), { signal }),
    cancelRun: (id: string, signal?: AbortSignal) =>
      request(`${runPath(id)}/cancel`, (value) => decodeRunResult(value, id), { body: {}, signal }),
    deliveries: (id: string, query: { cursor?: string } = {}, signal?: AbortSignal) =>
      request(`${runPath(id)}/deliveries`, (value) => decodeDeliveries(value, id), {
        query,
        signal,
        maxResponseBytes: 8 * 1024 * 1024,
      }),
    trace: (id: string, query: { cursor?: string } = {}, signal?: AbortSignal) =>
      request(`${runPath(id)}/trace`, (value) => decodeTrace(value, id), {
        query,
        signal,
        maxResponseBytes: 9 * 1024 * 1024,
      }),
    evaluations: (id: string, query: { cursor?: string } = {}, signal?: AbortSignal) =>
      request(`${runPath(id)}/evals`, (value) => decodeEvalPage(value, id), {
        query,
        signal,
        maxResponseBytes: 8 * 1024 * 1024,
      }),
    evaluateRun: (id: string, signal?: AbortSignal) =>
      request(`${runPath(id)}/evals`, (value) => decodeEvalResult(value, id), {
        body: { suiteId: RUN_INTEGRITY_SUITE },
        signal,
      }),
    executors: (signal?: AbortSignal) => request("/executors", decodeExecutorList, { signal }),
    saveExecutor: (body: ClaudeExecutorSettings, signal?: AbortSignal) =>
      request("/executors", decodeExecutorResult, { body, signal }),
    checkClaudeExecutor: (signal?: AbortSignal) =>
      request("/executors/claude-code/check", decodeExecutorResult, {
        body: {},
        signal,
        timeoutMs: 120000,
      }),
  };
}

export type ManagementApi = ReturnType<typeof createManagementApi>;

function channelActionPath(id: string, action: "connect" | "disconnect"): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u.test(id)) throw new ManagementApiError("INVALID_INPUT");
  return `/channels/${id}/${action}`;
}

function runPath(id: string): string {
  if (!/^[A-Za-z0-9-]{1,80}$/u.test(id)) throw new ManagementApiError("INVALID_INPUT");
  return `/runs/${id}`;
}
