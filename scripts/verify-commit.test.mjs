import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
