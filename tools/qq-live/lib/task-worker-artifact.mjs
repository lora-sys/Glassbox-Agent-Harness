import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fail } from "./core.mjs";

const NONCE = /^[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MARKER_NAME = ".qq-live-fixture.json";
const MAX_MARKER_BYTES = 64 * 1024;

function invalid() {
  fail(
    "TASK_WORKER_ARTIFACT_EVIDENCE",
    "Task worker artifact evidence is invalid.",
    "INCONCLUSIVE",
  );
}

function ordinaryDirectory(stat) {
  return stat.isDirectory() && !stat.isSymbolicLink();
}

function ordinaryFile(stat, maximumBytes) {
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.nlink === 1 &&
    Number.isSafeInteger(stat.size) &&
    stat.size > 0 &&
    stat.size <= maximumBytes
  );
}

function sameFile(left, right) {
  return (
    ordinaryFile(right, Number.MAX_SAFE_INTEGER) &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameDirectory(left, right) {
  return ordinaryDirectory(right) && left.dev === right.dev && left.ino === right.ino;
}

function sameNames(actual, expected) {
  const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
  const actualSorted = [...actual].sort(compare);
  const expectedSorted = [...expected].sort(compare);
  return (
    actualSorted.length === expectedSorted.length &&
    actualSorted.every((name, index) => name === expectedSorted[index])
  );
}

async function readBoundedFile(path, maximumBytes, handles) {
  const before = await lstat(path);
  if (!ordinaryFile(before, maximumBytes)) invalid();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  handles.push(handle);
  const opened = await handle.stat();
  if (!sameFile(before, opened)) invalid();
  const buffer = Buffer.alloc(maximumBytes + 1);
  let bytesRead = 0;
  while (bytesRead < buffer.length) {
    const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
    if (result.bytesRead === 0) break;
    bytesRead += result.bytesRead;
  }
  const bytes = buffer.subarray(0, bytesRead);
  const afterRead = await handle.stat();
  const afterPath = await lstat(path);
  if (
    bytes.length !== opened.size ||
    bytes.length > maximumBytes ||
    !sameFile(opened, afterRead) ||
    !sameFile(opened, afterPath)
  )
    invalid();
  return { handle, stat: opened, bytes };
}

/** Verify the single fixed Worker artifact in an isolated Task fixture root. */
export async function inspectTaskWorkerArtifact({
  fixtureNonce,
  canonicalRoot,
  markerSha256,
  workerBindingPath,
  productWorkspacePath,
} = {}) {
  if (
    typeof fixtureNonce !== "string" ||
    !NONCE.test(fixtureNonce) ||
    typeof canonicalRoot !== "string" ||
    !isAbsolute(canonicalRoot) ||
    resolve(canonicalRoot) !== canonicalRoot ||
    typeof markerSha256 !== "string" ||
    !SHA256.test(markerSha256) ||
    typeof workerBindingPath !== "string" ||
    typeof productWorkspacePath !== "string" ||
    process.platform !== "linux" ||
    !constants.O_NOFOLLOW ||
    !constants.O_DIRECTORY
  )
    invalid();

  const filename = `qq-live-worker-${fixtureNonce}.txt`;
  const expectedNames = [MARKER_NAME, filename];
  const expectedContent = Buffer.from(`${fixtureNonce}\n`, "utf8");
  const handles = [];
  let rootHandle;
  try {
    const rootBefore = await lstat(canonicalRoot);
    if (!ordinaryDirectory(rootBefore) || (await realpath(canonicalRoot)) !== canonicalRoot)
      invalid();
    rootHandle = await open(
      canonicalRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const rootOpened = await rootHandle.stat();
    if (!sameDirectory(rootBefore, rootOpened)) invalid();
    const rootFdPath = `/proc/self/fd/${rootHandle.fd}`;
    if ((await realpath(rootFdPath)) !== canonicalRoot) invalid();

    for (const candidatePath of [workerBindingPath, productWorkspacePath]) {
      if (
        !isAbsolute(candidatePath) ||
        resolve(candidatePath) !== canonicalRoot ||
        (await realpath(candidatePath)) !== canonicalRoot
      )
        invalid();
      const candidateStat = await lstat(candidatePath);
      if (!sameDirectory(rootOpened, candidateStat)) invalid();
    }

    const namesBefore = await readdir(rootFdPath);
    if (!sameNames(namesBefore, expectedNames)) invalid();

    const marker = await readBoundedFile(join(rootFdPath, MARKER_NAME), MAX_MARKER_BYTES, handles);
    const artifact = await readBoundedFile(
      join(rootFdPath, filename),
      expectedContent.length,
      handles,
    );
    if (
      createHash("sha256").update(marker.bytes).digest("hex") !== markerSha256 ||
      !artifact.bytes.equals(expectedContent)
    )
      invalid();

    const namesAfter = await readdir(rootFdPath);
    const rootAfter = await lstat(canonicalRoot);
    const rootOpenedAfter = await rootHandle.stat();
    if (
      !sameNames(namesAfter, expectedNames) ||
      !sameDirectory(rootOpened, rootAfter) ||
      !sameDirectory(rootOpened, rootOpenedAfter) ||
      (await realpath(canonicalRoot)) !== canonicalRoot ||
      !sameFile(marker.stat, await lstat(join(rootFdPath, MARKER_NAME))) ||
      !sameFile(marker.stat, await marker.handle.stat()) ||
      !sameFile(artifact.stat, await lstat(join(rootFdPath, filename))) ||
      !sameFile(artifact.stat, await artifact.handle.stat())
    )
      invalid();

    return {
      filename,
      sizeBytes: artifact.bytes.length,
      sha256: createHash("sha256").update(artifact.bytes).digest("hex"),
      fullContentVerified: true,
    };
  } catch {
    invalid();
  } finally {
    for (const handle of handles) await handle.close().catch(() => {});
    await rootHandle?.close().catch(() => {});
  }
}
