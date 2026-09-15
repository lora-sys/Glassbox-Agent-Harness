import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import lockfile from "proper-lockfile";
import { ModelProfileStore } from "../config/model-profiles.js";
import { createManagementAccess, loadManagementToken, ManagementError } from "./access.js";
import { createManagementHandler } from "./http.js";
import { ManagementApplication } from "./application.js";
import type { RunExecutionAdapter } from "../execution/run-service/types.js";

export function serverPort(value = process.env.PORT ?? "3030"): number {
  if (!/^\d{1,5}$/u.test(value)) throw new Error("PORT must be an integer between 0 and 65535");
  const port = Number(value);
  if (port > 65535) throw new Error("PORT must be an integer between 0 and 65535");
  return port;
}

/** One service owns each data directory. CLI clients never open its settings for writing. */
export async function openManagementRuntime(options: {
  dataDirectory: string;
  hosts: string[];
  origins: string[];
  status: () => unknown;
  doctor: () => unknown;
  databasePath?: string;
  executors?: ReadonlyMap<string, RunExecutionAdapter>;
}) {
  if (!isAbsolute(options.dataDirectory)) throw new Error("Data directory must be absolute");
  await mkdir(options.dataDirectory, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(options.dataDirectory, {
    lockfilePath: join(options.dataDirectory, "server.lock"),
    retries: 0,
  });
  let application: ManagementApplication | undefined;
  try {
    const token = await loadManagementToken(options.dataDirectory);
    const models = await ModelProfileStore.open(options.dataDirectory);
    application = await ManagementApplication.open({
      dataDirectory: options.dataDirectory,
      models,
      databasePath: options.databasePath,
      executors: options.executors,
    });
    let authorize = createManagementAccess({
      token,
      allowedHosts: options.hosts,
      allowedOrigins: options.origins,
    });
    const tickets = new Map<string, { sessionId: string; expiresAt: number }>();
    const issueTicket = (sessionId: unknown) => {
      if (typeof sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(sessionId)) {
        throw new ManagementError("INVALID_REQUEST", "Invalid session identifier");
      }
      const now = Date.now();
      for (const [ticket, entry] of tickets) if (entry.expiresAt <= now) tickets.delete(ticket);
      if (tickets.size >= 256)
        throw new ManagementError("RATE_LIMITED", "Too many pending connections", 429);
      const ticket = randomBytes(24).toString("base64url");
      tickets.set(ticket, { sessionId, expiresAt: now + 30_000 });
      return { ticket };
    };
    const authorizeSocket = (request: IncomingMessage) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const ticket = url.searchParams.get("ticket") ?? "";
      const entry = tickets.get(ticket);
      tickets.delete(ticket);
      if (
        !entry ||
        entry.expiresAt <= Date.now() ||
        entry.sessionId !== url.searchParams.get("sessionId")
      ) {
        throw new ManagementError("AUTH_REQUIRED", "A fresh connection ticket is required", 401);
      }
      // Apply the same transport checks without placing the management secret in the URL.
      const saved = request.headers.authorization;
      request.headers.authorization = `Bearer ${token}`;
      try {
        authorize(request);
      } finally {
        if (saved === undefined) delete request.headers.authorization;
        else request.headers.authorization = saved;
      }
    };
    const handle = createManagementHandler({
      authorize: (request) => authorize(request),
      models,
      status: options.status,
      doctor: options.doctor,
      issueTicket,
      route: (request) => application!.route(request),
    });
    let closed = false;
    return {
      models,
      application,
      authorize: (request: IncomingMessage) => authorize(request),
      authorizeSocket,
      handle,
      setBoundPort(port: number) {
        const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
        authorize = createManagementAccess({
          token,
          allowedHosts: hosts,
          allowedOrigins: [...options.origins, ...hosts.map((host) => `http://${host}`)],
        });
      },
      async close() {
        if (closed) return;
        closed = true;
        tickets.clear();
        await application?.close();
        await release();
      },
    };
  } catch (error) {
    await application?.close().catch(() => undefined);
    await release();
    throw error;
  }
}
