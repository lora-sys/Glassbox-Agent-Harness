import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  lookupTestCache,
  prepareTestCache,
  recordSuccessfulTestRun,
} from "./test-result-cache.mjs";

const TEST_FILE =
  /(?:^|\/)(?:[^/]+\.(?:test|spec)\.[cm]?[jt]sx?|apps\/web\/e2e\/[^/]+|apps\/server\/src\/management\/application-[^/]+-cases\.ts)$/;
const TEST_DIFF_PATHS = [
  "*.test.*",
  "*.spec.*",
  "apps/web/e2e/**",
  "apps/server/src/management/application-*-cases.ts",
];
const testDiffPaths = TEST_DIFF_PATHS;
const CHECKABLE_FILE = /\.(?:[cm]?[jt]sx?|json|css)$/;
const FULL_TEST_FALLBACK = [
  ["rename or deletion", /^(?:R|D|C)/],
  [
    "test or build configuration",
    /(?:^|\/)(?:package(?:-lock)?\.json|vite\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|tsconfig[^/]*\.json|[^/]*\.config\.[cm]?[jt]s)$/i,
  ],
  ["scripts or validation tooling", /^(?:scripts|\.vite-hooks)\//],
  ["application composition root", /^apps\/server\/src\/application\//],
  ["shared contracts", /^(?:packages\/contracts|apps\/server\/src\/contracts)\//],
  [
    "authorization, persistence, or runtime",
    /(?:^|\/)(?:authorization|authz?|permissions?|policy|persistence|runtime)(?:\/|\.)/i,
  ],
  [
    "application configuration or schema",
    /(?:^|\/)(?:config|schemas?)(?:\/|\.)|(?:^|\/)\.env(?:\.|$)/i,
  ],
];

function run(command, args) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return result;
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

function parseNameStatus(fields) {
  const entries = [];
  for (let index = 0; index < fields.length - 1;) {
    const status = fields[index++];
    const path = fields[index++];
    if (!status || !path) continue;
    const entry = { status, path };
    if (status.startsWith("R") || status.startsWith("C")) {
      entry.target = fields[index++];
    }
    entries.push(entry);
  }
  return entries;
}

function stagedEntries() {
  return parseNameStatus(
    capture("git", ["diff", "--cached", "--name-status", "--find-renames", "-z"]).split("\0"),
  );
}

function workingTreeEntries() {
  return parseNameStatus(
    capture("git", ["diff", "HEAD", "--name-status", "--find-renames", "-z"]).split("\0"),
  );
}

function isTestFilePath(path) {
  return TEST_FILE.test(path);
}

function getTestIntegrityIssues(entries, diff) {
  const issues = [];
  const deletedTests = entries.filter(
    ({ status, path }) => status.startsWith("D") && isTestFilePath(path),
  );
  if (deletedTests.length > 0) {
    issues.push({
      message: "Commit blocked: existing test files cannot be deleted.",
      details: deletedTests.map((entry) => `  ${entry.status} ${entry.path}`),
    });
  }

  const addedLines = diff
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
  const removedLines = diff
    .split(/\r?\n/)
    .filter((line) => line.startsWith("-") && !line.startsWith("---"))
    .map((line) => line.slice(1));

  const disabledTest = addedLines.find((line) =>
    /(?:describe|it|test)\.(?:skip|only)|\.skipIf\(|\.todo\(/.test(line),
  );
  if (disabledTest) {
    issues.push({
      message: "Commit blocked: staged changes disable or isolate a test.",
      details: [`  ${disabledTest.trim()}`],
    });
  }

  const declaration = /^\s*(?:describe|it|test)(?:\.\w+)?\s*\(/;
  const removedDeclarations = removedLines.filter((line) => declaration.test(line)).length;
  const addedDeclarations = addedLines.filter((line) => declaration.test(line)).length;
  if (removedDeclarations > addedDeclarations) {
    issues.push({
      message: "Commit blocked: staged changes reduce the number of test declarations.",
      details: ["Update the implementation instead of weakening existing coverage."],
    });
  }
  return issues;
}

function verifyTestIntegrity(entries) {
  const diff = capture("git", ["diff", "--cached", "--unified=0", "--", ...TEST_DIFF_PATHS]);
  const issues = getTestIntegrityIssues(entries, diff);
  if (issues.length > 0) {
    for (const issue of issues) {
      console.error(`\n${issue.message}`);
      for (const detail of issue.details) console.error(detail);
    }
    process.exit(1);
  }
}

function selectTestPlan(entries) {
  const paths = entries.flatMap(({ path, target }) => (target ? [path, target] : [path]));
  if (paths.length === 0) {
    return { mode: "none", reason: "no staged or unstaged tracked changes" };
  }

  for (const [reason, pattern] of FULL_TEST_FALLBACK) {
    const match = entries.find(({ status, path, target }) => {
      const candidates = target ? [path, target] : [path];
      if (reason === "rename or deletion" && pattern.test(status)) return true;
      return candidates.some((candidate) => pattern.test(candidate));
    });
    if (match) {
      return { mode: "full", reason: `${reason}: ${match.path}` };
    }
  }

  if (paths.some((path) => /\.(?:[cm]?[jt]sx?)$/i.test(path) || isTestFilePath(path))) {
    return {
      mode: "changed",
      reason: "Vitest changed dependency graph for staged and unstaged tracked files",
    };
  }
  const unclassified = paths.find(
    (path) => !/^(?:\.plans\/|docs\/|README(?:\.[^/]*)?$|CHANGELOG(?:\.[^/]*)?$)/i.test(path),
  );
  if (unclassified) {
    return { mode: "full", reason: `unclassified non-document change: ${unclassified}` };
  }
  return { mode: "none", reason: "documentation-only changes do not affect Vitest tests" };
}

function canReuseTestCache(plan) {
  return (
    plan.mode === "changed" ||
    (plan.mode === "full" && !plan.reason.startsWith("unclassified non-document change:"))
  );
}

function printPlan(entries, plan) {
  console.log("\nChanged tracked paths:");
  if (entries.length === 0) console.log("  (none)");
  for (const { status, path, target } of entries) {
    console.log(`  ${status} ${path}${target ? ` -> ${target}` : ""}`);
  }
  console.log(`Test scope: ${plan.mode}. Reason: ${plan.reason}.`);
}

function runChangedTests() {
  const entries = workingTreeEntries();
  const plan = selectTestPlan(entries);
  printPlan(entries, plan);

  if (plan.mode === "full") {
    const args = ["run", "test:unit"];
    if (canReuseTestCache(plan)) {
      runTestCommandWithCache(args, "full unit suite");
    } else {
      console.log("Test cache disabled: impact is unclassified; running the full unit suite.");
      run("vp", args);
    }
  } else if (plan.mode === "changed") {
    runTestCommandWithCache(
      ["test", "run", "--allowOnly=false", "--maxWorkers=4", "--passWithNoTests", "--changed=HEAD"],
      "Vitest affected tests from --changed=HEAD",
    );
  } else {
    console.log("Tests omitted: no affected test inputs were found.");
  }
}

function runTestCommandWithCache(args, scope) {
  const cache = prepareTestCache(scope);
  if (!cache) {
    console.log(
      `Test cache miss for ${scope}: repository or environment fingerprint is uncertain.`,
    );
    run("vp", args);
    return;
  }

  const cached = lookupTestCache(cache);
  if (cached.hit) {
    console.log(
      `Reused test scope: ${scope}. Reason: ${cached.reason}; exact fingerprint ${cache.key.slice(0, 16)} matched.`,
    );
    return;
  }
  console.log(`Test cache miss for ${scope}. Reason: ${cached.reason}; running validation.`);
  const result = run("vp", args);
  if (
    recordSuccessfulTestRun(cache, { exitCode: result.status, interrupted: Boolean(result.signal) })
  ) {
    console.log(
      `Cached successful test scope: ${scope}; exact fingerprint ${cache.key.slice(0, 16)}.`,
    );
  } else {
    console.log(
      `Did not cache ${scope}: the run was interrupted, failed, or repository/environment inputs changed.`,
    );
  }
}

function runFullVerification() {
  const entries = stagedEntries();
  verifyTestIntegrity(entries);
  runStagedChecks(entries);
  console.log("Full verification: core checks, selector checks, unit suite once, and web build.");
  run("vp", ["run", "check:core"]);
  run(process.execPath, ["--test", "scripts/verify-commit.test.mjs"]);
  runTestCommandWithCache(["run", "test:unit"], "full unit suite");
  run("vp", ["run", "build:web"]);
  console.log("\nFull verification passed.");
}

function runStagedChecks(entries) {
  const stagedPaths = entries
    .flatMap((entry) => [entry.target ?? entry.path])
    .filter((path) => existsSync(path) && CHECKABLE_FILE.test(path));
  if (stagedPaths.length > 0) {
    console.log("Staged file checks:");
    for (const path of stagedPaths) console.log(`  ${path}`);
    run("vp", ["check", "--no-error-on-unmatched-pattern", ...stagedPaths]);
  }
}

export {
  canReuseTestCache,
  getTestIntegrityIssues,
  isTestFilePath,
  parseNameStatus,
  selectTestPlan,
  testDiffPaths,
};

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  if (process.argv.includes("--full")) {
    runFullVerification();
  } else {
    const entries = stagedEntries();
    verifyTestIntegrity(entries);
    runStagedChecks(entries);
    run(process.execPath, ["--test", "scripts/verify-commit.test.mjs"]);
    runChangedTests();
    console.log("\nCommit verification passed.");
  }
}
