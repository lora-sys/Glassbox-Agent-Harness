import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";

export type IncomingImageMimeType = "image/png" | "image/jpeg" | "image/webp";
export type IncomingImageFailure =
  | "image_unavailable"
  | "image_invalid"
  | "image_too_large"
  | "image_timeout";

export interface IncomingImage {
  mimeType: IncomingImageMimeType;
  data: Buffer;
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_INCOMING_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 8192;
const MAX_IMAGE_PIXELS = 40_000_000;

function jpegDimensions(data: Buffer): { width: number; height: number } | undefined {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) return undefined;
    while (offset < data.length && data[offset] === 0xff) offset++;
    if (offset >= data.length) return undefined;
    const marker = data[offset++]!;
    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > data.length) return undefined;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) return undefined;
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker,
      )
    ) {
      if (length < 7) return undefined;
      return { height: data.readUInt16BE(offset + 3), width: data.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return undefined;
}

function dimensions(data: Buffer):
  | {
      mimeType: IncomingImageMimeType;
      width: number;
      height: number;
    }
  | undefined {
  if (
    data.length >= 24 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    data.toString("ascii", 12, 16) === "IHDR"
  )
    return {
      mimeType: "image/png",
      width: data.readUInt32BE(16),
      height: data.readUInt32BE(20),
    };

  const jpeg = jpegDimensions(data);
  if (jpeg) return { mimeType: "image/jpeg", ...jpeg };

  if (
    data.length >= 25 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP" &&
    data.readUInt32LE(4) + 8 === data.length
  )
    if (data.toString("ascii", 12, 16) === "VP8X" && data.length >= 30)
      return {
        mimeType: "image/webp",
        width: 1 + data[24]! + (data[25]! << 8) + (data[26]! << 16),
        height: 1 + data[27]! + (data[28]! << 8) + (data[29]! << 16),
      };
    else if (data.toString("ascii", 12, 16) === "VP8L" && data[20] === 0x2f)
      return {
        mimeType: "image/webp",
        width: 1 + data[21]! + ((data[22]! & 0x3f) << 8),
        height: 1 + ((data[22]! >> 6) | (data[23]! << 2) | ((data[24]! & 0x0f) << 10)),
      };
    else if (
      data.toString("ascii", 12, 16) === "VP8 " &&
      data.length >= 30 &&
      data[23] === 0x9d &&
      data[24] === 0x01 &&
      data[25] === 0x2a
    )
      return {
        mimeType: "image/webp",
        width: data.readUInt16LE(26) & 0x3fff,
        height: data.readUInt16LE(28) & 0x3fff,
      };
  return undefined;
}

export function validateIncomingImage(
  data: Buffer,
): { status: "ready"; image: IncomingImage } | { status: "failed"; code: IncomingImageFailure } {
  if (!Buffer.isBuffer(data) || data.length === 0)
    return { status: "failed", code: "image_invalid" };
  if (data.length > MAX_IMAGE_BYTES) return { status: "failed", code: "image_too_large" };
  const parsed = dimensions(data);
  if (!parsed || parsed.width < 1 || parsed.height < 1)
    return { status: "failed", code: "image_invalid" };
  if (
    parsed.width > MAX_IMAGE_DIMENSION ||
    parsed.height > MAX_IMAGE_DIMENSION ||
    parsed.width * parsed.height > MAX_IMAGE_PIXELS
  )
    return { status: "failed", code: "image_too_large" };
  return {
    status: "ready",
    image: { mimeType: parsed.mimeType, data: Buffer.from(data) },
  };
}

export function fitsIncomingImageBudget(currentBytes: number, nextBytes: number): boolean {
  return (
    Number.isSafeInteger(currentBytes) &&
    Number.isSafeInteger(nextBytes) &&
    currentBytes >= 0 &&
    nextBytes > 0 &&
    currentBytes + nextBytes <= MAX_INCOMING_IMAGE_BYTES
  );
}

/** Read only a regular file returned by the authenticated OneBot get_image API. */
export async function readOneBotImageFile(
  path: unknown,
  signal?: AbortSignal,
): Promise<
  { status: "ready"; image: IncomingImage } | { status: "failed"; code: IncomingImageFailure }
> {
  if (signal?.aborted) return { status: "failed", code: "image_timeout" };
  if (typeof path !== "string" || path.length > 4096 || !isAbsolute(path))
    return { status: "failed", code: "image_invalid" };
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return { status: "failed", code: "image_invalid" };
    if (stat.size <= 0) return { status: "failed", code: "image_invalid" };
    if (stat.size > MAX_IMAGE_BYTES) return { status: "failed", code: "image_too_large" };
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await file.stat();
    if (!opened.isFile() || opened.size <= 0) return { status: "failed", code: "image_invalid" };
    if (opened.size > MAX_IMAGE_BYTES) return { status: "failed", code: "image_too_large" };
    const data = Buffer.allocUnsafe(MAX_IMAGE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < data.length) {
      const result = await file.read(data, bytesRead, data.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (signal?.aborted) return { status: "failed", code: "image_timeout" };
    if (bytesRead > MAX_IMAGE_BYTES) return { status: "failed", code: "image_too_large" };
    return validateIncomingImage(data.subarray(0, bytesRead));
  } catch {
    return { status: "failed", code: "image_unavailable" };
  } finally {
    await file?.close().catch(() => undefined);
  }
}
