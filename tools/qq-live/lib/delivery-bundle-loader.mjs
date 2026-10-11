import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { digest, fail } from "./core.mjs";
import { parseDeliveryBundle } from "./delivery-bundle.mjs";

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_SUITE_BYTES = 100 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function invalid() {
  fail("DELIVERY_BUNDLE", "Delivery bundle manifest or suite files are invalid.");
}

function isWithin(root, path) {
  const relativePath = relative(root, path);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function sameFile(left, right) {
  return (
    right.isFile() &&
    !right.isSymbolicLink() &&
    right.nlink === 1n &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function resolveRepositoryPath(root, requestedPath) {
  if (typeof requestedPath !== "string" || requestedPath.length === 0) invalid();
  const candidate = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(root, requestedPath);
  if (!isWithin(root, candidate)) invalid();

  const pathFromRoot = relative(root, candidate);
  const parts = pathFromRoot.split(sep);
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    const info = await lstat(parent, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) invalid();
    const canonicalParent = await realpath(parent);
    if (canonicalParent !== parent || !isWithin(root, canonicalParent)) invalid();
  }

  const actual = await realpath(candidate);
  if (!isWithin(root, actual)) invalid();
  return candidate;
}

async function readBoundedFile(root, path, maximumBytes) {
  let handle;
  try {
    if (!constants.O_NOFOLLOW) invalid();
    const before = await lstat(path, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.size > BigInt(maximumBytes)
    )
      invalid();
    const canonicalPath = await realpath(path);
    if (!isWithin(root, canonicalPath)) invalid();

    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0),
    );
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(before, opened)) invalid();

    const buffer = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length !== Number(opened.size) || length > maximumBytes) invalid();

    const afterRead = await handle.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true });
    const canonicalAfter = await realpath(path);
    if (
      !sameFile(opened, afterRead) ||
      !sameFile(opened, afterPath) ||
      canonicalAfter !== canonicalPath ||
      !isWithin(root, canonicalAfter)
    )
      invalid();

    let text;
    try {
      text = decoder.decode(buffer.subarray(0, length));
    } catch {
      invalid();
    }
    return { bytes: buffer.subarray(0, length), text };
  } catch {
    invalid();
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Read either delivery input format through the same bounded repository boundary. */
export async function readRepositoryDeliverySuite(path, { repositoryRoot } = {}) {
  try {
    if (typeof repositoryRoot !== "string" || !repositoryRoot) invalid();
    const root = await realpath(repositoryRoot);
    const rootInfo = await lstat(root, { bigint: true });
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) invalid();
    const resolvedPath = await resolveRepositoryPath(root, path);
    return (await readBoundedFile(root, resolvedPath, MAX_SUITE_BYTES)).text;
  } catch {
    invalid();
  }
}
/**
 * Load an approved delivery manifest and its exact repository-relative suite files.
 * The caller remains responsible for resolving each suite against its strict contract.
 */
export async function loadDeliveryBundle(manifestPath, expectedSha256, { repositoryRoot } = {}) {
  try {
    if (
      typeof repositoryRoot !== "string" ||
      repositoryRoot.length === 0 ||
      typeof expectedSha256 !== "string" ||
      !SHA256.test(expectedSha256)
    )
      invalid();
    const canonicalRoot = await realpath(repositoryRoot);
    const rootInfo = await lstat(canonicalRoot, { bigint: true });
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) invalid();

    const resolvedManifest = await resolveRepositoryPath(canonicalRoot, manifestPath);
    const manifestFile = await readBoundedFile(canonicalRoot, resolvedManifest, MAX_MANIFEST_BYTES);
    const bundle = parseDeliveryBundle(manifestFile.text, expectedSha256);
    if (digest(manifestFile.bytes) !== bundle.manifestSha256) invalid();

    const suites = {};
    for (const entry of bundle.suites) {
      const memberPath = await resolveRepositoryPath(canonicalRoot, entry.path);
      const member = await readBoundedFile(canonicalRoot, memberPath, MAX_SUITE_BYTES);
      const memberSha256 = digest(member.bytes);
      if (memberSha256 !== entry.sha256) invalid();
      suites[entry.role] = Object.freeze({
        text: member.text,
        sha256: memberSha256,
      });
    }

    return Object.freeze({
      bundle,
      suites: Object.freeze(suites),
    });
  } catch {
    invalid();
  }
}
