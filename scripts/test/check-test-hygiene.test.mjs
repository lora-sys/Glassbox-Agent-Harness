import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectTestDiff } from "../check-test-hygiene.mjs";

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
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Test hygiene checks passed for 88 changed test paths/u);
});

test("large diff tail still rejects a disabled marker and removed declaration", () => {
  const testSkipMarker = ["test", "skip"].join(".");
  const diff = [
    `-${"x".repeat(1_058_500)}`,
    '-test("removed declaration", () => {});',
    `+const lateDisabled = ${testSkipMarker}("late disabled test", () => {});`,
  ].join("\n");
  assert.ok(Buffer.byteLength(diff, "utf8") > 1024 * 1024);
  const result = inspectTestDiff("M\tfixture.test.mjs\n", diff);
  assert.equal(result.disabledTest, true);
  assert.equal(result.removedDeclarations, 1);
  assert.equal(result.addedDeclarations, 0);
  assert.deepEqual(result.errors, ["disabled-tests", "reduced-test-declarations"]);
});
