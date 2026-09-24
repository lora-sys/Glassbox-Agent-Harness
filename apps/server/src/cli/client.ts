// Local request bounds and deadlines adapted from t3code. See SOURCES.md.
import { CliError, hasControlCharacters, isRecord, responseError } from "./errors.ts";

export interface ManagementConnection {
  baseUrl: string;
  token: string;
}

export interface ManagementClientOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}

export interface ManagementRequest {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  query?: { cursor: string } | { channelId: string; groupId: string };
}

export function validCursor(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,1024}$/u.test(value);
}

function connectionOrigin(connection: ManagementConnection): string {
  let url: URL;
  try {
    url = new URL(connection.baseUrl);
  } catch {
    throw new CliError("INVALID_CONNECTION");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new CliError("INVALID_CONNECTION");
  if (
    !connection.token ||
    connection.token.length > 16384 ||
    /\s/u.test(connection.token) ||
    hasControlCharacters(connection.token)
  ) {
    throw new CliError("AUTH_REQUIRED");
  }
  return url.origin;
}

function positiveLimit(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new CliError("INVALID_ARGUMENTS");
  return value;
}

export function createManagementClient(
  connection: ManagementConnection,
  options: ManagementClientOptions = {},
) {
  const origin = connectionOrigin(connection);
  const fetchRequest = options.fetch ?? globalThis.fetch;
  const timeoutMs = positiveLimit(options.timeoutMs ?? 15_000, 300_000);
  const requestLimit = positiveLimit(options.maxRequestBytes ?? 64 * 1024, 1024 * 1024);
  const responseLimit = positiveLimit(
    options.maxResponseBytes ?? 2 * 1024 * 1024,
    16 * 1024 * 1024,
  );

  return {
    async request(request: ManagementRequest): Promise<unknown> {
      // Commands generate paths. Do not allow callers to change origin or escape /manage.
      if (
        !/^\/manage\/[a-zA-Z0-9_:/%-]+$/u.test(request.path) ||
        /%2e|%2f|%5c/iu.test(request.path)
      ) {
        throw new CliError("INVALID_ARGUMENTS");
      }
      if (request.method === "GET" && request.body !== undefined)
        throw new CliError("INVALID_ARGUMENTS");
      if (
        request.query !== undefined &&
        (request.method !== "GET" ||
          !isRecord(request.query) ||
          !validManagementQuery(request.query))
      )
        throw new CliError("INVALID_ARGUMENTS");
      const suffix =
        request.query === undefined ? "" : `?${new URLSearchParams(request.query).toString()}`;
      let body: string | undefined;
      try {
        body = request.body === undefined ? undefined : JSON.stringify(request.body);
      } catch {
        throw new CliError("INVALID_REQUEST");
      }
      if (body !== undefined && Buffer.byteLength(body, "utf8") > requestLimit)
        throw new CliError("REQUEST_TOO_LARGE");

      const controller = new AbortController();
      let rejectTimeout: (error: CliError) => void = () => undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        rejectTimeout = reject;
      });
      const timer = setTimeout(() => {
        rejectTimeout(new CliError("TIMEOUT"));
        controller.abort();
      }, timeoutMs);
      const perform = async () => {
        const response = await fetchRequest(`${origin}${request.path}${suffix}`, {
          method: request.method,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${connection.token}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body,
          redirect: "error",
          signal: controller.signal,
        });
        if (response.redirected || (response.status >= 300 && response.status < 400)) {
          controller.abort();
          throw new CliError("INVALID_RESPONSE");
        }
        const declaredLength = response.headers.get("content-length");
        if (
          declaredLength &&
          /^\d+$/u.test(declaredLength) &&
          Number(declaredLength) > responseLimit
        ) {
          controller.abort();
          throw new CliError("RESPONSE_TOO_LARGE");
        }
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        if (reader) {
          const cancelReader = () => {
            void reader.cancel().catch(() => undefined);
          };
          controller.signal.addEventListener("abort", cancelReader, { once: true });
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              bytes += chunk.value.byteLength;
              if (bytes > responseLimit) {
                controller.abort();
                throw new CliError("RESPONSE_TOO_LARGE");
              }
              chunks.push(chunk.value);
            }
          } finally {
            controller.signal.removeEventListener("abort", cancelReader);
            reader.releaseLock();
          }
        }
        const contentType = response.headers
          .get("content-type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase();
        let result: unknown;
        try {
          if (contentType !== "application/json") throw new Error();
          const decoder = new TextDecoder("utf-8", { fatal: true });
          result = JSON.parse(decoder.decode(Buffer.concat(chunks, bytes)));
          if (!isRecord(result) && !Array.isArray(result)) throw new Error();
        } catch {
          // A 401/403 remains actionable even if a proxy produced HTML instead of JSON.
          if (response.status === 401 || response.status === 403)
            throw responseError(response.status, undefined);
          throw new CliError("INVALID_RESPONSE");
        }
        if (!response.ok || (isRecord(result) && ("error" in result || result.ok === false))) {
          throw responseError(response.status, result);
        }
        return result;
      };
      try {
        return await Promise.race([perform(), timeout]);
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw new CliError(controller.signal.aborted ? "TIMEOUT" : "CONNECTION_FAILED");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function validManagementQuery(
  query: Record<string, unknown>,
): query is { cursor: string } | { channelId: string; groupId: string } {
  const keys = Object.keys(query).sort();
  if (keys.length === 1 && keys[0] === "cursor") return validCursor(query.cursor);
  return (
    keys.length === 2 &&
    keys[0] === "channelId" &&
    keys[1] === "groupId" &&
    typeof query.channelId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(query.channelId) &&
    typeof query.groupId === "string" &&
    /^[1-9]\d{0,15}$/u.test(query.groupId)
  );
}
