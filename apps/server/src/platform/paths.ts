// apps/server/src/platform/paths.ts
// Portable platform path resolution and realpath containment validation for Glassbox workspaces.

import fs, { statSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

/**
 * Discovers the absolute root of the Glassbox repository.
 * Works on Windows, macOS, and Linux without hardcoded developer paths.
 */
export function getRepoRoot(): string {
  if (process.env.GLASSBOX_REPO_ROOT) {
    return path.resolve(process.env.GLASSBOX_REPO_ROOT);
  }

  const thisFile = fileURLToPath(import.meta.url);
  let current = path.dirname(thisFile);

  while (true) {
    const pkgPath = path.join(current, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        if (pkg.name === "glassbox" || Array.isArray(pkg.workspaces)) {
          return current;
        }
      } catch {
        // continue searching upward
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // Fallback: 4 directories up from apps/server/src/platform/paths.ts
  return path.resolve(path.dirname(thisFile), "../../../..");
}

/**
 * Directory for Glassbox application and session data (traces, metadata, etc.).
 */
export function getGlassboxDataDir(): string {
  if (process.env.GLASSBOX_DATA_DIR) {
    return path.resolve(process.env.GLASSBOX_DATA_DIR);
  }
  return path.join(getRepoRoot(), ".glassbox");
}

/**
 * Directory used by the long-running local service manager and its CLI client.
 * The service manager defaults to the user profile so service state survives worktree changes.
 */
export function getServiceDataDir(): string {
  if (process.env.GLASSBOX_DATA_DIR) {
    return path.resolve(process.env.GLASSBOX_DATA_DIR);
  }
  return path.join(os.homedir(), ".glassbox");
}

/**
 * Returns a portable default workspace path for the given provider.
 * Uses the OS temp directory instead of hardcoded POSIX /tmp or Linux paths.
 */
export function getDefaultWorkspace(provider: string): string {
  if (provider === "claude-code") {
    return process.env.GLASSBOX_WORKSPACE_CLAUDE
      ? path.resolve(process.env.GLASSBOX_WORKSPACE_CLAUDE)
      : path.join(os.tmpdir(), "glassbox-claude-ws");
  }
  if (provider === "demo") {
    return process.env.GLASSBOX_WORKSPACE_DEMO
      ? path.resolve(process.env.GLASSBOX_WORKSPACE_DEMO)
      : path.join(os.tmpdir(), "glassbox-demo-repo");
  }
  return process.env.GLASSBOX_WORKSPACE_CODEX
    ? path.resolve(process.env.GLASSBOX_WORKSPACE_CODEX)
    : path.join(os.tmpdir(), "glassbox-codex-ws");
}

/**
 * Tests whether `candidate` is equal to or located inside `parent`.
 * Respects Windows case-insensitivity and path normalization.
 */
export function isPathInsideOrEqual(parent: string, candidate: string): boolean {
  const p =
    process.platform === "win32" ? path.resolve(parent).toLowerCase() : path.resolve(parent);
  const c =
    process.platform === "win32" ? path.resolve(candidate).toLowerCase() : path.resolve(candidate);
  if (p === c) return true;
  const rel = path.relative(p, c);
  if (path.isAbsolute(rel)) return false;
  if (rel === ".." || rel.startsWith(".." + path.sep) || rel.startsWith("../")) {
    return false;
  }
  return true;
}

export type RepoValidationResult = { ok: true; realPath: string } | { ok: false; error: string };

/**
 * Validates a client-provided repository workspace path.
 *
 * Requirements:
 * 1. Must be a non-empty string.
 * 2. Must exist and be a directory.
 * 3. Expands home directory (`~`) safely.
 * 4. Resolves symlinks/junctions via realpath to prevent path traversal.
 * 5. Strictly excludes the Glassbox repository itself (including Windows case variants).
 * 6. Strictly excludes Glassbox private/application data directories (.glassbox).
 */
export function validateRepoPath(targetPath: string): RepoValidationResult {
  if (!targetPath || typeof targetPath !== "string") {
    return { ok: false, error: "repo path required" };
  }

  const trimmed = targetPath.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "repo path required" };
  }

  // Expand leading ~/ or ~\
  let expanded = trimmed;
  if (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    expanded = path.join(os.homedir(), trimmed.slice(1));
  }

  // Reject explicit user-level .glassbox references
  if (
    trimmed === "~/.glassbox" ||
    trimmed.startsWith("~/.glassbox/") ||
    trimmed.startsWith("~/.glassbox\\") ||
    trimmed === "~\\.glassbox" ||
    trimmed.startsWith("~\\.glassbox\\")
  ) {
    return { ok: false, error: "~/.glassbox is reserved" };
  }

  // Check existence and directory
  let stat: fs.Stats;
  try {
    stat = statSync(expanded);
  } catch {
    return { ok: false, error: "path does not exist: " + targetPath };
  }

  if (!stat.isDirectory()) {
    return { ok: false, error: "not a directory: " + targetPath };
  }

  // Resolve realpath (canonicalizes symlinks, junctions, 8.3 names, and case)
  let realTarget: string;
  try {
    realTarget = realpathSync.native ? realpathSync.native(expanded) : realpathSync(expanded);
  } catch {
    return { ok: false, error: "failed to resolve real path: " + targetPath };
  }

  // 1. Exclude the Glassbox repository itself
  const repoRoot = getRepoRoot();
  let realRepoRoot: string;
  try {
    realRepoRoot = realpathSync.native ? realpathSync.native(repoRoot) : realpathSync(repoRoot);
  } catch {
    realRepoRoot = path.resolve(repoRoot);
  }

  if (isPathInsideOrEqual(realRepoRoot, realTarget)) {
    return { ok: false, error: "Glassbox repo path is not allowed: " + targetPath };
  }

  // 2. Exclude application private data directory (.glassbox)
  const dataDir = getGlassboxDataDir();
  let realDataDir: string;
  try {
    realDataDir = realpathSync.native ? realpathSync.native(dataDir) : realpathSync(dataDir);
  } catch {
    realDataDir = path.resolve(dataDir);
  }

  if (isPathInsideOrEqual(realDataDir, realTarget)) {
    return { ok: false, error: "Glassbox private data directory is not allowed: " + targetPath };
  }

  // 3. Exclude user home .glassbox directory
  const homeGlassbox = path.join(os.homedir(), ".glassbox");
  let realHomeGlassbox: string;
  try {
    realHomeGlassbox = realpathSync.native
      ? realpathSync.native(homeGlassbox)
      : realpathSync(homeGlassbox);
  } catch {
    realHomeGlassbox = path.resolve(homeGlassbox);
  }

  if (isPathInsideOrEqual(realHomeGlassbox, realTarget)) {
    return { ok: false, error: "~/.glassbox is reserved" };
  }

  return { ok: true, realPath: realTarget };
}
