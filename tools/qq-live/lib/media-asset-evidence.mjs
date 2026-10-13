import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fail } from "./core.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
};

function invalid() {
  fail("MEDIA_ASSET_EVIDENCE", "媒体文件的绑定或独立检查不完整。", "INCONCLUSIVE");
}

async function regularDirectory(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) invalid();
  return stat;
}

async function openBounded(path, limit) {
  const before = await lstat(path);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1 ||
    before.size <= 0 ||
    before.size > limit
  )
    invalid();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
      invalid();
    return { handle, before };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function sameFile(before, after) {
  return (
    after.isFile() &&
    !after.isSymbolicLink() &&
    after.nlink === 1 &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs
  );
}

function probeMedia(fd, capture) {
  const options = {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 256 * 1024,
    stdio: [fd, "pipe", "pipe"],
  };
  const probe = JSON.parse(
    capture(
      "/usr/bin/ffprobe",
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-show_entries",
        "format=duration:stream=codec_type,width,height,duration,avg_frame_rate",
        "-of",
        "json",
        "-i",
        "/proc/self/fd/0",
      ],
      options,
    ),
  );
  capture(
    "/usr/bin/ffmpeg",
    [
      "-nostdin",
      "-v",
      "error",
      "-xerror",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      "/proc/self/fd/0",
      "-map",
      "0:v:0",
      "-f",
      "null",
      "-",
    ],
    options,
  );
  const videos = probe.streams?.filter((stream) => stream.codec_type === "video");
  if (!Array.isArray(videos) || videos.length !== 1) invalid();
  const stream = videos[0];
  if (
    !Number.isSafeInteger(stream.width) ||
    !Number.isSafeInteger(stream.height) ||
    stream.width <= 0 ||
    stream.height <= 0 ||
    stream.width > 8192 ||
    stream.height > 8192
  )
    invalid();
  return { stream, format: probe.format };
}

function signatureMatches(data, mimeType) {
  if (mimeType === "image/png")
    return (
      data.length >= 24 &&
      data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      data.toString("ascii", 12, 16) === "IHDR"
    );
  if (mimeType === "image/jpeg")
    return (
      data.length >= 4 &&
      data[0] === 255 &&
      data[1] === 216 &&
      data.at(-2) === 255 &&
      data.at(-1) === 217
    );
  if (mimeType === "image/webp")
    return (
      data.length >= 12 &&
      data.toString("ascii", 0, 4) === "RIFF" &&
      data.toString("ascii", 8, 12) === "WEBP" &&
      data.readUInt32LE(4) + 8 === data.length
    );
  return (
    mimeType === "video/mp4" &&
    data.length >= 12 &&
    data.toString("ascii", 4, 8) === "ftyp" &&
    data.readUInt32BE(0) >= 12 &&
    data.readUInt32BE(0) <= data.length
  );
}

/** Read existing private Asset files without creating directories or mutating product state. */
export async function inspectRetainedMediaAsset(input, { capture = execFileSync } = {}) {
  let metadataFile, assetFile;
  try {
    const { dataDirectory, assetId, binding, stage } = input;
    if (
      !isAbsolute(dataDirectory ?? "") ||
      !UUID.test(assetId ?? "") ||
      !["image-1k", "video-4s"].includes(stage) ||
      ![binding?.principalId, binding?.conversationId, binding?.runId].every(
        (value) => typeof value === "string" && value,
      )
    )
      invalid();
    const root = join(dataDirectory, "media-assets");
    const directory = join(root, assetId);
    const rootBefore = await regularDirectory(root);
    const directoryBefore = await regularDirectory(directory);
    const metadataPath = join(directory, `${assetId}.json`);
    metadataFile = await openBounded(metadataPath, 8192);
    const metadataBytes = await metadataFile.handle.readFile();
    const metadata = JSON.parse(metadataBytes.toString("utf8"));
    if (
      Object.keys(metadata).sort().join(",") !==
        "conversationId,id,mimeType,principalId,runId,schemaVersion,sizeBytes" ||
      metadata.schemaVersion !== 1 ||
      metadata.id !== assetId ||
      !Object.hasOwn(EXTENSIONS, metadata.mimeType) ||
      Object.entries(binding).some(([key, value]) => metadata[key] !== value) ||
      !Number.isSafeInteger(metadata.sizeBytes) ||
      metadata.sizeBytes <= 0 ||
      (stage === "video-4s"
        ? metadata.mimeType !== "video/mp4"
        : !metadata.mimeType.startsWith("image/"))
    )
      invalid();
    const assetPath = join(directory, `${assetId}.${EXTENSIONS[metadata.mimeType]}`);
    assetFile = await openBounded(
      assetPath,
      stage === "video-4s" ? 16 * 1024 * 1024 : 8 * 1024 * 1024,
    );
    const data = await assetFile.handle.readFile();
    if (data.length !== metadata.sizeBytes || !signatureMatches(data, metadata.mimeType)) invalid();
    const { stream, format } = probeMedia(assetFile.handle.fd, capture);
    const facts = { width: stream.width, height: stream.height, fullDecodeVerified: true };
    if (stage === "image-1k") {
      if (stream.width !== 1024 || stream.height !== 1024) invalid();
    } else {
      const duration = Number(stream.duration ?? format?.duration);
      const rate = /^([1-9]\d*)\/([1-9]\d*)$/u.exec(stream.avg_frame_rate ?? "");
      const fps = rate ? Number(rate[1]) / Number(rate[2]) : NaN;
      if (
        !Number.isFinite(duration) ||
        !Number.isFinite(fps) ||
        fps < 1 ||
        fps > 120 ||
        Math.abs(duration - 4) > 1 / fps
      )
        invalid();
      facts.durationSeconds = duration;
      facts.framesPerSecond = fps;
      facts.durationToleranceSeconds = 1 / fps;
    }
    for (const [file, path] of [
      [metadataFile, metadataPath],
      [assetFile, assetPath],
    ]) {
      if (
        !sameFile(file.before, await file.handle.stat()) ||
        !sameFile(file.before, await lstat(path))
      )
        invalid();
    }
    for (const [before, path] of [
      [rootBefore, root],
      [directoryBefore, directory],
    ]) {
      const after = await regularDirectory(path);
      if (before.dev !== after.dev || before.ino !== after.ino) invalid();
    }
    return {
      assetId,
      mimeType: metadata.mimeType,
      sizeBytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
      ...facts,
      retained: true,
    };
  } catch {
    invalid();
  } finally {
    await metadataFile?.handle.close().catch(() => {});
    await assetFile?.handle.close().catch(() => {});
  }
}
