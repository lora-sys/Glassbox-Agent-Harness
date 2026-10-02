// Read-only, bounded before/after workspace evidence. Never writes an index or Git object.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

interface FileState {
  hash: string;
  mode: number;
  text?: string;
}
export interface FileSnapshot {
  [filePath: string]: FileState | null;
}
export interface FileChange {
  path: string;
  kind: "add" | "delete" | "rename" | "modify";
  diff?: string;
}
const snapshotRoots = new WeakMap<FileSnapshot, string>();
const MAX_FILES = 5_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SCAN_BYTES = 128 * 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_STORED_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_DIFF_CHARS = 2_048;

function gitPaths(cwd: string): string[] {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  // A hook's ambient Git index/worktree must not redirect this workspace scan elsewhere.
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_PREFIX",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ])
    delete env[name];
  const output = execFileSync(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
    ],
    {
      cwd,
      env,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    },
  );
  return [...new Set(output.split("\0").filter(Boolean))].sort();
}

function checkedPath(root: string, path: string): string {
  const parts = path.split("/");
  if (
    isAbsolute(path) ||
    parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
  )
    throw new Error("unsafe workspace path");
  let target = root;
  for (const part of parts.slice(0, -1)) {
    target = join(target, part);
    const info = lstatSync(target);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("unsafe workspace parent");
  }
  target = join(root, ...parts);
  const local = relative(root, target);
  if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local))
    throw new Error("unsafe workspace path");
  return target;
}

function permitsTextPreview(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  const name = parts.at(-1) ?? "";
  return (
    !parts.some((part) => part === ".ssh" || part === ".aws") &&
    !/^\.env(?:$|\.)|^\.(?:npmrc|pypirc|netrc)$|^id_(?:rsa|dsa|ecdsa|ed25519)(?:$|\.)|\.(?:key|pem|p12|pfx|keystore)$/u.test(
      name,
    )
  );
}

function capture(cwd: string, previousPaths: string[] = []): FileSnapshot | null {
  try {
    const root = realpathSync(cwd);
    const rootStat = lstatSync(root);
    const paths = [...new Set([...gitPaths(root), ...previousPaths])].sort();
    if (paths.length > MAX_FILES) return null;
    const snapshot: FileSnapshot = Object.create(null) as FileSnapshot;
    let bytesRemaining = MAX_SCAN_BYTES;
    let textRemaining = MAX_STORED_TEXT_BYTES;
    for (const path of paths) {
      let descriptor: number | undefined;
      try {
        const target = checkedPath(root, path);
        const info = lstatSync(target);
        if (info.isSymbolicLink()) {
          // Capture the link itself, never its target's bytes.
          const text = readlinkSync(target);
          if (text.length > MAX_TEXT_BYTES) {
            snapshot[path] = null;
            continue;
          }
          const includeText = permitsTextPreview(path) && Buffer.byteLength(text) <= textRemaining;
          if (includeText) textRemaining -= Buffer.byteLength(text);
          snapshot[path] = {
            hash: createHash("sha256").update(`link\0${text}`).digest("hex"),
            mode: info.mode,
            ...(includeText ? { text } : {}),
          };
          continue;
        }
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          info.size > MAX_FILE_BYTES ||
          info.size > bytesRemaining
        ) {
          snapshot[path] = null;
          continue;
        }
        descriptor = openSync(
          target,
          constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
        );
        const opened = fstatSync(descriptor);
        const verified = lstatSync(checkedPath(root, path));
        if (
          !opened.isFile() ||
          verified.isSymbolicLink() ||
          opened.dev !== info.dev ||
          opened.ino !== info.ino ||
          opened.dev !== verified.dev ||
          opened.ino !== verified.ino
        )
          throw new Error("workspace file changed during open");
        const hash = createHash("sha256");
        const buffer = Buffer.alloc(64 * 1024);
        let keepText =
          permitsTextPreview(path) && info.size <= MAX_TEXT_BYTES && info.size <= textRemaining;
        const chunks: Buffer[] = [];
        let total = 0;
        while (true) {
          const count = readSync(descriptor, buffer, 0, buffer.length, null);
          if (!count) break;
          total += count;
          bytesRemaining -= count;
          if (total > MAX_FILE_BYTES || bytesRemaining < 0)
            throw new Error("workspace scan budget exceeded");
          hash.update(buffer.subarray(0, count));
          if (total > MAX_TEXT_BYTES || total > textRemaining) {
            keepText = false;
            chunks.length = 0;
          }
          if (keepText) chunks.push(Buffer.from(buffer.subarray(0, count)));
        }
        const after = fstatSync(descriptor);
        const current = lstatSync(checkedPath(root, path));
        const currentRoot = lstatSync(root);
        if (
          after.size !== info.size ||
          after.mtimeMs !== info.mtimeMs ||
          after.ctimeMs !== info.ctimeMs ||
          current.isSymbolicLink() ||
          current.dev !== opened.dev ||
          current.ino !== opened.ino ||
          currentRoot.isSymbolicLink() ||
          currentRoot.dev !== rootStat.dev ||
          currentRoot.ino !== rootStat.ino
        )
          throw new Error("workspace changed during capture");
        let text: string | undefined;
        if (keepText) {
          const content = Buffer.concat(chunks);
          if (!content.includes(0)) {
            try {
              text = new TextDecoder("utf-8", { fatal: true }).decode(content);
            } catch {
              /* Binary data has no text preview. */
            }
          }
          textRemaining -= content.length;
        }
        snapshot[path] = {
          hash: hash.digest("hex"),
          mode: info.mode,
          ...(text === undefined ? {} : { text }),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") snapshot[path] = null;
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    }
    snapshotRoots.set(snapshot, root);
    return snapshot;
  } catch {
    return null;
  }
}

/** Empty repositories are valid snapshots. Null means no trustworthy baseline could be read. */
export function gitLsFiles(cwd: string): FileSnapshot | null {
  return capture(cwd);
}

function preview(
  path: string,
  before: string | undefined,
  after: string | undefined,
): string | undefined {
  if (before === undefined || after === undefined || before === after) return undefined;
  const oldLines = before.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const newLines = after.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start])
    start++;
  let oldEnd = oldLines.length,
    newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const removed = oldLines.slice(start, oldEnd),
    added = newLines.slice(start, newEnd);
  const label = /[\t\n\r"\\]/u.test(path) ? JSON.stringify(path) : path;
  const render = (lines: string[], prefix: string) =>
    lines
      .map(
        (line) =>
          `${prefix}${line}${line.endsWith("\n") ? "" : "\n\\ No newline at end of file\n"}`,
      )
      .join("");
  const diff = `--- before/${label}\n+++ after/${label}\n@@ -${start + (removed.length ? 1 : 0)},${removed.length} +${start + (added.length ? 1 : 0)},${added.length} @@\n${render(removed, "-")}${render(added, "+")}`;
  const marker = "\n[diff preview truncated]";
  return diff.length > MAX_DIFF_CHARS
    ? diff.slice(0, MAX_DIFF_CHARS - marker.length) + marker
    : diff;
}

/** Observed changes during the Run window; this cannot identify who made concurrent edits. */
export function gitDiffForScan(cwd: string, before: FileSnapshot): FileChange[] {
  try {
    if (snapshotRoots.get(before) !== realpathSync(cwd)) return [];
  } catch {
    return [];
  }
  const after = capture(cwd, Object.keys(before));
  if (after === null) return [];
  const changes: FileChange[] = [];
  for (const path of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const old = before[path],
      current = after[path];
    // An unreadable, unstable, oversized or out-of-budget path is unknown, not a deletion.
    if (old === null || current === null || (!old && !current)) continue;
    if (old && current && old.hash === current.hash && old.mode === current.mode) continue;
    const kind = !old ? "add" : !current ? "delete" : "modify";
    const diff = preview(path, old ? old.text : "", current ? current.text : "");
    changes.push({ path, kind, ...(diff === undefined ? {} : { diff }) });
  }
  return changes;
}
