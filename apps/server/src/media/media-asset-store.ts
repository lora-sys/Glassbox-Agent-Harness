import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const MIME_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
} as const;
const MAX_ASSET_BYTES = 128 * 1024 * 1024;
const MAX_METADATA_BYTES = 8 * 1024;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const execFile = promisify(execFileCallback);

export interface MediaAssetBinding {
  principalId: string;
  conversationId: string;
  runId: string;
}

export type MediaAssetMimeType = keyof typeof MIME_EXTENSIONS;

export interface MediaAssetReference {
  id: string;
  mimeType: MediaAssetMimeType;
  sizeBytes: number;
}

interface MediaAssetMetadata extends MediaAssetReference, MediaAssetBinding {
  schemaVersion: 1;
}

function validateBinding(binding: MediaAssetBinding): void {
  if (
    !binding ||
    ![binding.principalId, binding.conversationId, binding.runId].every(
      (value) => typeof value === "string" && value.length > 0 && value.length <= 512,
    )
  )
    throw new Error("media_asset_invalid_binding");
}

function assertSupportedMimeType(mimeType: string): asserts mimeType is MediaAssetMimeType {
  if (!Object.hasOwn(MIME_EXTENSIONS, mimeType))
    throw new Error("media_asset_unsupported_mime_type");
}

function validateSignature(data: Buffer, mimeType: MediaAssetMimeType): void {
  const valid = (() => {
    switch (mimeType) {
      case "image/png":
        return (
          data.length >= 24 &&
          data.subarray(0, 8).equals(PNG_SIGNATURE) &&
          data.subarray(12, 16).toString("ascii") === "IHDR"
        );
      case "image/jpeg":
        return (
          data.length >= 4 &&
          data[0] === 0xff &&
          data[1] === 0xd8 &&
          data[data.length - 2] === 0xff &&
          data[data.length - 1] === 0xd9
        );
      case "image/webp":
        return (
          data.length >= 12 &&
          data.toString("ascii", 0, 4) === "RIFF" &&
          data.toString("ascii", 8, 12) === "WEBP" &&
          data.readUInt32LE(4) + 8 === data.length
        );
      case "video/mp4":
        return (
          data.length >= 12 &&
          data.toString("ascii", 4, 8) === "ftyp" &&
          data.readUInt32BE(0) >= 12 &&
          data.readUInt32BE(0) <= data.length
        );
    }
  })();
  if (!valid) throw new Error("media_asset_invalid_signature");
}

function parseData(
  base64Data: string | Buffer,
  mimeType: MediaAssetMimeType,
  maxBytes: number,
): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_ASSET_BYTES)
    throw new Error("media_asset_invalid_limit");
  if (Buffer.isBuffer(base64Data)) {
    if (base64Data.length > maxBytes) throw new Error("media_asset_too_large");
    validateSignature(base64Data, mimeType);
    return Buffer.from(base64Data);
  }
  if (typeof base64Data !== "string" || base64Data.length === 0 || !BASE64.test(base64Data))
    throw new Error("media_asset_invalid_base64");
  if (base64Data.length > Math.ceil(maxBytes / 3) * 4) throw new Error("media_asset_too_large");
  const data = Buffer.from(base64Data, "base64");
  if (data.toString("base64") !== base64Data) throw new Error("media_asset_invalid_base64");
  if (data.length > maxBytes) throw new Error("media_asset_too_large");
  validateSignature(data, mimeType);
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
  if (!systemRoot || !isAbsolute(systemRoot)) throw new Error("media_asset_acl_unavailable");
  const whoami = join(systemRoot, "System32", "whoami.exe");
  const icacls = join(systemRoot, "System32", "icacls.exe");
  const { stdout } = await execFile(whoami, ["/user", "/fo", "csv", "/nh"], {
    windowsHide: true,
  });
  const sid = stdout.match(/\bS-1-(?:[0-9]+-)+[0-9]+\b/u)?.[0];
  if (!sid) throw new Error("media_asset_acl_unavailable");
  await execFile(icacls, [path, "/reset"], { windowsHide: true });
  await execFile(icacls, [path, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`], {
    windowsHide: true,
  });
}

/** Stores private media outputs as opaque, Run-bound files under the service data directory. */
export class MediaAssetStore {
  private constructor(private readonly root: string) {}

  static async open(dataDirectory: string): Promise<MediaAssetStore> {
    if (typeof dataDirectory !== "string" || !isAbsolute(dataDirectory))
      throw new Error("media_asset_invalid_data_directory");
    try {
      await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
      const dataRoot = await realpath(dataDirectory);
      const root = join(dataRoot, "media-assets");
      await mkdir(root, { mode: 0o700 }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      const stat = await lstat(root);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("media_asset_invalid_root");
      await secureDirectory(root);
      return new MediaAssetStore(root);
    } catch (error) {
      if (error instanceof Error && error.message === "media_asset_invalid_root") throw error;
      throw new Error("media_asset_store_unavailable", { cause: error });
    }
  }

  async write(
    binding: MediaAssetBinding,
    mimeType: MediaAssetMimeType,
    base64Data: string | Buffer,
    maxBytes: number,
  ): Promise<MediaAssetReference> {
    validateBinding(binding);
    assertSupportedMimeType(mimeType);
    const data = parseData(base64Data, mimeType, maxBytes);
    const id = randomUUID();
    const temporary = join(this.root, `.tmp-${randomUUID()}`);
    const destination = join(this.root, id);
    const metadata: MediaAssetMetadata = {
      schemaVersion: 1,
      id,
      mimeType,
      sizeBytes: data.length,
      principalId: binding.principalId,
      conversationId: binding.conversationId,
      runId: binding.runId,
    };

    try {
      await mkdir(temporary, { mode: 0o700 });
      await secureDirectory(temporary);
      const extension = MIME_EXTENSIONS[mimeType];
      await writePrivateFile(join(temporary, `${id}.${extension}`), data);
      await writePrivateFile(join(temporary, `${id}.json`), JSON.stringify(metadata));
      await rename(temporary, destination);
      return { id, mimeType, sizeBytes: data.length };
    } catch {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      throw new Error("media_asset_write_failed");
    }
  }

  async read(
    id: string,
    binding: MediaAssetBinding,
  ): Promise<{ data: Buffer; mimeType: MediaAssetMimeType; sizeBytes: number }> {
    validateBinding(binding);
    if (typeof id !== "string" || !UUID.test(id)) throw new Error("media_asset_not_found");
    const directory = join(this.root, id);
    try {
      const directoryStat = await lstat(directory);
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory())
        throw new Error("media_asset_invalid");
      const metadataPath = join(directory, `${id}.json`);
      const [metadataStat, serialized] = await Promise.all([
        lstat(metadataPath),
        readFile(metadataPath, "utf8"),
      ]);
      if (
        metadataStat.isSymbolicLink() ||
        !metadataStat.isFile() ||
        metadataStat.size > MAX_METADATA_BYTES
      )
        throw new Error("media_asset_invalid");
      const metadata = JSON.parse(serialized) as MediaAssetMetadata;
      if (
        metadata.schemaVersion !== 1 ||
        metadata.id !== id ||
        typeof metadata.mimeType !== "string" ||
        !Object.hasOwn(MIME_EXTENSIONS, metadata.mimeType) ||
        !Number.isSafeInteger(metadata.sizeBytes) ||
        metadata.sizeBytes <= 0 ||
        metadata.sizeBytes > MAX_ASSET_BYTES
      )
        throw new Error("media_asset_invalid");
      if (
        metadata.principalId !== binding.principalId ||
        metadata.conversationId !== binding.conversationId ||
        metadata.runId !== binding.runId
      )
        throw new Error("media_asset_denied");

      const mimeType = metadata.mimeType as MediaAssetMimeType;
      const assetPath = join(directory, `${id}.${MIME_EXTENSIONS[mimeType]}`);
      const assetStat = await lstat(assetPath);
      if (
        assetStat.isSymbolicLink() ||
        !assetStat.isFile() ||
        assetStat.size > MAX_ASSET_BYTES ||
        assetStat.size !== metadata.sizeBytes
      )
        throw new Error("media_asset_invalid");
      const data = await readFile(assetPath);
      if (data.length !== metadata.sizeBytes) throw new Error("media_asset_invalid");
      validateSignature(data, mimeType);
      return { data, mimeType, sizeBytes: data.length };
    } catch (error) {
      if (
        error instanceof Error &&
        ["media_asset_invalid", "media_asset_denied"].includes(error.message)
      )
        throw error;
      throw new Error("media_asset_not_found");
    }
  }

  /** Return only the binding from a private asset record so Delivery can reauthorize its Run. */
  async binding(id: string): Promise<MediaAssetBinding> {
    if (typeof id !== "string" || !UUID.test(id)) throw new Error("media_asset_not_found");
    const directory = join(this.root, id);
    try {
      const directoryStat = await lstat(directory);
      const metadataPath = join(directory, `${id}.json`);
      const [metadataStat, serialized] = await Promise.all([
        lstat(metadataPath),
        readFile(metadataPath, "utf8"),
      ]);
      if (
        directoryStat.isSymbolicLink() ||
        !directoryStat.isDirectory() ||
        metadataStat.isSymbolicLink() ||
        !metadataStat.isFile() ||
        metadataStat.size > MAX_METADATA_BYTES
      )
        throw new Error("media_asset_invalid");
      const metadata = JSON.parse(serialized) as MediaAssetMetadata;
      if (
        metadata.schemaVersion !== 1 ||
        metadata.id !== id ||
        typeof metadata.principalId !== "string" ||
        typeof metadata.conversationId !== "string" ||
        typeof metadata.runId !== "string"
      )
        throw new Error("media_asset_invalid");
      const binding = {
        principalId: metadata.principalId,
        conversationId: metadata.conversationId,
        runId: metadata.runId,
      };
      validateBinding(binding);
      return binding;
    } catch (error) {
      if (error instanceof Error && error.message === "media_asset_invalid") throw error;
      throw new Error("media_asset_not_found");
    }
  }
}
