// test-contract-change: ISSUE-194 compares full AST test contracts including one-line changes
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectTestDiff } from "../check-test-hygiene.mjs";
import { inspectTestSources } from "../test-integrity.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const base = "176ea9faa34a2f736f4564cdfc29d2a240006153";
const head = "40e279855b34962b08942038ae039eb28792a8ba";
const maxBuffer = 16 * 1024 * 1024;

test("the exact PR 142 test diff above 1 MiB is checked without truncation", async (t) => {
  const temp = await mkdtemp(resolve(tmpdir(), "test-hygiene-pr142-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const eventPath = resolve(temp, "event.json");
  await writeFile(
    eventPath,
    JSON.stringify({
      pull_request: { base: { sha: base }, head: { sha: head } },
    }),
  );
  const fixtureDiff = spawnSync(
    "git",
    [
      "diff",
      "--unified=0",
      `${base}...${head}`,
      "--",
      "*.test.*",
      "*.spec.*",
      "apps/web/e2e/**",
      "apps/server/src/management/application-*-cases.ts",
    ],
    { cwd: root, encoding: "utf8", maxBuffer },
  );
  assert.equal(fixtureDiff.status, 0, fixtureDiff.stderr);
  assert.equal(Buffer.byteLength(fixtureDiff.stdout, "utf8"), 1_058_423);
  assert.ok(Buffer.byteLength(fixtureDiff.stdout, "utf8") > 1024 * 1024);
  const result = spawnSync(process.execPath, [resolve(root, "scripts/check-test-hygiene.mjs")], {
    cwd: root,
    encoding: "utf8",
    maxBuffer,
    env: { ...process.env, GITHUB_EVENT_PATH: eventPath },
  });
  assert.equal(result.status, 1, result.stderr);
  const output = result.stdout + result.stderr;
  assert.match(output, /Test hygiene checks failed/u);
  assert.match(output, /records a private message dropped while the connection is not ready/u);
  assert.match(output, /persists the birth token when starting a new service/u);
  assert.match(output, /Pi session boundary/u);
  assert.match(output, /declared capacities/u);
});

test("large diff tail still rejects a disabled marker and removed declaration", () => {
  const padding = "/*" + "x".repeat(1_058_500) + "*/";
  const oldSource = padding + 'test("removed declaration", () => {});';
  const newSource = padding + 'test.skip("late disabled test", () => {});';
  const result = inspectTestDiff("M", "", [{ path: "fixture.test.mjs", oldSource, newSource }]);
  assert.ok(Buffer.byteLength(newSource, "utf8") > 1024 * 1024);
  assert.equal(result.disabledTest, true);
  assert.equal(result.removedDeclarations, 1);
  assert.equal(result.addedDeclarations, 1);
  assert.deepEqual(result.errors, ["disabled-tests", "reduced-test-coverage"]);
});

test("AST comparison rejects a same-line test deletion and assertion weakening", () => {
  const removed = inspectTestSources([
    {
      path: "fixture.test.mjs",
      oldSource:
        'test("first", () => assert.equal(actual, expected)); test("second", () => assert.ok(done));',
      newSource: 'test("second", () => assert.ok(done));',
    },
  ]);
  assert.ok(removed.errors.includes("reduced-test-coverage"));
  assert.deepEqual(removed.deletedTests, ["first"]);

  const weakened = inspectTestSources([
    {
      path: "fixture.test.mjs",
      oldSource: 'test("keeps the result check", () => assert.equal(actual, expected));',
      newSource: 'test("keeps the result check", () => assert.ok(true));',
    },
  ]);
  assert.ok(weakened.errors.includes("always-passing-assertions"));
  assert.ok(weakened.errors.some((error) => error.startsWith('Test "keeps the result check"')));
});

test("AST comparison permits intentional assertion changes only with a review marker", () => {
  const result = inspectTestSources([
    {
      path: "fixture.test.mjs",
      oldSource: 'test("contract", () => assert.equal(actual, "old"));',
      newSource:
        '// test-contract-change: GH-194 new response contract\ntest("contract", () => assert.equal(actual, "new"));',
    },
  ]);
  assert.deepEqual(result.errors, []);
  assert.match(result.warnings[0], /manual review required/u);
});
