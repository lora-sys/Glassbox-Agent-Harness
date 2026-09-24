import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { BrowserArtifactReference } from "./browser-executor-port.js";
import type { BrowserSessionBinding } from "./browser-session.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_METADATA_BYTES = 8 * 1024;
const execFile = promisify(execFileCallback);

interface BrowserArtifactMetadata extends BrowserArtifactReference, BrowserSessionBinding {
  schemaVersion: 1;
  mimeType: "image/png";
  sizeBytes: number;
}

function validateBinding(binding: BrowserSessionBinding): void {
  if (
    !binding ||
    ![
      binding.principalId,
      binding.runId,
      binding.conversationId,
      binding.workspaceId,
      binding.policyVersion,
    ].every((value) => typeof value === "string" && value.length > 0 && value.length <= 512) ||
    (binding.purpose !== undefined && binding.purpose !== "tool" && binding.purpose !== "fallback")
  )
    throw new Error("browser_artifact_invalid_binding");
}

function metadataMatchesBinding(
  metadata: BrowserArtifactMetadata,
  binding: BrowserSessionBinding,
): boolean {
  return (
    metadata.principalId === binding.principalId &&
    metadata.runId === binding.runId &&
    metadata.conversationId === binding.conversationId &&
    metadata.workspaceId === binding.workspaceId &&
    metadata.policyVersion === binding.policyVersion &&
    (metadata.purpose ?? "tool") === (binding.purpose ?? "tool")
  );
}

function parsePng(base64Png: string, maxBytes: number): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_ARTIFACT_BYTES)
    throw new Error("browser_artifact_invalid_limit");
  if (typeof base64Png !== "string" || base64Png.length === 0 || !BASE64.test(base64Png))
    throw new Error("browser_artifact_invalid_base64");
  if (base64Png.length > Math.ceil(maxBytes / 3) * 4) throw new Error("browser_artifact_too_large");
  const data = Buffer.from(base64Png, "base64");
  if (data.toString("base64") !== base64Png) throw new Error("browser_artifact_invalid_base64");
  if (data.length > maxBytes) throw new Error("browser_artifact_too_large");
  if (
    data.length < PNG_SIGNATURE.length ||
    !data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  )
    throw new Error("browser_artifact_invalid_png");
  return data;
}

async function writePrivateFile(path: string, data: string | Buffer): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(data);
    await file.sync();
    await file.chmod(0o600);
  } finally {
    await file.close();
  }
}

async function secureDirectory(path: string): Promise<void> {
  await chmod(path, 0o700);
  if (process.platform !== "win32") return;

  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) throw new Error("browser_artifact_acl_unavailable");
  const whoami = join(systemRoot, "System32", "whoami.exe");
  const icacls = join(systemRoot, "System32", "icacls.exe");
  const { stdout } = await execFile(whoami, ["/user", "/fo", "csv", "/nh"], {
    windowsHide: true,
  });
  const sid = stdout.match(/\bS-1-(?:[0-9]+-)+[0-9]+\b/u)?.[0];
  if (!sid) throw new Error("browser_artifact_acl_unavailable");
  await execFile(icacls, [path, "/reset"], { windowsHide: true });
  await execFile(icacls, [path, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`], {
    windowsHide: true,
  });
}

/** Stores browser screenshots as private, binding-scoped files under the service data directory. */
export class BrowserArtifactStore {
  private constructor(private readonly root: string) {}

  static async open(dataDirectory: string): Promise<BrowserArtifactStore> {
    if (typeof dataDirectory !== "string" || !isAbsolute(dataDirectory))
      throw new Error("browser_artifact_invalid_data_directory");
    try {
      await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
      const dataRoot = await realpath(dataDirectory);
      const root = join(dataRoot, "browser-artifacts");
      await mkdir(root, { mode: 0o700 }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      const stat = await lstat(root);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error("browser_artifact_invalid_root");
      await secureDirectory(root);
      return new BrowserArtifactStore(root);
    } catch (error) {
      if (error instanceof Error && error.message === "browser_artifact_invalid_root") throw error;
      throw new Error("browser_artifact_store_unavailable", { cause: error });
    }
  }

  async write(
    binding: BrowserSessionBinding,
    base64Png: string,
    maxBytes: number,
  ): Promise<BrowserArtifactReference> {
    validateBinding(binding);
    const data = parsePng(base64Png, maxBytes);
    const id = randomUUID();
    const temporary = join(this.root, `.tmp-${randomUUID()}`);
    const destination = join(this.root, id);
    const metadata: BrowserArtifactMetadata = {
      schemaVersion: 1,
      id,
      mimeType: "image/png",
      sizeBytes: data.length,
      principalId: binding.principalId,
      runId: binding.runId,
      conversationId: binding.conversationId,
      workspaceId: binding.workspaceId,
      policyVersion: binding.policyVersion,
      ...(binding.purpose ? { purpose: binding.purpose } : {}),
    };

    try {
      await mkdir(temporary, { mode: 0o700 });
      await secureDirectory(temporary);
      await writePrivateFile(join(temporary, `${id}.png`), data);
      await writePrivateFile(join(temporary, `${id}.json`), JSON.stringify(metadata));
      await rename(temporary, destination);
      return { id, mimeType: "image/png", sizeBytes: data.length };
    } catch {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      throw new Error("browser_artifact_write_failed");
    }
  }

  async read(
    id: string,
    binding: BrowserSessionBinding,
  ): Promise<{ data: Buffer; mimeType: "image/png"; sizeBytes: number }> {
    validateBinding(binding);
    if (typeof id !== "string" || !UUID.test(id)) throw new Error("browser_artifact_not_found");
    const directory = join(this.root, id);
    try {
      const directoryStat = await lstat(directory);
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory())
        throw new Error("browser_artifact_invalid");
      const metadataPath = join(directory, `${id}.json`);
      const imagePath = join(directory, `${id}.png`);
      const [metadataStat, imageStat, serialized] = await Promise.all([
        lstat(metadataPath),
        lstat(imagePath),
        readFile(metadataPath, "utf8"),
      ]);
      if (
        metadataStat.isSymbolicLink() ||
        !metadataStat.isFile() ||
        metadataStat.size > MAX_METADATA_BYTES ||
        imageStat.isSymbolicLink() ||
        !imageStat.isFile() ||
        imageStat.size > MAX_ARTIFACT_BYTES
      )
        throw new Error("browser_artifact_invalid");
      const metadata = JSON.parse(serialized) as BrowserArtifactMetadata;
      if (
        metadata.schemaVersion !== 1 ||
        metadata.id !== id ||
        metadata.mimeType !== "image/png" ||
        !Number.isSafeInteger(metadata.sizeBytes) ||
        metadata.sizeBytes !== imageStat.size
      )
        throw new Error("browser_artifact_invalid");
      if (!metadataMatchesBinding(metadata, binding)) throw new Error("browser_artifact_denied");
      const data = await readFile(imagePath);
      if (
        data.length !== metadata.sizeBytes ||
        data.length < PNG_SIGNATURE.length ||
        !data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
      )
        throw new Error("browser_artifact_invalid");
      return { data, mimeType: "image/png", sizeBytes: data.length };
    } catch (error) {
      if (
        error instanceof Error &&
        ["browser_artifact_invalid", "browser_artifact_denied"].includes(error.message)
      )
        throw error;
      throw new Error("browser_artifact_not_found");
    }
  }

  /** Resolve the private Run binding recorded with an Artifact without accepting it from a caller. */
  async binding(id: string): Promise<BrowserSessionBinding> {
    if (typeof id !== "string" || !UUID.test(id)) throw new Error("browser_artifact_not_found");
    const directory = join(this.root, id);
    try {
      const directoryStat = await lstat(directory);
      const metadataPath = join(directory, `${id}.json`);
      const imagePath = join(directory, `${id}.png`);
      const [metadataStat, imageStat, serialized] = await Promise.all([
        lstat(metadataPath),
        lstat(imagePath),
        readFile(metadataPath, "utf8"),
      ]);
      if (
        directoryStat.isSymbolicLink() ||
        !directoryStat.isDirectory() ||
        metadataStat.isSymbolicLink() ||
        !metadataStat.isFile() ||
        metadataStat.size > MAX_METADATA_BYTES ||
        imageStat.isSymbolicLink() ||
        !imageStat.isFile() ||
        imageStat.size > MAX_ARTIFACT_BYTES
      )
        throw new Error("browser_artifact_invalid");
      const metadata = JSON.parse(serialized) as BrowserArtifactMetadata;
      if (
        metadata.schemaVersion !== 1 ||
        metadata.id !== id ||
        metadata.mimeType !== "image/png" ||
        !Number.isSafeInteger(metadata.sizeBytes) ||
        metadata.sizeBytes !== imageStat.size
      )
        throw new Error("browser_artifact_invalid");
      const binding: BrowserSessionBinding = {
        runId: metadata.runId,
        principalId: metadata.principalId,
        conversationId: metadata.conversationId,
        workspaceId: metadata.workspaceId,
        policyVersion: metadata.policyVersion,
        ...(metadata.purpose ? { purpose: metadata.purpose } : {}),
      };
      validateBinding(binding);
      return binding;
    } catch (error) {
      if (error instanceof Error && error.message === "browser_artifact_invalid") throw error;
      throw new Error("browser_artifact_not_found");
    }
  }
}
