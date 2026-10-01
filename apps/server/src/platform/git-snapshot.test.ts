import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { gitLsFiles, gitDiffForScan } from "./git.js";
import { CodexAdapter } from "../codex/adapter.js";
import { ClaudeCodeAdapter } from "../claude-code/adapter.js";

it("keeps ignored additions outside the snapshot and does not mistake newly ignored prior files for deletions", () =>
  fixture((cwd) => {
    fs.writeFileSync(join(cwd, "existing.txt"), "owner content");
    const before = gitLsFiles(cwd)!;
    fs.writeFileSync(join(cwd, ".gitignore"), "existing.txt\nsecret.txt\n");
    fs.writeFileSync(join(cwd, "secret.txt"), "excluded secret");
    const changes = gitDiffForScan(cwd, before);
    expect(changes.map((change) => change.path)).toEqual([".gitignore"]);
    expect(JSON.stringify(changes)).not.toContain("excluded secret");
  }));

it("reports renames as an observed deletion and addition without guessing identity", () =>
  fixture((cwd, git) => {
    fs.writeFileSync(join(cwd, "old.txt"), "same\n");
    git("add", "old.txt");
    const before = gitLsFiles(cwd)!;
    fs.renameSync(join(cwd, "old.txt"), join(cwd, "new.txt"));
    git("add", "-A");
    expect(gitDiffForScan(cwd, before).map(({ path, kind }) => ({ path, kind }))).toEqual([
      { path: "new.txt", kind: "add" },
      { path: "old.txt", kind: "delete" },
    ]);
  }));

it("hashes binary changes without exposing binary bytes as text", () =>
  fixture((cwd) => {
    fs.writeFileSync(join(cwd, "binary.bin"), Buffer.from([0, 1, 2]));
    const before = gitLsFiles(cwd)!;
    fs.writeFileSync(join(cwd, "binary.bin"), Buffer.from([0, 3, 4]));
    expect(gitDiffForScan(cwd, before)).toEqual([{ path: "binary.bin", kind: "modify" }]);
  }));

it.each([".env", ".npmrc", "id_rsa", "private.key"])(
  "omits credential-like %s content from diff previews",
  (path) =>
    fixture((cwd) => {
      fs.writeFileSync(join(cwd, path), "fixture-sensitive-old\n");
      const before = gitLsFiles(cwd)!;
      expect(before[path]?.text).toBeUndefined();
      fs.writeFileSync(join(cwd, path), "fixture-sensitive-new\n");
      expect(gitDiffForScan(cwd, before)).toEqual([{ path, kind: "modify" }]);
    }),
);

it("bounds text previews and omits oversized unknown paths instead of fabricating deletions", () =>
  fixture((cwd) => {
    fs.writeFileSync(join(cwd, "large.txt"), "x".repeat(8 * 1024 * 1024 + 1));
    fs.writeFileSync(join(cwd, "text.txt"), "before\n".repeat(2000));
    const before = gitLsFiles(cwd)!;
    expect(before["large.txt"]).toBeNull();
    fs.unlinkSync(join(cwd, "large.txt"));
    fs.writeFileSync(join(cwd, "text.txt"), "after\n".repeat(2000));
    const changes = gitDiffForScan(cwd, before);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.path).toBe("text.txt");
    expect(changes[0]?.diff?.length).toBeLessThanOrEqual(2048);
    expect(changes[0]?.diff).toContain("[diff preview truncated]");
  }));

it("does not write the Git index while capturing and scanning", () =>
  fixture((cwd, git) => {
    fs.writeFileSync(join(cwd, "tracked.txt"), "one\n");
    git("add", "tracked.txt");
    const index = fs.readFileSync(join(cwd, ".git", "index"));
    const before = gitLsFiles(cwd)!;
    fs.writeFileSync(join(cwd, "tracked.txt"), "two\n");
    expect(gitDiffForScan(cwd, before)).toHaveLength(1);
    expect(fs.readFileSync(join(cwd, ".git", "index"))).toEqual(index);
  }));

it("never compares a baseline belonging to another workspace", () =>
  fixture((cwd) => {
    fs.writeFileSync(join(cwd, "one.txt"), "one\n");
    const before = gitLsFiles(cwd)!;
    fixture((other) => {
      fs.writeFileSync(join(other, "two.txt"), "two\n");
      expect(gitDiffForScan(other, before)).toEqual([]);
    });
  }));

it("does not let hook Git variables redirect the requested workspace", () =>
  fixture((cwd) => {
    const other = fs.mkdtempSync(join(tmpdir(), "glassbox-other-git-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: other, stdio: "pipe" });
      fs.writeFileSync(join(other, "foreign.txt"), "foreign\n");
      fs.writeFileSync(join(cwd, "requested.txt"), "requested\n");
      process.env.GIT_DIR = join(other, ".git");
      process.env.GIT_WORK_TREE = other;
      expect(Object.keys(gitLsFiles(cwd)!)).toEqual(["requested.txt"]);
    } finally {
      delete process.env.GIT_DIR;
      delete process.env.GIT_WORK_TREE;
      fs.rmSync(other, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }));

it("does not read through a parent directory link into an external directory", () =>
  fixture((cwd, git) => {
    const outside = fs.mkdtempSync(join(tmpdir(), "glassbox-outside-"));
    try {
      fs.mkdirSync(join(cwd, "inside"));
      fs.writeFileSync(join(cwd, "inside", "data.txt"), "safe\n");
      git("add", "inside/data.txt");
      const before = gitLsFiles(cwd)!;
      fs.writeFileSync(join(outside, "data.txt"), "outside private content\n");
      fs.rmSync(join(cwd, "inside"), { recursive: true });
      fs.symlinkSync(
        outside,
        join(cwd, "inside"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const changes = gitDiffForScan(cwd, before);
      expect(changes.some((change) => change.path === "inside/data.txt")).toBe(false);
      expect(JSON.stringify(changes)).not.toContain("outside private content");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }));

function fixture(run: (cwd: string, git: (...args: string[]) => void) => void) {
  const cwd = fs.mkdtempSync(join(tmpdir(), "glassbox-snapshot-"));
  const config = join(tmpdir(), `glassbox-empty-${randomUUID()}.gitconfig`);
  const saved = new Map(Object.entries(process.env).filter(([key]) => key.startsWith("GIT_")));
  for (const key of saved.keys()) delete process.env[key];
  fs.writeFileSync(config, "");
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_SYSTEM: config,
    GIT_CONFIG_NOSYSTEM: "1",
  });
  const git = (...args: string[]) => {
    execFileSync("git", args, { cwd, stdio: "pipe" });
  };
  try {
    git("init", "-q");
    run(cwd, git);
  } finally {
    for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
    for (const [key, value] of saved) if (value !== undefined) process.env[key] = value;
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(config, { force: true });
  }
}

it.each([false, true])("captures a first %s staged file from an empty repository", (staged) =>
  fixture((cwd, git) => {
    const before = gitLsFiles(cwd);
    expect(before).not.toBeNull();
    fs.writeFileSync(join(cwd, "new.txt"), "created\n");
    if (staged) git("add", "new.txt");
    expect(gitDiffForScan(cwd, before!)).toEqual([
      expect.objectContaining({ path: "new.txt", kind: "add" }),
    ]);
  }),
);

it.each([false, true])("captures deletion of the final indexed file, staged=%s", (staged) =>
  fixture((cwd, git) => {
    fs.writeFileSync(join(cwd, "old.txt"), "old\n");
    git("add", "old.txt");
    const before = gitLsFiles(cwd)!;
    fs.unlinkSync(join(cwd, "old.txt"));
    if (staged) git("add", "-u");
    expect(gitDiffForScan(cwd, before)).toEqual([
      expect.objectContaining({ path: "old.txt", kind: "delete" }),
    ]);
  }),
);

it("captures mixed staged and untracked additions with unstaged modifications", () =>
  fixture((cwd, git) => {
    fs.writeFileSync(join(cwd, "base.txt"), "base\n");
    git("add", "base.txt");
    const before = gitLsFiles(cwd)!;
    fs.writeFileSync(join(cwd, "base.txt"), "changed\n");
    fs.writeFileSync(join(cwd, "staged.txt"), "staged\n");
    git("add", "staged.txt");
    fs.writeFileSync(join(cwd, "untracked.txt"), "untracked\n");
    expect(gitDiffForScan(cwd, before).map(({ path, kind }) => ({ path, kind }))).toEqual([
      { path: "base.txt", kind: "modify" },
      { path: "staged.txt", kind: "add" },
      { path: "untracked.txt", kind: "add" },
    ]);
  }));

it.each([
  "报告.txt",
  "space name.txt",
  "quote'file.txt",
  "--option.txt",
  "__proto__",
  ...(process.platform === "win32" ? [] : ["tab\tname.txt", "line\nname.txt", "back\\slash.txt"]),
])("preserves the literal Git path %s and its content change", (name) =>
  fixture((cwd, git) => {
    fs.writeFileSync(join(cwd, name), "old\n");
    git("add", "--", name);
    const before = gitLsFiles(cwd)!;
    fs.writeFileSync(join(cwd, name), "updated\n");
    const changes = gitDiffForScan(cwd, before);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.path).toBe(name);
    expect(changes[0]?.diff).toContain("+updated");
    expect(changes[0]?.diff).toContain("-old");
  }),
);

it.each([CodexAdapter, ClaudeCodeAdapter])(
  "keeps pre-existing dirty work out of %s zero-write turns",
  (Adapter) =>
    fixture((cwd, git) => {
      fs.writeFileSync(join(cwd, "base.txt"), "indexed\n");
      git("add", "base.txt");
      fs.writeFileSync(join(cwd, "base.txt"), "owner's earlier work\n");
      const adapter = new Adapter();
      adapter.snapshotWorkspace(cwd);
      expect(adapter.scanAndFireHooks(cwd).changes).toEqual([]);
      adapter.snapshotWorkspace(cwd);
      fs.writeFileSync(join(cwd, "base.txt"), "new turn work\n");
      const changes = adapter.scanAndFireHooks(cwd).changes;
      expect(changes).toHaveLength(1);
      expect(changes[0]?.diff).toContain("-owner's earlier work");
      expect(changes[0]?.diff).not.toContain("-indexed");
      adapter.snapshotWorkspace(cwd);
      expect(adapter.scanAndFireHooks(cwd).changes).toEqual([]);
    }),
);
