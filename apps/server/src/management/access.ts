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
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

/** Deployment-configurable widening of the local-only management boundary (IPv4 CIDRs or bare addresses). */
export function parseManagementNetworks(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") return [];
  const networks = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (networks.length === 0) return [];
  for (const network of networks) {
    const [base, suffix] = network.split("/", 2);
    const bits = suffix === undefined ? undefined : Number(suffix);
    if (
      base === undefined ||
      !IPV4_PATTERN.test(base) ||
      base.split(".").some((part) => Number(part) > 255) ||
      (bits !== undefined && (!Number.isInteger(bits) || bits < 0 || bits > 32))
    )
      throw new ManagementError("INVALID_NETWORK", `Invalid management network: ${network}`, 400);
  }
  return networks;
}

function ipv4ToNumber(value: string): number {
  const [a, b, c, d] = value.split(".").map((part) => Number(part));
  return (((a ?? 0) << 24) | ((b ?? 0) << 16) | ((c ?? 0) << 8) | (d ?? 0)) >>> 0;
}

export function addressInNetworks(
  address: string | undefined,
  networks: readonly string[],
): boolean {
  if (!address || networks.length === 0) return false;
  // Node reports IPv4 peers as IPv4-mapped IPv6 addresses on dual-stack sockets.
  const mapped = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  if (!IPV4_PATTERN.test(mapped)) return false;
  const addressKey = ipv4ToNumber(mapped);
  return networks.some((network) => {
    const [base, suffix] = network.split("/", 2);
    const bits = suffix === undefined ? 32 : Number(suffix);
    if (bits === 0) return true;
    const mask = bits >= 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
    return ((ipv4ToNumber(base ?? "") ^ addressKey) & mask) === 0;
  });
}

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
  allowedNetworks?: readonly string[];
}) {
  if (!TOKEN_PATTERN.test(options.token))
    throw new ManagementError("INVALID_KEY", "Invalid management key");
  const expected = Buffer.from(options.token, "utf8");
  const hosts = new Set(options.allowedHosts);
  const origins = new Set(options.allowedOrigins);
  const networks = options.allowedNetworks ?? [];
  return (request: IncomingMessage): void => {
    const address = request.socket.remoteAddress;
    const isLocal = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address ?? "");
    if (
      (!isLocal && !addressInNetworks(address, networks)) ||
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
