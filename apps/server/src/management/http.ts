import type { IncomingMessage, ServerResponse } from "node:http";
import { ConfigurationError, type ModelProfileStore } from "../config/model-profiles.js";
import { ManagementError } from "./access.js";

function reply(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

export function readManagementJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
    request.resume();
    return Promise.reject(
      new ManagementError("INVALID_CONTENT_TYPE", "Expected application/json", 415),
    );
  }
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const fail = (error: ManagementError) => {
      if (settled) return;
      settled = true;
      chunks = [];
      reject(error);
    };
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > 65536)
        fail(new ManagementError("BODY_TOO_LARGE", "Request body is too large", 413));
      else chunks.push(chunk);
    });
    request.once("end", () => {
      if (settled) return;
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        settled = true;
        chunks = [];
        resolve(body);
      } catch {
        fail(new ManagementError("INVALID_JSON", "Invalid JSON body"));
      }
    });
    request.once("error", () =>
      fail(new ManagementError("REQUEST_FAILED", "Request could not be read")),
    );
    request.once("aborted", () =>
      fail(new ManagementError("REQUEST_ABORTED", "Request was interrupted")),
    );
  });
}

/** Both local CLI and WebUI use this boundary; channel adapters do not receive access. */
export function createManagementHandler(options: {
  authorize: (request: IncomingMessage) => void;
  models: ModelProfileStore;
  status: () => unknown;
  doctor: () => unknown;
  issueTicket?: (sessionId: unknown) => unknown;
  route?: (request: IncomingMessage) => Promise<{ status: number; body: unknown } | undefined>;
}) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const path = request.url?.split("?")[0];
    if (path !== "/manage" && !path?.startsWith("/manage/")) return false;
    try {
      options.authorize(request);
      if (request.method === "GET" && path === "/manage/status")
        reply(response, 200, await options.status());
      else if (request.method === "GET" && path === "/manage/doctor")
        reply(response, 200, await options.doctor());
      else if (request.method === "GET" && path === "/manage/models")
        reply(response, 200, { profiles: options.models.list() });
      else if (request.method === "POST" && path === "/manage/models") {
        reply(response, 200, {
          profile: await options.models.save(await readManagementJson(request)),
        });
      } else if (request.method === "POST" && path === "/manage/ws-ticket" && options.issueTicket) {
        const input = await readManagementJson(request);
        if (!input || typeof input !== "object" || !("sessionId" in input))
          throw new ManagementError("INVALID_REQUEST", "A session identifier is required");
        reply(response, 200, options.issueTicket(input.sessionId));
      } else {
        const routed = await options.route?.(request);
        if (routed) reply(response, routed.status, routed.body);
        else
          reply(response, 404, {
            error: { code: "NOT_AVAILABLE", message: "This management operation is not available" },
          });
      }
    } catch (error) {
      request.resume();
      if (error instanceof ManagementError)
        reply(response, error.status, { error: { code: error.code, message: error.message } });
      else if (error instanceof ConfigurationError)
        reply(response, 400, { error: { code: "INVALID_CONFIGURATION", message: error.message } });
      else
        reply(response, 500, {
          error: { code: "INTERNAL_ERROR", message: "Management operation failed" },
        });
    }
    return true;
  };
}
