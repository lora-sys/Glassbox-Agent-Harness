// apps/server/src/platform/platform.test.ts
// Deterministic unit tests for the POSIX runtime platform layer.

import { describe, it, expect } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  getRepoRoot,
  getGlassboxDataDir,
  getServiceDataDir,
  getDefaultWorkspace,
  validateRepoPath,
  isPathInsideOrEqual,
} from "./paths.js";
import {
  defaultIsExecutableFile,
  resolveClaudeExecutable,
  resolveCodexExecutable,
  resolveExecutablePath,
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

  it("uses the managed service data directory by default and honors its override", () => {
    const original = process.env.GLASSBOX_DATA_DIR;
    try {
      delete process.env.GLASSBOX_DATA_DIR;
      expect(getServiceDataDir()).toBe(path.join(os.homedir(), ".glassbox"));

      process.env.GLASSBOX_DATA_DIR = path.join(os.tmpdir(), "glassbox-service-data");
      expect(getServiceDataDir()).toBe(path.resolve(os.tmpdir(), "glassbox-service-data"));
    } finally {
      if (original === undefined) delete process.env.GLASSBOX_DATA_DIR;
      else process.env.GLASSBOX_DATA_DIR = original;
    }
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
    } finally {
      if (origCodex !== undefined) process.env.GLASSBOX_WORKSPACE_CODEX = origCodex;
      if (origClaude !== undefined) process.env.GLASSBOX_WORKSPACE_CLAUDE = origClaude;
      if (origDemo !== undefined) process.env.GLASSBOX_WORKSPACE_DEMO = origDemo;
    }
  });

  it("detects path containment and child named ..data", () => {
    const repo = getRepoRoot();

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

    // 5. Subdirectory inside Glassbox repo
    const subRepoResult = validateRepoPath(path.join(getRepoRoot(), "apps", "server"));
    expect(subRepoResult.ok).toBe(false);
    if (!subRepoResult.ok) {
      expect(subRepoResult.error).toContain("Glassbox repo path is not allowed");
    }

    // 6. Reserved ~/.glassbox
    expect(validateRepoPath("~/.glassbox")).toEqual({
      ok: false,
      error: "~/.glassbox is reserved",
    });

    // 7. Legitimate temporary directory outside repo returns canonical realPath
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

  it("resolves symlinks to the canonical target directory", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "glassbox-junction-test-"));
    const targetDir = path.join(tempRoot, "target");
    const linkDir = path.join(tempRoot, "link_to_target");
    fs.mkdirSync(targetDir, { recursive: true });

    try {
      fs.symlinkSync(targetDir, linkDir, "dir");

      const res = validateRepoPath(linkDir);
      expect(res.ok).toBe(true);
      if (res.ok) {
        const canonicalTarget = fs.realpathSync(targetDir);
        expect(res.realPath).toBe(canonicalTarget);
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

describe("Executable and Launcher Resolution", () => {
  it("resolves an executable on a fixture PATH via X_OK and rejects missing commands", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-exec-path-test-"));
    const tool = path.join(tempDir, "fixture-tool");
    fs.writeFileSync(tool, "#!/bin/sh\n");
    fs.chmodSync(tool, 0o755);
    const notExecutable = path.join(tempDir, "fixture-plain");
    fs.writeFileSync(notExecutable, "data\n");

    try {
      const env = { PATH: tempDir };
      expect(resolveExecutablePath("fixture-tool", { env })).toBe(path.resolve(tool));
      expect(resolveExecutablePath("fixture-plain", { env })).toBeUndefined();
      expect(resolveExecutablePath("fixture-missing", { env })).toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves an explicit Claude binary path and fails clearly when it is missing", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-claude-explicit-test-"));
    const claude = path.join(tempDir, "claude");
    fs.writeFileSync(claude, "#!/bin/sh\n");
    fs.chmodSync(claude, 0o755);

    try {
      expect(resolveClaudeExecutable({ binaryPath: claude })).toBe(path.resolve(claude));
      expect(resolveClaudeExecutable({ binaryPath: "/nonexistent/claude" })).toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves a bare Claude command on PATH and fails clearly when unresolvable", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-claude-path-test-"));
    const claude = path.join(tempDir, "claude");
    fs.writeFileSync(claude, "#!/bin/sh\n");
    fs.chmodSync(claude, 0o755);

    try {
      expect(
        resolveClaudeExecutable({ env: { PATH: tempDir }, isFile: defaultIsExecutableFile }),
      ).toBe(path.resolve(claude));
      expect(
        resolveClaudeExecutable({ binaryPath: "claude-missing-xyz", env: { PATH: tempDir } }),
      ).toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves a slash-bearing command directly without scanning PATH", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-exec-slash-test-"));
    const tool = path.join(tempDir, "fixture-tool");
    fs.writeFileSync(tool, "#!/bin/sh\n");
    fs.chmodSync(tool, 0o755);

    try {
      const env = { PATH: "/definitely-empty-path" };
      expect(resolveExecutablePath(tool, { env })).toBe(path.resolve(tool));
      expect(resolveExecutablePath(path.join(tempDir, "missing"), { env })).toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("runs a JS entry Codex executable under the current Node runtime", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-codex-js-test-"));
    const jsEntry = path.join(tempDir, "codex.js");
    fs.writeFileSync(jsEntry, "// codex.js\n");

    try {
      const jsRes = resolveCodexExecutable({ binaryPath: jsEntry });
      expect(jsRes).toBeDefined();
      expect(jsRes?.shell).toBe(false);
      expect(jsRes?.command).toBe(process.execPath);
      expect(jsRes?.args).toEqual([path.resolve(jsEntry), "app-server"]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("runs a native Codex executable directly and rejects missing binaries", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-codex-native-test-"));
    const nativeEntry = path.join(tempDir, "codex-native");
    fs.writeFileSync(nativeEntry, "binary\n");
    fs.chmodSync(nativeEntry, 0o755);

    try {
      const nativeRes = resolveCodexExecutable({ binaryPath: nativeEntry });
      expect(nativeRes).toBeDefined();
      expect(nativeRes?.shell).toBe(false);
      expect(nativeRes?.command).toBe(path.resolve(nativeEntry));
      expect(nativeRes?.args).toEqual(["app-server"]);

      expect(resolveCodexExecutable({ binaryPath: "/nonexistent/codex" })).toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves explicit configured binary path without silent fallback", () => {
    const missingClaude = resolveClaudeExecutable({
      binaryPath: "/nonexistent/claude-binary-xyz",
    });
    expect(missingClaude).toBeUndefined();

    const missingCodex = resolveCodexExecutable({
      binaryPath: "/nonexistent/codex-binary-xyz",
    });
    expect(missingCodex).toBeUndefined();
  });

  it("spawns POSIX commands directly without a shell", () => {
    const resolved = resolveSpawnCommand("fixture-tool", ["--flag"]);
    expect(resolved).toEqual({ command: "fixture-tool", args: ["--flag"], shell: false });
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
