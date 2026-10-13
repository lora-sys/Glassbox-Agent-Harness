import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sanitizedGitEnvironment } from "./git-environment.mjs";
import { inspectTestSources } from "./test-integrity.mjs";

const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const TEST_PATHS = [
  "*.test.*",
  "*.spec.*",
  "apps/web/e2e/**",
  "apps/server/src/management/application-*-cases.ts",
];

export function inspectTestDiff(entriesText, _diff, sourcePairs = []) {
  const entries = entriesText
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.split("\t"));
  const deletedTests = entries.filter(([status]) => status.startsWith("D"));
  const integrity = inspectTestSources(sourcePairs);
  const errors = [];
  if (deletedTests.length > 0) errors.push("deleted-tests");
  if (integrity.disabled.length > 0) errors.push("disabled-tests");
  if (integrity.alwaysPassing.length > 0) errors.push("always-passing-assertions");
  if (integrity.parseErrors.length > 0) errors.push("test-parse-errors");
  if (integrity.errors.includes("reduced-test-coverage")) errors.push("reduced-test-coverage");
  if (integrity.errors.includes("invalid-test-replacement"))
    errors.push("invalid-test-replacement");
  errors.push(...integrity.errors.filter((error) => error.startsWith('Test "')));
  return {
    entries,
    deletedTests,
    addedDeclarations: integrity.afterCount,
    removedDeclarations: integrity.deletedTests.length,
    disabledTest: integrity.disabled.length > 0,
    alwaysPassing: integrity.alwaysPassing,
    parseErrors: integrity.parseErrors,
    warnings: integrity.warnings,
    errors,
  };
}
function git(args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      env: sanitizedGitEnvironment(),
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
  const entries = entriesText
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.split("\t"));
  const sourcePairs = entries.map(([status, oldPath, newPath]) => {
    const from = status.startsWith("A") ? undefined : oldPath;
    const to = status.startsWith("D") ? undefined : (newPath ?? oldPath);
    return {
      oldPath: from,
      newPath: to,
      oldSource: from ? git(["show", base + ":" + from]) : undefined,
      newSource: to ? git(["show", head + ":" + to]) : undefined,
    };
  });
  const result = inspectTestDiff(entriesText, "", sourcePairs);
  if (result.errors.length > 0) {
    console.error("Test hygiene checks failed:");
    for (const [status, ...paths] of result.deletedTests)
      console.error(`- Test files cannot be deleted: ${status} ${paths.join(" -> ")}`);
    if (result.disabledTest) console.error("- Tests cannot be skipped, isolated, or marked todo.");
    if (result.errors.includes("always-passing-assertions"))
      console.error("- Always-passing assertions are not accepted.");
    if (result.errors.includes("reduced-test-coverage"))
      console.error("- Existing test cases and their assertions must be preserved.");
    if (result.errors.includes("invalid-test-replacement"))
      console.error("- Test replacements need an exact reviewed old-to-new title mapping.");
    for (const error of result.errors.filter((item) => item.startsWith('Test "')))
      console.error(
        "- " + error + "; add a test-contract-change marker for intentional contracts.",
      );
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
