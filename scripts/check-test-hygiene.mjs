import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const TEST_PATHS = [
  "*.test.*",
  "*.spec.*",
  "apps/web/e2e/**",
  "apps/server/src/management/application-*-cases.ts",
];

export function inspectTestDiff(entriesText, diff) {
  const entries = entriesText
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split("\t"));
  const deletedTests = entries.filter(([status]) => status.startsWith("D"));
  const addedLines = [];
  const removedLines = [];
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) addedLines.push(line.slice(1));
    if (line.startsWith("-") && !line.startsWith("---")) removedLines.push(line.slice(1));
  }
  const disabledTest = addedLines.some((line) =>
    /(?:describe|it|test)\.(?:skip|only)|\.skipIf\(|\.todo\(/.test(line),
  );
  const testDeclaration = /^\s*(?:describe|it|test)(?:\.\w+)?\s*\(/;
  const removedDeclarations = removedLines.filter((line) => testDeclaration.test(line)).length;
  const addedDeclarations = addedLines.filter((line) => testDeclaration.test(line)).length;
  const errors = [];
  if (deletedTests.length > 0) errors.push("deleted-tests");
  if (disabledTest) errors.push("disabled-tests");
  if (removedDeclarations > addedDeclarations) errors.push("reduced-test-declarations");
  return {
    entries,
    deletedTests,
    addedDeclarations,
    removedDeclarations,
    disabledTest,
    errors,
  };
}

function git(args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    });
  } catch (error) {
    if (error?.code === "ENOBUFS") {
      const bounded = new Error(
        `Test hygiene git output exceeded the ${MAX_GIT_OUTPUT_BYTES}-byte safety limit.`,
      );
      bounded.code = "TEST_HYGIENE_OUTPUT_LIMIT";
      throw bounded;
    }
    throw error;
  }
}

function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const base = event.pull_request?.base?.sha ?? event.before;
  const head = event.pull_request?.head?.sha ?? event.after ?? process.env.GITHUB_SHA;
  const zeroSha = /^0+$/;
  if (!base || zeroSha.test(base)) {
    console.log("Test hygiene diff skipped because this event has no prior commit.");
    return;
  }

  const range = `${base}...${head}`;
  const entriesText = git(["diff", "--find-renames", "--name-status", range, "--", ...TEST_PATHS]);
  const diff = git(["diff", "--unified=0", range, "--", ...TEST_PATHS]);
  const result = inspectTestDiff(entriesText, diff);
  if (result.errors.length > 0) {
    console.error("Test hygiene checks failed:");
    for (const [status, ...paths] of result.deletedTests)
      console.error(`- Test files cannot be deleted: ${status} ${paths.join(" -> ")}`);
    if (result.disabledTest) console.error("- Tests cannot be skipped, isolated, or marked todo.");
    if (result.errors.includes("reduced-test-declarations")) {
      console.error(
        "- Changes reduce the number of test declarations. Update implementation instead of weakening coverage.",
      );
    }
    process.exitCode = 1;
    return;
  }
  console.log(`Test hygiene checks passed for ${result.entries.length} changed test paths.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    const message =
      error?.code === "TEST_HYGIENE_OUTPUT_LIMIT"
        ? error.message
        : "Test hygiene checks failed because git diff could not be read.";
    console.error(message);
    process.exitCode = 1;
  }
}
