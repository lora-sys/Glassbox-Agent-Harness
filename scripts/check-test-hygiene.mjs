import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
const base = event.pull_request?.base?.sha ?? event.before;
const head = event.pull_request?.head?.sha ?? event.after ?? process.env.GITHUB_SHA;
const zeroSha = /^0+$/;

const TEST_PATHS = [
  "*.test.*",
  "*.spec.*",
  "apps/web/e2e/**",
  "apps/server/src/management/application-*-cases.ts",
];

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

if (!base || zeroSha.test(base)) {
  console.log("Test hygiene diff skipped because this event has no prior commit.");
  process.exit(0);
}

const diffArgs = ["diff", "--find-renames", `${base}...${head}`, "--", ...TEST_PATHS];
const entries = git([...diffArgs.slice(0, 1), "--name-status", ...diffArgs.slice(1)])
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => line.split("\t"));
const deletedTests = entries.filter(([status]) => status.startsWith("D"));
const diff = git(["diff", "--unified=0", `${base}...${head}`, "--", ...TEST_PATHS]);
const addedLines = diff
  .split(/\r?\n/)
  .filter((line) => line.startsWith("+") && !line.startsWith("+++"));
const removedLines = diff
  .split(/\r?\n/)
  .filter((line) => line.startsWith("-") && !line.startsWith("---"));
const disabledTest = addedLines.some((line) =>
  /(?:describe|it|test)\.(?:skip|only)|\.skipIf\(|\.todo\(/.test(line),
);
const testDeclaration = /^\s*(?:describe|it|test)(?:\.\w+)?\s*\(/;
const removedDeclarations = removedLines.filter((line) => testDeclaration.test(line)).length;
const addedDeclarations = addedLines.filter((line) => testDeclaration.test(line)).length;

if (deletedTests.length > 0 || disabledTest || removedDeclarations > addedDeclarations) {
  console.error("Test hygiene checks failed:");
  for (const [status, ...paths] of deletedTests)
    console.error(`- Test files cannot be deleted: ${status} ${paths.join(" -> ")}`);
  if (disabledTest) console.error("- Tests cannot be skipped, isolated, or marked todo.");
  if (removedDeclarations > addedDeclarations) {
    console.error(
      "- Changes reduce the number of test declarations. Update implementation instead of weakening coverage.",
    );
  }
  process.exit(1);
}

console.log(`Test hygiene checks passed for ${entries.length} changed test paths.`);
