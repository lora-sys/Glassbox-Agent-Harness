import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const TEST_FILE = /(?:^|\/)(?:[^/]+\.(?:test|spec)\.[cm]?[jt]sx?|apps\/web\/e2e\/[^/]+)$/;
const CHECKABLE_FILE = /\.(?:[cm]?[jt]sx?|json|css)$/;

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

function stagedEntries() {
  const fields = capture("git", [
    "diff",
    "--cached",
    "--name-status",
    "--find-renames",
    "-z",
  ]).split("\0");
  const entries = [];

  for (let index = 0; index < fields.length - 1;) {
    const status = fields[index++];
    const path = fields[index++];
    if (!status || !path) {
      continue;
    }
    const entry = { status, path };
    if (status.startsWith("R") || status.startsWith("C")) {
      entry.target = fields[index++];
    }
    entries.push(entry);
  }

  return entries;
}

function verifyTestIntegrity(entries) {
  const removedTests = entries.filter(
    ({ status, path }) =>
      (status.startsWith("D") || status.startsWith("R")) && TEST_FILE.test(path),
  );
  if (removedTests.length > 0) {
    console.error("\nCommit blocked: existing test files cannot be deleted or renamed.");
    for (const entry of removedTests) {
      console.error(`  ${entry.status} ${entry.path}`);
    }
    process.exit(1);
  }

  const diff = capture("git", [
    "diff",
    "--cached",
    "--unified=0",
    "--",
    "*.test.*",
    "*.spec.*",
    "apps/web/e2e/**",
  ]);
  const addedLines = diff
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
  const removedLines = diff
    .split(/\r?\n/)
    .filter((line) => line.startsWith("-") && !line.startsWith("---"))
    .map((line) => line.slice(1));

  const disabledTest = addedLines.find((line) =>
    /(?:describe|it|test)\.(?:skip|only)|\.skipIf\(true\)|\.todo\(/.test(line),
  );
  if (disabledTest) {
    console.error("\nCommit blocked: staged changes disable or isolate a test.");
    console.error(`  ${disabledTest.trim()}`);
    process.exit(1);
  }

  const declaration = /^\s*(?:describe|it|test)(?:\.\w+)?\s*\(/;
  const removedDeclarations = removedLines.filter((line) => declaration.test(line)).length;
  const addedDeclarations = addedLines.filter((line) => declaration.test(line)).length;
  if (removedDeclarations > addedDeclarations) {
    console.error("\nCommit blocked: staged changes reduce the number of test declarations.");
    console.error("Update the implementation instead of weakening existing coverage.");
    process.exit(1);
  }
}

const entries = stagedEntries();
verifyTestIntegrity(entries);

const stagedPaths = entries
  .flatMap((entry) => [entry.target ?? entry.path])
  .filter((path) => existsSync(path) && CHECKABLE_FILE.test(path));

if (stagedPaths.length > 0) {
  run("vp", ["check", "--no-error-on-unmatched-pattern", ...stagedPaths]);
}

run("vp", ["run", "check:core"]);
run("vp", ["run", "test:unit"]);
run("vp", ["run", "test:e2e"]);
run("vp", ["run", "test:regression"]);
run("vp", ["run", "build:web"]);

console.log("\nCommit verification passed.");
