import { constants } from "node:fs";
import { open, mkdir, lstat, link, unlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { fail } from "./core.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_RECORD_BYTES = 3 * 1024 * 1024;

function assertSupportedPlatform() {
  if (process.platform !== "linux")
    fail("AGENT_REVIEW_PLATFORM", "Agent review receipts require Linux directory fsync support.");
}

export function defaultAgentReviewStoreDirectory(homeDirectory = homedir()) {
  return join(homeDirectory, ".glassbox-qq-live-locks", "agent-reviews");
}

function recordPath(directory, bindingSha256) {
  if (!SHA256.test(bindingSha256 ?? ""))
    fail("AGENT_REVIEW_STORE", "Review binding hash is invalid.");
  return join(directory, `${bindingSha256}.json`);
}

function inside(root, target) {
  const difference = relative(root, target);
  return difference === "" || (difference !== ".." && !difference.startsWith(`..${sep}`));
}

async function inspectAncestorsWithoutSymlinks(path) {
  const target = resolve(path);
  const root = parse(target).root;
  const components = target.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  let nearestExisting = root;
  for (let index = 0; index < components.length; index += 1) {
    current = join(current, components[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
    if (info.isSymbolicLink())
      fail("AGENT_REVIEW_STORE", "Review receipt paths cannot contain symbolic links.");
    if (index < components.length - 1 && !info.isDirectory())
      fail("AGENT_REVIEW_STORE", "Review receipt path ancestors must be directories.");
    nearestExisting = current;
  }
  const canonicalAncestor = await realpath(nearestExisting);
  if (canonicalAncestor !== nearestExisting)
    fail("AGENT_REVIEW_STORE", "Review receipt paths must use canonical non-symlink ancestors.");
  return { target, canonicalAncestor };
}

async function ensureOutsideRepository(path, repositoryRoot) {
  const root = await realpath(repositoryRoot);
  const { target, canonicalAncestor } = await inspectAncestorsWithoutSymlinks(path);
  if (inside(root, target) || inside(root, canonicalAncestor))
    fail("AGENT_REVIEW_STORE", "Review receipt storage must be outside the repository.");
}

function validateEnvelope(value, bindingSha256) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "artifactBase64,receipt,schemaVersion" ||
    value.schemaVersion !== 1 ||
    typeof value.artifactBase64 !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value.artifactBase64,
    ) ||
    value.receipt?.bindingSha256 !== bindingSha256
  )
    fail("AGENT_REVIEW_STORE", "Stored review receipt is invalid.");
  return value;
}

function descriptorPath(handle) {
  return `/proc/self/fd/${handle.fd}`;
}

async function verifyDirectoryHandle(directory, handle, repositoryRoot, fs) {
  const expected = resolve(directory);
  const openedPath = await fs.realpath(descriptorPath(handle));
  const canonicalRoot = await fs.realpath(repositoryRoot);
  const info = await handle.stat();
  const pathInfo = await fs.lstat(expected);
  if (
    openedPath !== expected ||
    inside(canonicalRoot, openedPath) ||
    !info.isDirectory() ||
    pathInfo.isSymbolicLink() ||
    !pathInfo.isDirectory() ||
    pathInfo.dev !== info.dev ||
    pathInfo.ino !== info.ino
  )
    fail("AGENT_REVIEW_STORE", "Review receipt directory changed during the operation.");
  await inspectAncestorsWithoutSymlinks(expected);
}

async function openSecureDirectory(directory, repositoryRoot, fs) {
  const target = resolve(directory);
  const canonicalRoot = await fs.realpath(repositoryRoot);
  if (inside(canonicalRoot, target))
    fail("AGENT_REVIEW_STORE", "Review receipt storage must be outside the repository.");

  const filesystemRoot = parse(target).root;
  const components = target.slice(filesystemRoot.length).split(sep).filter(Boolean);
  let expected = filesystemRoot;
  let current = await fs.open(
    filesystemRoot,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    for (const component of components) {
      const childPath = join(descriptorPath(current), component);
      let child;
      try {
        child = await fs.open(
          childPath,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        await fs.mkdir(childPath, { mode: 0o700 });
        child = await fs.open(
          childPath,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
      }
      expected = join(expected, component);
      const actual = await fs.realpath(descriptorPath(child));
      if (actual !== expected || inside(canonicalRoot, actual)) {
        await child.close();
        fail("AGENT_REVIEW_STORE", "Review receipt path contains a redirected directory.");
      }
      await current.close();
      current = child;
    }
    await fs.afterDirectoryOpen?.({ directory: target, handle: current });
    await verifyDirectoryHandle(target, current, repositoryRoot, fs);
    return current;
  } catch (error) {
    await current.close().catch(() => undefined);
    throw error;
  }
}

/** Atomically write one immutable receipt and its original artifact outside the checkout. */
export async function writeAgentReviewRecord({
  directory = defaultAgentReviewStoreDirectory(),
  repositoryRoot,
  receipt,
  artifactBytes,
  io = {},
}) {
  assertSupportedPlatform();
  if (!(typeof artifactBytes === "string" || artifactBytes instanceof Uint8Array))
    fail("AGENT_REVIEW_STORE", "Review artifact bytes are required.");
  const path = recordPath(directory, receipt?.bindingSha256);
  await ensureOutsideRepository(path, repositoryRoot);
  const artifactBase64 = Buffer.from(artifactBytes).toString("base64");
  const envelope = { schemaVersion: 1, receipt, artifactBase64 };
  const bytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  if (bytes.length > MAX_RECORD_BYTES)
    fail("AGENT_REVIEW_STORE", "Review receipt exceeds its size limit.");

  const fs = { open, mkdir, lstat, link, unlink, realpath, ...io };
  const directoryHandle = await openSecureDirectory(directory, repositoryRoot, fs);
  const directoryPath = descriptorPath(directoryHandle);
  const temporaryPath = join(directoryPath, `.agent-review-${randomUUID()}.tmp`);
  const storedPath = join(directoryPath, `${receipt.bindingSha256}.json`);
  let published = false;
  let complete = false;
  let failure;
  try {
    await directoryHandle.chmod(0o700);
    await directoryHandle.sync();
    const handle = await fs.open(temporaryPath, "wx", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await verifyDirectoryHandle(directory, directoryHandle, repositoryRoot, fs);
    await fs.link(temporaryPath, storedPath);
    published = true;
    await verifyDirectoryHandle(directory, directoryHandle, repositoryRoot, fs);
    await directoryHandle.sync();
    complete = true;
  } catch (error) {
    failure =
      error?.code === "EEXIST"
        ? Object.assign(new Error("A receipt already exists for this exact review binding."), {
            code: "AGENT_REVIEW_EXISTS",
          })
        : error;
  } finally {
    let cleanupFailure;
    const cleanup = async (operation) => {
      try {
        await operation();
      } catch (error) {
        cleanupFailure ??= error;
      }
    };
    await cleanup(async () => {
      await fs.unlink(temporaryPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    });
    if (!complete && published) await cleanup(() => fs.unlink(storedPath));
    if (!complete) await cleanup(() => directoryHandle.sync());
    await cleanup(() => directoryHandle.close());
    if (cleanupFailure) failure = cleanupFailure;
  }
  if (failure) throw failure;
  return path;
}

/** Read one immutable record. The caller must still rederive the binding and verify it. */
export async function readAgentReviewRecord({
  directory = defaultAgentReviewStoreDirectory(),
  repositoryRoot,
  bindingSha256,
}) {
  assertSupportedPlatform();
  const path = recordPath(directory, bindingSha256);
  await ensureOutsideRepository(path, repositoryRoot);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RECORD_BYTES)
    fail("AGENT_REVIEW_STORE", "Review receipt must be a bounded regular file.");
  if ((info.mode & 0o077) !== 0 || info.nlink !== 1)
    fail("AGENT_REVIEW_STORE", "Review receipt permissions are not private.");
  let envelope;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedInfo = await handle.stat();
    if (
      !openedInfo.isFile() ||
      openedInfo.size > MAX_RECORD_BYTES ||
      (openedInfo.mode & 0o077) !== 0 ||
      openedInfo.nlink !== 1
    )
      fail("AGENT_REVIEW_STORE", "Review receipt must be a private bounded regular file.");
    const openedPath = await realpath(`/proc/self/fd/${handle.fd}`);
    const canonicalRoot = await realpath(repositoryRoot);
    if (inside(canonicalRoot, openedPath))
      fail("AGENT_REVIEW_STORE", "Review receipt storage must be outside the repository.");
    envelope = JSON.parse(await handle.readFile("utf8"));
  } catch {
    fail("AGENT_REVIEW_STORE", "Review receipt cannot be read.");
  } finally {
    await handle?.close();
  }
  return {
    path,
    receipt: validateEnvelope(envelope, bindingSha256).receipt,
    artifactBytes: Buffer.from(envelope.artifactBase64, "base64"),
  };
}
