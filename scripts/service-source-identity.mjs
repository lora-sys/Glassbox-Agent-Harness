import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

function hashField(hash, bytes) {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

export function serviceSourceTreeSha256(checkout, capture = execFileSync) {
  const root = realpathSync(checkout);
  const listed = capture("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    timeout: 15000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!Buffer.isBuffer(listed) || listed.length === 0 || listed.at(-1) !== 0)
    throw new Error("Git source paths are unavailable.");
  const paths = listed.subarray(0, -1).toString("utf8").split("\0");
  const encodedPaths = paths.map((path) => {
    const bytes = Buffer.from(path, "utf8");
    if (!path || path.includes("\ufffd"))
      throw new Error("Git source path encoding is unsupported.");
    const absolute = resolve(root, path);
    const rel = relative(root, absolute);
    if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
      throw new Error("Git source path escapes the checkout.");
    return { path, bytes };
  });
  encodedPaths.sort((left, right) => Buffer.compare(left.bytes, right.bytes));
  const hash = createHash("sha256");
  hash.update("glassbox-source-tree-v1\0", "utf8");
  const count = Buffer.alloc(8);
  count.writeBigUInt64BE(BigInt(encodedPaths.length));
  hash.update(count);
  for (const { path, bytes: pathBytes } of encodedPaths) {
    const absolute = resolve(root, path);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    let type,
      content,
      executable = 0;
    if (!stat) {
      type = Buffer.from("missing");
      content = Buffer.alloc(0);
    } else if (stat.isSymbolicLink()) {
      type = Buffer.from("symlink");
      content = readlinkSync(absolute, { encoding: "buffer" });
    } else if (stat.isFile()) {
      type = Buffer.from("file");
      content = readFileSync(absolute);
      executable = stat.mode & 0o111 ? 1 : 0;
    } else throw new Error("Git source entry is not a regular file or symlink.");
    hashField(hash, pathBytes);
    hashField(hash, type);
    hashField(hash, Buffer.from([executable]));
    hashField(hash, content);
  }
  return hash.digest("hex");
}

export function serviceSourceIdentity(checkout, capture = execFileSync) {
  try {
    const git = (args) =>
      capture("git", args, {
        cwd: checkout,
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const commit = git(["rev-parse", "HEAD"]);
    if (!/^[a-f0-9]{40}$/.test(commit)) return undefined;
    const launchClean = git(["status", "--porcelain"]) === "";
    const identity = { launchCommit: commit, launchClean };
    if (!launchClean) {
      try {
        identity.launchSourceTreeSha256 = serviceSourceTreeSha256(checkout);
      } catch {
        // Dirty development launches require a source tree digest to be verifiable.
      }
    }
    return identity;
  } catch {
    return undefined;
  }
}
