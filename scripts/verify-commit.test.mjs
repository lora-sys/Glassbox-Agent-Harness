import test from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  verificationChildEnvironment,
  discoverQqLiveTests,
  canReuseTestCache,
  getTestIntegrityIssues,
  isTestFilePath,
  parseNameStatus,
  selectTestPlan,
  testDiffPaths,
} from "./verify-commit.mjs";
import {
  createTestCacheKey,
  lookupTestCache,
  recordSuccessfulTestRun,
} from "./test-result-cache.mjs";

test("selects Vitest changed dependency graph for ordinary source and test changes", () => {
  assert.deepEqual(
    selectTestPlan([
      { status: "M", path: "apps/server/src/ops/reconciler.ts" },
      { status: "M", path: "apps/server/src/ops/reconciler.test.ts" },
    ]),
    {
      mode: "changed",
      reason: "Vitest changed dependency graph for staged and unstaged tracked files",
    },
  );
});

test("selects the full unit suite for shared contracts and trust-sensitive areas", () => {
  for (const path of [
    "packages/contracts/src/run.ts",
    "apps/server/src/authorization/decision.ts",
    "apps/server/src/persistence/sqlite.ts",
    "apps/server/src/runtime/pi/agent.ts",
    "apps/server/src/application/domain-store.ts",
  ]) {
    assert.equal(selectTestPlan([{ status: "M", path }]).mode, "full", path);
  }
});

test("selects the full unit suite when test, build, or validation configuration changes", () => {
  for (const path of [
    "vite.config.ts",
    "package.json",
    "package-lock.json",
    "scripts/verify-commit.mjs",
    ".vite-hooks/pre-commit",
  ]) {
    assert.equal(selectTestPlan([{ status: "M", path }]).mode, "full", path);
  }
});

test("selects the full unit suite for deletions and unclassified changes", () => {
  assert.equal(
    selectTestPlan([{ status: "D", path: "apps/server/src/runtime/old.ts" }]).mode,
    "full",
  );
  const unknown = selectTestPlan([{ status: "M", path: "infra/deployment.toml" }]);
  assert.equal(unknown.mode, "full");
  assert.equal(canReuseTestCache(unknown), false);
  assert.equal(
    canReuseTestCache(selectTestPlan([{ status: "M", path: "apps/server/src/runtime/old.ts" }])),
    true,
  );
});

test("omits tests for documentation-only changes or an empty change set", () => {
  assert.equal(selectTestPlan([{ status: "M", path: "docs/tech-stack.md" }]).mode, "none");
  assert.equal(selectTestPlan([]).mode, "none");
});

test("parses rename entries without losing either path", () => {
  assert.deepEqual(parseNameStatus(["R100", "old.ts", "new.ts", ""]), [
    { status: "R100", path: "old.ts", target: "new.ts" },
  ]);
});

test("allows test-file renames while preserving declaration-count checks", () => {
  const callStart = ["it", "("].join("");
  const diff = `-${callStart}"before"()\n+${callStart}"after"()`;
  assert.deepEqual(
    getTestIntegrityIssues(
      [{ status: "R100", path: "before.test.ts", target: "after.test.ts" }],
      diff,
    ),
    [],
  );
});

test("case modules balance moved declarations and remain protected against deletion", () => {
  const casePath = "apps/server/src/management/application-channel-cases.ts";
  assert.equal(isTestFilePath(casePath), true);
  assert.ok(testDiffPaths.includes("apps/server/src/management/application-*-cases.ts"));

  const callStart = ["it", "("].join("");
  const movedDeclaration = `-${callStart}"existing case"()\n+${callStart}"existing case"()`;
  assert.deepEqual(
    getTestIntegrityIssues(
      [
        { status: "M", path: "apps/server/src/management/application.test.ts" },
        { status: "A", path: casePath },
      ],
      movedDeclaration,
    ),
    [],
  );

  const deletionIssues = getTestIntegrityIssues(
    [{ status: "D", path: casePath }],
    `-${callStart}"existing case"()`,
  );
  assert.ok(deletionIssues.some((issue) => issue.message.includes("test files cannot be deleted")));
});

test("blocks deletion of existing test files", () => {
  const issues = getTestIntegrityIssues(
    [{ status: "D", path: "apps/server/src/example.test.ts" }],
    "",
  );
  assert.match(issues[0].message, /cannot be deleted/);
});

test("blocks reducing test declarations and disabling a test", () => {
  const callStart = ["test", "("].join("");
  const reduced = getTestIntegrityIssues([], `-${callStart}"case")`);
  assert.match(reduced[0].message, /reduce the number/);

  const disabled = ["test", ".", "skip("].join("");
  const disabledIssues = getTestIntegrityIssues([], `+${disabled}"case")`);
  assert.match(disabledIssues[0].message, /disable or isolate/);

  const conditionalSkip = ["it", ".skipIf", "(", "environment", ")"].join("");
  const conditionalSkipIssues = getTestIntegrityIssues([], `+${conditionalSkip}("case")`);
  assert.match(conditionalSkipIssues[0].message, /disable or isolate/);
});

test("test cache key changes with repository files, HEAD, toolchain, platform, and environment", () => {
  const base = {
    cwd: "C:/repo",
    head: "head-a",
    indexTree: "tree-a",
    files: [{ path: "src/a.ts", kind: "file", mode: 0o644, content: "content-a" }],
    node: "v24.12.0",
    nodePath: "C:/node.exe",
    platform: "win32",
    arch: "x64",
    vitePlusVersion: "vp v0.3.1",
    gitVersion: "git version 2.50.0",
    knownEnvironment: [["CI", "true"]],
    environment: [["CI", "true"]],
  };
  const baseKey = createTestCacheKey(base, "full unit suite");
  for (const changed of [
    { ...base, head: "head-b" },
    { ...base, files: [{ ...base.files[0], content: "content-b" }] },
    { ...base, node: "v24.13.0" },
    { ...base, platform: "linux" },
    { ...base, arch: "arm64" },
    { ...base, vitePlusVersion: "vp v0.3.2" },
    { ...base, environment: [["CI", "false"]] },
  ]) {
    assert.notEqual(createTestCacheKey(changed, "full unit suite"), baseKey);
  }
  assert.notEqual(
    createTestCacheKey(base, "full unit suite"),
    createTestCacheKey(base, "affected tests"),
  );
});

test("test cache misses until a successful matching run is recorded", () => {
  const directory = mkdtempSync(join(tmpdir(), "glassbox-test-cache-"));
  const cachePath = join(directory, "cache.json");
  const scope = "affected tests";
  const snapshot = { head: "head", files: ["input"] };
  const key = createTestCacheKey(snapshot, scope);
  const context = { cachePath, key, scope };
  try {
    assert.equal(lookupTestCache(context).hit, false);
    assert.equal(
      recordSuccessfulTestRun(
        context,
        {
          exitCode: 1,
          interrupted: false,
        },
        snapshot,
      ),
      false,
    );
    assert.equal(lookupTestCache(context).hit, false);
    assert.equal(
      recordSuccessfulTestRun(
        context,
        {
          exitCode: 0,
          interrupted: false,
        },
        snapshot,
      ),
      true,
    );
    assert.equal(lookupTestCache(context).hit, true);
    assert.equal(lookupTestCache({ ...context, key: `${key}-different` }).hit, false);
    assert.equal(lookupTestCache({ ...context, scope: "full unit suite" }).hit, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("test cache does not record interrupted or input-changing runs", () => {
  const directory = mkdtempSync(join(tmpdir(), "glassbox-test-cache-"));
  const cachePath = join(directory, "cache.json");
  const scope = "affected tests";
  const snapshot = { head: "head", files: ["input"] };
  const key = createTestCacheKey(snapshot, scope);
  const context = { cachePath, key, scope };
  try {
    for (const result of [
      { exitCode: 0, interrupted: true },
      { exitCode: 0, interrupted: false },
    ]) {
      assert.equal(
        recordSuccessfulTestRun(context, result, { ...snapshot, head: "changed" }),
        false,
      );
    }
    assert.equal(lookupTestCache(context).hit, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("delivery gates discover newly added QQ tests without a handwritten manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "qq-test-discovery-"));
  try {
    const dir = join(root, "tools", "qq-live", "test");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "existing.test.mjs"), "");
    writeFileSync(join(dir, "fixture.mjs"), "");
    mkdirSync(join(dir, "directory.test.mjs"));
    assert.deepEqual(discoverQqLiveTests(root), ["tools/qq-live/test/existing.test.mjs"]);
    writeFileSync(join(dir, "added.test.mjs"), "");
    assert.deepEqual(discoverQqLiveTests(root), [
      "tools/qq-live/test/added.test.mjs",
      "tools/qq-live/test/existing.test.mjs",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("empty QQ regression directory blocks gate discovery", () => {
  const root = mkdtempSync(join(tmpdir(), "qq-test-empty-"));
  try {
    mkdirSync(join(root, "tools", "qq-live", "test"), { recursive: true });
    assert.throws(() => discoverQqLiveTests(root), /no test files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("captures large test diffs without dropping integrity evidence at the tail", async () => {
  const { capture } = await import("./verify-commit.mjs");
  const disabled = ["it", ".", "skip("].join("") + "'disabled', () => {});";
  const tail = JSON.stringify(`+${disabled}\n`);
  const program = String.raw`process.stdout.write("+// fixture\n".repeat(120000) + ${tail})`;
  const diff = capture(process.execPath, ["-e", program]);
  assert.ok(Buffer.byteLength(diff) > 1024 * 1024);
  assert.ok(getTestIntegrityIssues([], diff).some((issue) => issue.message.includes("disable")));
});

test("validation children cannot inherit hook repository selectors into fixture Git operations", () => {
  const root = mkdtempSync(join(tmpdir(), "verification-hook-isolation-"));
  try {
    const outer = join(root, "outer");
    const inner = join(root, "inner");
    mkdirSync(outer);
    mkdirSync(inner);
    const git = (cwd, args, env = process.env) =>
      execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
    git(outer, ["init", "-b", "main"]);
    const inherited = {
      ...process.env,
      GIT_DIR: join(outer, ".git"),
      GIT_WORK_TREE: outer,
      GIT_INDEX_FILE: join(outer, ".git", "index"),
      GIT_PREFIX: "",
      GIT_AUTHOR_NAME: "hook",
      GIT_AUTHOR_EMAIL: "hook@example.test",
    };
    const clean = verificationChildEnvironment(inherited);
    assert.equal(clean.PATH, inherited.PATH);
    assert.equal(
      Object.keys(clean).some((key) => key.startsWith("GIT_")),
      false,
    );
    git(inner, ["init", "-b", "main"], clean);
    writeFileSync(join(inner, "fixture.txt"), "isolated fixture\n");
    git(inner, ["add", "fixture.txt"], clean);
    git(
      inner,
      [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.test",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-m",
        "fixture",
      ],
      clean,
    );
    assert.equal(git(outer, ["status", "--porcelain"]), "");
    assert.equal(git(inner, ["ls-files"], clean), "fixture.txt");
    assert.equal(git(outer, ["ls-files"]), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
