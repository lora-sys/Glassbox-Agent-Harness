// apps/server/src/platform/platform.test.ts
// Deterministic unit tests for Windows runtime baseline slice A0.

import { describe, it, expect } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawn } from "node:child_process";
import {
  getRepoRoot,
  getGlassboxDataDir,
  getDefaultWorkspace,
  validateRepoPath,
  isPathInsideOrEqual,
} from "./paths.js";
import {
  escapeWindowsShellArg,
  sanitizeShellModeArgsForPlatform,
  resolveWindowsPathExtensions,
  resolveCommandCandidates,
  resolveClaudeExecutable,
  resolveCodexExecutable,
  resolveSpawnCommand,
} from "./executable.js";
import { gitLsFiles, gitDiffForScan } from "./git.js";
import { CodexAdapter } from "../codex/adapter.js";

describe("Platform Paths and Repo Validation", () => {
  it("discovers repository root containing package.json", () => {
    const root = getRepoRoot();
    expect(fs.existsSync(path.join(root, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "apps", "server"))).toBe(true);
  });

  it("resolves Glassbox application data directory under repo root by default", () => {
    const dataDir = getGlassboxDataDir();
    expect(dataDir).toBe(path.join(getRepoRoot(), ".glassbox"));
  });

  it("provides portable default workspaces using os.tmpdir() and restores env", () => {
    const origCodex = process.env.GLASSBOX_WORKSPACE_CODEX;
    const origClaude = process.env.GLASSBOX_WORKSPACE_CLAUDE;
    const origDemo = process.env.GLASSBOX_WORKSPACE_DEMO;

    try {
      delete process.env.GLASSBOX_WORKSPACE_CODEX;
      delete process.env.GLASSBOX_WORKSPACE_CLAUDE;
      delete process.env.GLASSBOX_WORKSPACE_DEMO;

      const codexWs = getDefaultWorkspace("codex");
      const claudeWs = getDefaultWorkspace("claude-code");
      const demoWs = getDefaultWorkspace("demo");

      expect(codexWs).toContain("glassbox-codex-ws");
      expect(claudeWs).toContain("glassbox-claude-ws");
      expect(demoWs).toContain("glassbox-demo-repo");

      if (process.platform === "win32") {
        expect(codexWs).not.toMatch(/^\/tmp\//);
        expect(claudeWs).not.toMatch(/^\/tmp\//);
      }
    } finally {
      if (origCodex !== undefined) process.env.GLASSBOX_WORKSPACE_CODEX = origCodex;
      if (origClaude !== undefined) process.env.GLASSBOX_WORKSPACE_CLAUDE = origClaude;
      if (origDemo !== undefined) process.env.GLASSBOX_WORKSPACE_DEMO = origDemo;
    }
  });

  it("detects path containment respecting Windows case insensitivity and child named ..data", () => {
    const repo = getRepoRoot();
    const repoLower = repo.toLowerCase();

    if (process.platform === "win32") {
      expect(isPathInsideOrEqual(repo, repoLower)).toBe(true);
    }
    expect(isPathInsideOrEqual(repo, path.join(repo, "apps", "server"))).toBe(true);
    expect(isPathInsideOrEqual(repo, os.tmpdir())).toBe(false);

    // Child folder literally named "..data" inside repo must be detected as INSIDE
    const childNamedDots = path.join(repo, "..data");
    expect(isPathInsideOrEqual(repo, childNamedDots)).toBe(true);

    // Parent directory traversal must be detected as OUTSIDE
    const parentTraversal = path.join(repo, "..", "outside");
    expect(isPathInsideOrEqual(repo, parentTraversal)).toBe(false);
  });

  it("validates repo paths with realpath containment and returns canonical realPath", () => {
    // 1. Missing or invalid inputs
    expect(validateRepoPath("")).toEqual({ ok: false, error: "repo path required" });
    // @ts-expect-error test non-string input
    expect(validateRepoPath(null)).toEqual({ ok: false, error: "repo path required" });

    // 2. Nonexistent path
    const nonExistent = path.join(os.tmpdir(), "glassbox-nonexistent-" + Date.now());
    const nonExistentResult = validateRepoPath(nonExistent);
    expect(nonExistentResult.ok).toBe(false);
    if (!nonExistentResult.ok) {
      expect(nonExistentResult.error).toContain("path does not exist");
    }

    // 3. File instead of directory
    const filePath = path.join(getRepoRoot(), "package.json");
    const fileResult = validateRepoPath(filePath);
    expect(fileResult.ok).toBe(false);

    // 4. Glassbox repo root itself
    const repoRootResult = validateRepoPath(getRepoRoot());
    expect(repoRootResult.ok).toBe(false);
    if (!repoRootResult.ok) {
      expect(repoRootResult.error).toContain("Glassbox repo path is not allowed");
    }

    // 5. Glassbox repo with alternate case on Windows
    if (process.platform === "win32") {
      const lowerRepoResult = validateRepoPath(getRepoRoot().toLowerCase());
      expect(lowerRepoResult.ok).toBe(false);
      if (!lowerRepoResult.ok) {
        expect(lowerRepoResult.error).toContain("Glassbox repo path is not allowed");
      }
    }

    // 6. Subdirectory inside Glassbox repo
    const subRepoResult = validateRepoPath(path.join(getRepoRoot(), "apps", "server"));
    expect(subRepoResult.ok).toBe(false);
    if (!subRepoResult.ok) {
      expect(subRepoResult.error).toContain("Glassbox repo path is not allowed");
    }

    // 7. Reserved ~/.glassbox
    expect(validateRepoPath("~/.glassbox")).toEqual({
      ok: false,
      error: "~/.glassbox is reserved",
    });

    // 8. Legitimate temporary directory outside repo returns canonical realPath
    const validTemp = fs.mkdtempSync(path.join(os.tmpdir(), "glassbox-valid-test-"));
    try {
      const validResult = validateRepoPath(validTemp);
      expect(validResult.ok).toBe(true);
      if (validResult.ok) {
        expect(validResult.realPath).toBeTruthy();
        expect(fs.existsSync(validResult.realPath)).toBe(true);
      }
    } finally {
      fs.rmSync(validTemp, { recursive: true, force: true });
    }
  });

  it("handles Windows junction / symlink resolution in disposable directory", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "glassbox-junction-test-"));
    const targetDir = path.join(tempRoot, "target");
    const linkDir = path.join(tempRoot, "link_to_target");
    fs.mkdirSync(targetDir, { recursive: true });

    try {
      // Create NTFS junction on Windows, directory symlink on POSIX
      if (process.platform === "win32") {
        fs.symlinkSync(targetDir, linkDir, "junction");
      } else {
        fs.symlinkSync(targetDir, linkDir, "dir");
      }

      const res = validateRepoPath(linkDir);
      expect(res.ok).toBe(true);
      if (res.ok) {
        // realPath must point to canonical targetDir
        const canonicalTarget = fs.realpathSync.native
          ? fs.realpathSync.native(targetDir)
          : fs.realpathSync(targetDir);
        expect(res.realPath.toLowerCase()).toBe(canonicalTarget.toLowerCase());
      }
    } finally {
      try {
        fs.rmSync(linkDir, { recursive: true, force: true });
      } catch {}
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch {}
    }
  });
});

describe("Safe Argv and Launcher Resolution", () => {
  it("escapes Windows shell arguments safely for cmd.exe", () => {
    const escaped1 = escapeWindowsShellArg("hello world");
    expect(escaped1).toBe('^"hello^ world^"');

    const escaped2 = escapeWindowsShellArg("foo&bar|baz<qux>test^1%VAR%");
    expect(escaped2).toContain("^&");
    expect(escaped2).toContain("^|");
    expect(escaped2).toContain("^<");
    expect(escaped2).toContain("^>");
    expect(escaped2).toContain("^^");
    expect(escaped2).toContain("^%");
  });

  it("sanitizes arguments array based on platform", () => {
    const rawArgs = ["param1", "param with space", "a&b"];
    const sanitizedWin = sanitizeShellModeArgsForPlatform(rawArgs, "win32");
    expect(sanitizedWin[1]).toBe('^"param^ with^ space^"');
    expect(sanitizedWin[2]).toBe('^"a^&b^"');

    const sanitizedPosix = sanitizeShellModeArgsForPlatform(rawArgs, "linux");
    expect(sanitizedPosix).toEqual(rawArgs);
  });

  it("resolves Windows PATHEXT extensions", () => {
    const exts = resolveWindowsPathExtensions({ PATHEXT: ".EXE;.CMD;.BAT;.PS1" });
    expect(exts).toEqual([".EXE", ".CMD", ".BAT", ".PS1"]);

    const fallback = resolveWindowsPathExtensions({});
    expect(fallback).toContain(".EXE");
    expect(fallback).toContain(".CMD");
  });

  it("generates command candidates with extensions on win32", () => {
    const winCandidates = resolveCommandCandidates("claude", "win32", [".EXE", ".CMD"]);
    expect(winCandidates).toContain("claude.EXE");
    expect(winCandidates).toContain("claude.exe");
    expect(winCandidates).toContain("claude.CMD");
    expect(winCandidates).toContain("claude.cmd");

    const posixCandidates = resolveCommandCandidates("claude", "linux");
    expect(posixCandidates).toEqual(["claude"]);
  });

  it("executes an actual temporary .cmd launcher in a path with spaces & metacharacters", async () => {
    if (process.platform !== "win32") return;

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb test (meta & space) [v1]-"));
    const dumpScript = path.join(tempDir, "dump.js");
    const cmdLauncher = path.join(tempDir, "launcher.cmd");
    const outFile = path.join(tempDir, "out.json");

    // dump.js writes remaining arguments to JSON file
    fs.writeFileSync(
      dumpScript,
      `const fs = require('fs'); fs.writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));`,
    );

    // launcher.cmd executes node dump.js %*
    fs.writeFileSync(cmdLauncher, `@"${process.execPath}" "%~dp0dump.js" %*\n`);

    try {
      const testArgs = [outFile, "arg with spaces", 'quote"test"', "meta&^%chars"];
      const resolved = resolveSpawnCommand(cmdLauncher, testArgs, { platform: "win32" });

      expect(resolved.shell).toBe(true);

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(resolved.command, [...resolved.args], {
          shell: resolved.shell,
          stdio: "ignore",
          windowsHide: true,
        });
        proc.on("error", reject);
        proc.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error("Launcher exited with code " + code));
        });
      });

      expect(fs.existsSync(outFile)).toBe(true);
      const captured = JSON.parse(fs.readFileSync(outFile, "utf-8"));
      expect(captured[0]).toBe("arg with spaces");
      expect(captured[1]).toBe('quote"test"');
      expect(captured[2]).toBe("meta&^%chars");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves Claude Code launcher shims with old cli.js fallback in disposable directory", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-claude-shim-test-"));
    const claudeCmd = path.join(tempDir, "claude.cmd");
    const cliJsDir = path.join(tempDir, "node_modules", "@anthropic-ai", "claude-code");
    const cliJs = path.join(cliJsDir, "cli.js");

    fs.writeFileSync(claudeCmd, "@echo off\n");
    fs.mkdirSync(cliJsDir, { recursive: true });
    fs.writeFileSync(cliJs, "// cli.js\n");

    try {
      // 1. With cli.js present: resolves to cli.js even though .js is not in PATHEXT
      const resolved = resolveClaudeExecutable({
        binaryPath: claudeCmd,
        platform: "win32",
        env: { PATH: tempDir, PATHEXT: ".CMD;.EXE" },
      });
      expect(resolved).toBe(cliJs);

      // 2. When cli.js is removed: no valid entry exists next to the .cmd shim
      fs.unlinkSync(cliJs);
      const resolvedMissing = resolveClaudeExecutable({
        binaryPath: claudeCmd,
        platform: "win32",
        env: { PATH: tempDir, PATHEXT: ".CMD;.EXE" },
      });
      // Must fail clearly (return undefined) rather than returning the unspawnable .cmd shim
      expect(resolvedMissing).toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves Codex executable preferring native entry and node entry", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-codex-entry-test-"));
    const codexCmd = path.join(tempDir, "codex.cmd");
    const vendorDir = path.join(
      tempDir,
      "node_modules",
      "@openai",
      "codex",
      "node_modules",
      "@openai",
      process.arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64",
      "vendor",
      process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc",
      "bin",
    );
    const vendorExe = path.join(vendorDir, "codex.exe");
    const jsDir = path.join(tempDir, "node_modules", "@openai", "codex", "bin");
    const jsEntry = path.join(jsDir, "codex.js");

    fs.writeFileSync(codexCmd, "@echo off\n");
    fs.mkdirSync(vendorDir, { recursive: true });
    fs.writeFileSync(vendorExe, "binary\n");

    try {
      // 1. When native codex.exe exists: resolves directly to native exe with shell: false
      const nativeRes = resolveCodexExecutable({
        binaryPath: codexCmd,
        platform: "win32",
      });
      expect(nativeRes).toBeDefined();
      expect(nativeRes?.shell).toBe(false);
      expect(nativeRes?.command).toBe(vendorExe);

      // 2. When native exe is removed and only codex.js exists: runs via process.execPath with shell: false
      fs.unlinkSync(vendorExe);
      fs.mkdirSync(jsDir, { recursive: true });
      fs.writeFileSync(jsEntry, "// codex.js\n");

      const jsRes = resolveCodexExecutable({
        binaryPath: codexCmd,
        platform: "win32",
      });
      expect(jsRes).toBeDefined();
      expect(jsRes?.shell).toBe(false);
      expect(jsRes?.command).toBe(process.execPath);
      expect(jsRes?.args).toEqual([jsEntry, "app-server"]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves explicit configured binary path without silent fallback", () => {
    const missingClaude = resolveClaudeExecutable({
      binaryPath: "C:/nonexistent/claude-binary-xyz.exe",
    });
    expect(missingClaude).toBeUndefined();

    const missingCodex = resolveCodexExecutable({
      binaryPath: "C:/nonexistent/codex-binary-xyz.exe",
    });
    expect(missingCodex).toBeUndefined();
  });

  it("can run installed Codex --version if present on host without inference", () => {
    const resolved = resolveCodexExecutable();
    if (!resolved) return; // Not installed on this host, skip execution

    // Run --version instead of app-server to verify local binary resolution
    const versionOutput = execFileSync(
      resolved.command,
      [resolved.args[0] === "app-server" ? "--version" : resolved.args[0], "--version"],
      {
        encoding: "utf-8",
        timeout: 5000,
        shell: resolved.shell,
        windowsHide: true,
      },
    ).trim();

    expect(versionOutput.length).toBeGreaterThan(0);
  });
});

describe("Disposable Git Scanning Safe Argv Execution", () => {
  /**
   * Runs `fn` with the inherited git environment removed.
   *
   * This suite also runs from inside a linked worktree's pre-commit hook, where git exports
   * `GIT_DIR` (and `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_CONFIG_PARAMETERS`, …) into every
   * child process. Inherited, those redirect the disposable repository below at the *shared*
   * git directory instead of its own. `gitLsFiles`/`gitDiffForScan` read `process.env`
   * themselves, so the whole body runs under this environment, not just the setup commands.
   *
   * `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` point at an empty file rather than the null
   * device: git rejects `\\.\nul` as a config path on Windows.
   */
  function withIsolatedGitEnv<T>(emptyConfig: string, fn: () => T): T {
    const saved = new Map<string, string | undefined>();
    for (const name of Object.keys(process.env)) {
      if (!name.startsWith("GIT_")) continue;
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
    process.env.GIT_CONFIG_GLOBAL = emptyConfig;
    process.env.GIT_CONFIG_SYSTEM = emptyConfig;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    try {
      return fn();
    } finally {
      delete process.env.GIT_CONFIG_GLOBAL;
      delete process.env.GIT_CONFIG_SYSTEM;
      delete process.env.GIT_CONFIG_NOSYSTEM;
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  function disposableGit(cwd: string, args: readonly string[]): void {
    execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" });
  }

  it("scans git files in a disposable repository without touching real workspace", () => {
    const tempGit = fs.mkdtempSync(path.join(os.tmpdir(), "gb-disposable-git-"));
    const emptyConfig = path.join(tempGit, "empty.gitconfig");
    try {
      withIsolatedGitEnv(emptyConfig, () => {
        fs.writeFileSync(emptyConfig, "");
        disposableGit(tempGit, ["init"]);
        disposableGit(tempGit, ["config", "user.name", "TestUser"]);
        disposableGit(tempGit, ["config", "user.email", "test@example.com"]);

        const testFile = path.join(tempGit, "sample.txt");
        fs.writeFileSync(testFile, "hello\n");
        disposableGit(tempGit, ["add", "sample.txt"]);
        disposableGit(tempGit, ["commit", "-m", "initial commit"]);

        // 1. gitLsFiles returns clean file snapshot
        const snapshot = gitLsFiles(tempGit);
        expect(snapshot).not.toBeNull();
        expect(snapshot?.["sample.txt"]).toBeDefined();

        // 2. Modify file and verify gitDiffForScan
        fs.writeFileSync(testFile, "hello modified\n");
        const changes = gitDiffForScan(tempGit, snapshot!);
        expect(changes.length).toBe(1);
        expect(changes[0]?.path).toBe("sample.txt");
        expect(changes[0]?.kind).toBe("modify");
      });
    } finally {
      fs.rmSync(tempGit, { recursive: true, force: true });
    }
  });
});

describe("Child Process Lifecycle & Shutdown Cleanup", () => {
  it("terminates child process tree and rejects pending requests on stop()", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-proc-lifecycle-"));
    const dummyServerJs = path.join(tempDir, "dummy-server.js");

    // Dummy server that reads stdin and never exits until killed
    fs.writeFileSync(dummyServerJs, `process.stdin.resume(); setInterval(() => {}, 1000);`);

    const adapter = new CodexAdapter(dummyServerJs);
    adapter.start();
    expect(adapter.pid).toBeGreaterThan(0);
    const pid = adapter.pid;

    // Trigger an outgoing request that stays pending
    let rejectedError: Error | null = null;
    // @ts-expect-error accessing private sendRequest for lifecycle verification
    const pendingPromise = adapter.sendRequest("testMethod", {}).catch((err: Error) => {
      rejectedError = err;
    });

    // Stop the adapter
    adapter.stop();
    await pendingPromise;

    expect(rejectedError).not.toBeNull();
    expect((rejectedError as Error | null)?.message).toContain("codex adapter stopped");
    expect(adapter.pid).toBe(0);

    // Verify process is terminated on OS
    await new Promise((r) => setTimeout(r, 200));
    let isRunning = false;
    try {
      process.kill(pid, 0);
      isRunning = true;
    } catch {
      isRunning = false;
    }
    expect(isRunning).toBe(false);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
