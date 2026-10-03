/**
 * apps/server/src/platform/executable.ts
 *
 * POSIX executable resolution and safe spawn parameter selection.
 *
 * Reused and adapted from upstream/repos/t3code under MIT License:
 * - Source repo: pingdotgg/t3code
 * - Commit SHA: 4a4c6dd2adc350a68ba18bb28b24b5a7e4660dab
 * - Original files:
 *   - apps/server/src/provider/Drivers/ClaudeExecutable.ts
 *   - packages/shared/src/shell.ts
 *   - apps/server/src/provider/Drivers/ClaudeHome.ts
 * - License: MIT (see LICENSE in this directory)
 *
 * Local modifications:
 * - Adapted Effect-based generator functions into standard Node.js/TypeScript functions.
 * - Narrowed to POSIX targets: Glassbox runs on Linux only, so PATH/X_OK resolution
 *   replaced the Windows PATHEXT, launcher-shim traversal, and cmd.exe quoting layers.
 */

import fs from "node:fs";
import path from "node:path";

export interface ResolvedSpawnCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly shell: boolean;
}

export type ExecutableFileCheck = (filePath: string) => boolean;

export function defaultIsFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function defaultIsExecutableFile(filePath: string): boolean {
  try {
    const s = fs.statSync(filePath);
    if (!s.isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ExecutableResolutionOptions {
  env?: NodeJS.ProcessEnv;
  isFile?: ExecutableFileCheck;
}

/**
 * Resolves a command to an executable file path by searching PATH.
 */
export function resolveExecutablePath(
  command: string,
  options: ExecutableResolutionOptions = {},
): string | undefined {
  const env = options.env ?? process.env;
  const isFile = options.isFile ?? defaultIsExecutableFile;

  if (command.includes("/")) {
    return isFile(command) ? path.resolve(command) : undefined;
  }

  for (const entry of (env.PATH ?? "").split(":")) {
    const trimmed = entry.trim().replace(/^"+|"+$/g, "");
    if (!trimmed) continue;
    const fullPath = path.join(trimmed, command);
    if (isFile(fullPath)) {
      return path.resolve(fullPath);
    }
  }

  return undefined;
}

export interface ClaudeResolutionOptions extends ExecutableResolutionOptions {
  binaryPath?: string;
}

/**
 * Resolves the configured Claude binary path into a value the Claude Agent
 * SDK can spawn directly via `pathToClaudeCodeExecutable`.
 *
 * An explicit configured value that names a path must exist; an explicit bare
 * command must resolve on PATH. Both fail clearly (return `undefined`) when
 * unresolvable. Without configuration, `claude` is resolved on PATH.
 */
export function resolveClaudeExecutable(options: ClaudeResolutionOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const hasExplicit = Boolean(options.binaryPath || env.CLAUDE_BINARY_PATH);
  const configured = options.binaryPath || env.CLAUDE_BINARY_PATH || "claude";

  const isCandidateFile = options.isFile ?? defaultIsFile;
  const isExecutable = (f: string) =>
    options.isFile ? options.isFile(f) : defaultIsExecutableFile(f);

  if (!hasExplicit) {
    return resolveExecutablePath("claude", { env, isFile: isExecutable });
  }

  if (configured.includes("/")) {
    const resolvedPath = path.resolve(configured);
    return isCandidateFile(resolvedPath) ? resolvedPath : undefined;
  }

  return resolveExecutablePath(configured, { env, isFile: isExecutable });
}

export interface CodexResolutionOptions extends ExecutableResolutionOptions {
  binaryPath?: string;
}

/**
 * Resolves the Codex binary path and returns safe spawn parameters.
 * A JS entry point runs under the current Node executable; a native binary runs
 * directly. Both spawn with `shell: false`. Preserves an explicit configured
 * binary path without silent fallback.
 */
export function resolveCodexExecutable(
  options: CodexResolutionOptions = {},
): ResolvedSpawnCommand | undefined {
  const env = options.env ?? process.env;
  const hasExplicit = Boolean(options.binaryPath || env.CODEX_BINARY_PATH);
  const configured = options.binaryPath || env.CODEX_BINARY_PATH || "codex";

  const isCandidateFile = options.isFile ?? defaultIsFile;
  const isExecutable = (f: string) =>
    options.isFile ? options.isFile(f) : defaultIsExecutableFile(f);

  let resolved: string | undefined;

  if (!hasExplicit) {
    resolved = resolveExecutablePath("codex", { env, isFile: isExecutable });
  } else if (configured.includes("/")) {
    const resolvedPath = path.resolve(configured);
    if (!isCandidateFile(resolvedPath)) {
      return undefined;
    }
    resolved = resolvedPath;
  } else {
    resolved = resolveExecutablePath(configured, { env, isFile: isExecutable });
    if (!resolved) return undefined;
  }

  if (!resolved) {
    return undefined;
  }

  const ext = path.extname(resolved).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    return { command: process.execPath, args: [resolved, "app-server"], shell: false };
  }
  return { command: resolved, args: ["app-server"], shell: false };
}

/**
 * Resolves a command and arguments for spawning child processes without shell
 * interpolation. POSIX executables are spawned directly.
 */
export function resolveSpawnCommand(
  command: string,
  args: ReadonlyArray<string>,
): ResolvedSpawnCommand {
  return { command, args: [...args], shell: false };
}
