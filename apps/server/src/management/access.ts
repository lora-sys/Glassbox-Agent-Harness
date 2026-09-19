// Timing-safe credential comparison adapted from t3code auth/utils.ts. See SOURCES.md.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { isAbsolute, join } from "node:path";

export class ManagementError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "ManagementError";
  }
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export async function loadManagementToken(dataDirectory: string): Promise<string> {
  if (!isAbsolute(dataDirectory))
    throw new ManagementError("INVALID_DIRECTORY", "Data directory must be absolute");
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const path = join(dataDirectory, "management-token");
  try {
    const token = (await readFile(path, "utf8")).trim();
    if (!TOKEN_PATTERN.test(token))
      throw new ManagementError("INVALID_KEY_FILE", "Invalid management key file");
    return token;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const token = randomBytes(32).toString("base64url");
  let handle: FileHandle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new ManagementError(
        "DIRECTORY_BUSY",
        "Another server is initializing this data directory",
        409,
      );
    }
    throw new ManagementError("KEY_SAVE_FAILED", "Could not save management key", 500);
  }
  try {
    try {
      await handle.writeFile(token, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    await unlink(path).catch(() => undefined);
    throw new ManagementError("KEY_SAVE_FAILED", "Could not save management key", 500);
  }
  return token;
}

export function createManagementAccess(options: {
  token: string;
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
}) {
  if (!TOKEN_PATTERN.test(options.token))
    throw new ManagementError("INVALID_KEY", "Invalid management key");
  const expected = Buffer.from(options.token, "utf8");
  const hosts = new Set(options.allowedHosts);
  const origins = new Set(options.allowedOrigins);
  return (request: IncomingMessage): void => {
    const address = request.socket.remoteAddress;
    if (
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address ?? "") ||
      !hosts.has(request.headers.host ?? "")
    ) {
      throw new ManagementError("FORBIDDEN", "Management access is local only", 403);
    }
    if (request.headers.origin !== undefined && !origins.has(request.headers.origin)) {
      throw new ManagementError("FORBIDDEN", "Request origin is not allowed", 403);
    }
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const actual = Buffer.from(token, "utf8");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new ManagementError("UNAUTHORIZED", "A management key is required", 401);
    }
  };
}
