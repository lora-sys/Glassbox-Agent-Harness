/**
 * apps/server/src/platform/executable.ts
 *
 * Windows-first executable resolution, safe argv escaping, and launcher shim resolution.
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
 * - Integrated Windows PATHEXT and known Windows CLI installation paths (npm, pnpm, scoop, volta).
 * - Safe argv quoting for cmd.exe without shell command string interpolation.
 * - Direct resolution of npm launcher shims (.cmd, .bat, .ps1) to native bin/claude.exe or cli.js.
 * - Native package entry discovery for Codex CLI (running native codex.exe or node + codex.js with shell: false).
 */

import fs from "node:fs";
import path from "node:path";

const WINDOWS_SHELL_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Windows launcher-script extensions that Node cannot spawn without a shell
 * (`spawn EINVAL` since Node 20.12) and that the Claude Agent SDK therefore
 * cannot use as `pathToClaudeCodeExecutable`.
 */
export const WINDOWS_SHIM_EXTENSIONS: ReadonlySet<string> = new Set([".cmd", ".bat", ".ps1"]);

/**
 * Entry points of the npm `@anthropic-ai/claude-code` package relative to the
 * global `node_modules` directory that sits next to the npm launcher shim.
 * Newer package versions ship a native `bin/claude.exe`; older versions only
 * ship `cli.js`, which the SDK runs with a JavaScript runtime.
 */
export const NPM_PACKAGE_ENTRY_CANDIDATES = [
  ["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"],
  ["node_modules", "@anthropic-ai", "claude-code", "cli.js"],
] as const;

/**
 * Entry points of npm-installed `@openai/codex` relative to the global npm
 * directory that sits next to `codex.cmd`.
 * Checked in order: platform-specific native vendor binary first, then JS entry points.
 */
export const CODEX_NPM_NATIVE_ENTRY_CANDIDATES = [
  [
    "node_modules",
    "@openai",
    "codex",
    "node_modules",
    "@openai",
    process.arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64",
    "vendor",
    process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc",
    "bin",
    "codex.exe",
  ],
  [
    "node_modules",
    "@openai",
    process.arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64",
    "vendor",
    process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc",
    "bin",
    "codex.exe",
  ],
  ["node_modules", "@openai", "codex", "bin", "codex.exe"],
  ["node_modules", "codex", "bin", "codex.exe"],
] as const;

export const CODEX_NPM_JS_ENTRY_CANDIDATES = [
  ["node_modules", "@openai", "codex", "bin", "codex.js"],
  ["node_modules", "@openai", "codex", "dist", "cli.js"],
  ["node_modules", "@openai", "codex", "cli.js"],
  ["node_modules", "codex", "bin", "codex.js"],
] as const;

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

export function defaultIsExecutableFile(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
  windowsPathExtensions?: ReadonlyArray<string>
): boolean {
  try {
    const s = fs.statSync(filePath);
    if (!s.isFile()) return false;
    if (platform === "win32") {
      const exts = windowsPathExtensions ?? resolveWindowsPathExtensions();
      return exts.includes(path.win32.extname(filePath).toUpperCase());
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Escapes a single argument for `cmd.exe` shell mode (`spawn(..., { shell: true })`
 * on Windows). Node joins the command and arguments with spaces and hands the
 * resulting string to `cmd.exe` without any quoting, so every dynamic argument
 * must be escaped to survive both cmd.exe parsing and the target program's
 * `CommandLineToArgvW` parsing. Mirrors cross-spawn's argument escaping.
 */
export function escapeWindowsShellArg(arg: string): string {
  // Double up backslashes that precede a double quote, then escape the quote
  // itself so it survives CommandLineToArgvW.
  let escaped = arg.replace(/(\\*)"/g, '$1$1\\"');
  // Double up trailing backslashes so the closing quote is not escaped away.
  escaped = escaped.replace(/(\\*)$/, "$1$1");
  // Quote the whole argument so embedded whitespace is preserved.
  escaped = `"${escaped}"`;
  // Escape cmd.exe metacharacters so cmd passes them through verbatim.
  return escaped.replace(WINDOWS_SHELL_META_CHARS, "^$1");
}

/**
 * Escapes arguments for shell-mode spawns: applies {@link escapeWindowsShellArg}
 * when the platform is `win32` (where `shell: true` routes through `cmd.exe`)
 * and returns the arguments untouched everywhere else.
 */
export function sanitizeShellModeArgsForPlatform(
  args: ReadonlyArray<string>,
  platform: NodeJS.Platform = process.platform
): Array<string> {
  return platform === "win32" ? args.map(escapeWindowsShellArg) : [...args];
}

/**
 * Parses PATHEXT on Windows, returning an array of upper-cased extensions including the leading dot.
 */
export function resolveWindowsPathExtensions(env: NodeJS.ProcessEnv = process.env): ReadonlyArray<string> {
  const rawValue = env.PATHEXT;
  const fallback = [".COM", ".EXE", ".BAT", ".CMD"];
  if (!rawValue) return fallback;

  const parsed: string[] = [];
  for (const entry of rawValue.split(";")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    parsed.push(trimmed.startsWith(".") ? trimmed.toUpperCase() : `.${trimmed.toUpperCase()}`);
  }
  return parsed.length > 0 ? Array.from(new Set(parsed)) : fallback;
}

/**
 * Resolves standard global CLI directories on Windows where npm, pnpm, volta, scoop, or bun install CLIs.
 */
export function resolveKnownWindowsCliDirs(env: NodeJS.ProcessEnv = process.env): ReadonlyArray<string> {
  const appData = env.APPDATA?.trim();
  const localAppData = env.LOCALAPPDATA?.trim();
  const userProfile = env.USERPROFILE?.trim();

  return [
    ...(appData ? [path.win32.join(appData, "npm")] : []),
    ...(localAppData
      ? [
          path.win32.join(localAppData, "Programs", "nodejs"),
          path.win32.join(localAppData, "Volta", "bin"),
          path.win32.join(localAppData, "pnpm"),
        ]
      : []),
    ...(userProfile
      ? [
          path.win32.join(userProfile, ".local", "bin"),
          path.win32.join(userProfile, ".bun", "bin"),
          path.win32.join(userProfile, "scoop", "shims"),
        ]
      : []),
  ];
}

/**
 * Generates candidate filenames for a command (e.g. adding .exe, .cmd on Windows).
 */
export function resolveCommandCandidates(
  command: string,
  platform: NodeJS.Platform = process.platform,
  windowsPathExtensions: ReadonlyArray<string> = resolveWindowsPathExtensions()
): ReadonlyArray<string> {
  if (platform !== "win32") return [command];
  const extension = path.win32.extname(command);
  const normalizedExtension = extension.toUpperCase();

  if (extension.length > 0 && windowsPathExtensions.includes(normalizedExtension)) {
    const commandWithoutExtension = command.slice(0, -extension.length);
    return Array.from(
      new Set([
        command,
        `${commandWithoutExtension}${normalizedExtension}`,
        `${commandWithoutExtension}${normalizedExtension.toLowerCase()}`,
      ])
    );
  }

  const candidates: string[] = [];
  for (const candidateExtension of windowsPathExtensions) {
    candidates.push(`${command}${candidateExtension}`);
    candidates.push(`${command}${candidateExtension.toLowerCase()}`);
  }
  return Array.from(new Set(candidates));
}

export interface ExecutableResolutionOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  isFile?: ExecutableFileCheck;
}

/**
 * Resolves a command to an executable file path by searching PATH and standard CLI paths.
 */
export function resolveExecutablePath(
  command: string,
  options: ExecutableResolutionOptions = {}
): string | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const win32Path = path.win32;
  const posixPath = path.posix;
  const p = platform === "win32" ? win32Path : posixPath;

  const windowsPathExtensions = platform === "win32" ? resolveWindowsPathExtensions(env) : [];
  const isFile = options.isFile ?? ((f: string) => defaultIsExecutableFile(f, platform, windowsPathExtensions));

  const candidates = resolveCommandCandidates(command, platform, windowsPathExtensions);

  // If command already contains path separators, check directly
  if (command.includes("/") || command.includes("\\")) {
    for (const candidate of candidates) {
      if (isFile(candidate)) return p.resolve(candidate);
    }
    return undefined;
  }

  // Scan PATH entries
  const delimiter = platform === "win32" ? ";" : ":";
  const rawPath = env.PATH ?? env.Path ?? env.path ?? "";
  const pathEntries = rawPath.split(delimiter);

  // On Windows, also include known CLI install directories
  if (platform === "win32") {
    const knownDirs = resolveKnownWindowsCliDirs(env);
    for (const dir of knownDirs) {
      if (!pathEntries.includes(dir)) {
        pathEntries.push(dir);
      }
    }
  }

  for (const entry of pathEntries) {
    const trimmed = entry.trim().replace(/^"+|"+$/g, "");
    if (!trimmed) continue;
    for (const candidate of candidates) {
      const fullPath = p.join(trimmed, candidate);
      if (isFile(fullPath)) {
        return p.resolve(fullPath);
      }
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
 * On Windows this resolves the command against PATH/PATHEXT and, when the
 * result is an npm launcher shim, follows it to the real package entry
 * (`bin/claude.exe`, or `cli.js` for older package versions).
 *
 * If a Windows launcher script cannot be traversed to a valid entry point,
 * returns `undefined` (fail clearly) because the Claude Agent SDK cannot
 * spawn launcher scripts directly (`spawn EINVAL` on Node >= 20.12).
 * On other platforms the configured value is returned.
 */
export function resolveClaudeExecutable(
  options: ClaudeResolutionOptions = {}
): string | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const hasExplicit = Boolean(options.binaryPath || env.CLAUDE_BINARY_PATH);
  const configured = options.binaryPath || env.CLAUDE_BINARY_PATH || "claude";
  const p = platform === "win32" ? path.win32 : path.posix;

  const isCandidateFile = options.isFile ?? ((f: string) => defaultIsFile(f));
  const isExecutable = (f: string) =>
    options.isFile ? options.isFile(f) : defaultIsExecutableFile(f, platform);

  let resolved: string | undefined;

  if (hasExplicit) {
    if (configured.includes("/") || configured.includes("\\")) {
      const resolvedPath = p.resolve(configured);
      if (!isCandidateFile(resolvedPath)) {
        return undefined;
      }
      resolved = resolvedPath;
    } else {
      resolved = resolveExecutablePath(configured, { platform, env, isFile: isExecutable });
      if (!resolved) return undefined;
    }
  } else {
    resolved = resolveExecutablePath("claude", { platform, env, isFile: isExecutable });
  }

  if (!resolved) {
    return undefined;
  }

  if (platform !== "win32") {
    return resolved;
  }

  const extension = path.win32.extname(resolved).toLowerCase();
  if (!WINDOWS_SHIM_EXTENSIONS.has(extension)) {
    return resolved;
  }

  // Follow the npm launcher shim (.cmd, .bat, .ps1) to discover package entry
  const shimDirectory = path.win32.dirname(resolved);
  for (const entrySegments of NPM_PACKAGE_ENTRY_CANDIDATES) {
    const candidate = path.win32.join(shimDirectory, ...entrySegments);
    if (isCandidateFile(candidate)) {
      return candidate;
    }
  }

  // Windows launcher script without a valid target entry point cannot be spawned by the SDK
  return undefined;
}

export interface CodexResolutionOptions extends ExecutableResolutionOptions {
  binaryPath?: string;
}

/**
 * Resolves the Codex binary path and returns safe spawn parameters.
 * Prefers discovery of native package entry (`codex.exe` or `process.execPath` + `codex.js` with `shell: false`).
 * Preserves explicit configured binary path without silent fallback.
 * When resolved to an unmapped Windows .cmd / .bat shim, args are escaped and shell is set to true.
 * When resolved to a native binary (.exe or POSIX executable), no shell is used.
 */
export function resolveCodexExecutable(
  options: CodexResolutionOptions = {}
): ResolvedSpawnCommand | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const hasExplicit = Boolean(options.binaryPath || env.CODEX_BINARY_PATH);
  const configured = options.binaryPath || env.CODEX_BINARY_PATH || "codex";
  const p = platform === "win32" ? path.win32 : path.posix;

  const isCandidateFile = options.isFile ?? ((f: string) => defaultIsFile(f));
  const isExecutable = (f: string) =>
    options.isFile ? options.isFile(f) : defaultIsExecutableFile(f, platform);

  let resolved: string | undefined;

  if (hasExplicit) {
    if (configured.includes("/") || configured.includes("\\")) {
      const resolvedPath = p.resolve(configured);
      if (!isCandidateFile(resolvedPath)) {
        return undefined;
      }
      resolved = resolvedPath;
    } else {
      resolved = resolveExecutablePath(configured, { platform, env, isFile: isExecutable });
      if (!resolved) return undefined;
    }
  } else {
    resolved = resolveExecutablePath("codex", { platform, env, isFile: isExecutable });
  }

  if (!resolved) {
    return undefined;
  }

  if (platform !== "win32") {
    const ext = path.extname(resolved).toLowerCase();
    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
      return { command: process.execPath, args: [resolved, "app-server"], shell: false };
    }
    return { command: resolved, args: ["app-server"], shell: false };
  }

  const extension = path.win32.extname(resolved).toLowerCase();
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return { command: process.execPath, args: [resolved, "app-server"], shell: false };
  }

  if (WINDOWS_SHIM_EXTENSIONS.has(extension)) {
    const shimDirectory = path.win32.dirname(resolved);

    // 1. Prefer vendor native codex.exe (runs directly with shell: false)
    for (const entrySegments of CODEX_NPM_NATIVE_ENTRY_CANDIDATES) {
      const candidate = path.win32.join(shimDirectory, ...entrySegments);
      if (isCandidateFile(candidate)) {
        return { command: candidate, args: ["app-server"], shell: false };
      }
    }

    // 2. Prefer codex.js (runs via Node process.execPath with shell: false)
    for (const entrySegments of CODEX_NPM_JS_ENTRY_CANDIDATES) {
      const candidate = path.win32.join(shimDirectory, ...entrySegments);
      if (isCandidateFile(candidate)) {
        return { command: process.execPath, args: [candidate, "app-server"], shell: false };
      }
    }

    // 3. Fallback: resolveSpawnCommand with safe cmd quoting and shell: true
    return resolveSpawnCommand(resolved, ["app-server"], { platform, env });
  }

  // Native binary (.exe): runs directly with shell: false
  return { command: resolved, args: ["app-server"], shell: false };
}

/**
 * Resolves a command and arguments for spawning child processes without shell interpolation.
 * Windows .cmd/.bat shims are escaped with cmd-safe quoting and spawned with shell: true.
 * Native binaries are spawned directly with shell: false.
 */
export function resolveSpawnCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}
): ResolvedSpawnCommand {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { command, args: [...args], shell: false };
  }

  const env = options.env ?? process.env;
  const resolvedCommand = resolveExecutablePath(command, { platform, env }) ?? command;
  const extension = path.win32.extname(resolvedCommand).toLowerCase();

  if (extension !== ".cmd" && extension !== ".bat") {
    return { command: resolvedCommand, args: [...args], shell: false };
  }

  return {
    command: escapeWindowsShellArg(resolvedCommand),
    args: sanitizeShellModeArgsForPlatform(args, platform),
    shell: true,
  };
}
