import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { baseConfig } from "./fixture.mjs";

const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "qq-review-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function run(argv, directory) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...argv], {
      cwd: directory,
      env: {
        ...process.env,
        HOME: directory,
        USERPROFILE: directory,
        DRIVER_TOKEN: "fixture-token-only",
        BOT_TOKEN: "fixture-token-only",
      },
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("review registration rejects execution and ambiguous arguments before loading config", async (t) => {
  const d = await fixture(t);
  for (const options of [
    [],
    ["--pr", "https://example.invalid/pr", "--live"],
    ["--pr", "https://example.invalid/pr", "--case", "transport-smoke"],
    ["--pr", "one", "--pr", "two"],
  ]) {
    const result = await run(["record-agent-review", ...options], d);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /ARGUMENT/);
    assert.doesNotMatch(result.stderr, /CONFIG_READ/);
  }
  const unrelated = await run(["plan", "--artifact", "review.json"], d);
  assert.equal(unrelated.code, 2);
  assert.match(unrelated.stderr, /ARGUMENT/);
});

test("review command reaches the delivery recorder without creating a QQ report", async (t) => {
  const d = await fixture(t);
  const config = join(d, "config.json");
  const out = join(d, "reports");
  await writeFile(config, JSON.stringify(baseConfig()));
  const result = await run(
    ["record-agent-review", "--config", config, "--out", out, "--pr", "https://example.invalid/pr"],
    d,
  );
  assert.equal(result.code, 2);
  assert.match(result.stderr, /GITHUB_PR_URL/);
  assert.doesNotMatch(result.stderr + result.stdout, /fixture-token-only/);
  await assert.rejects(stat(out), { code: "ENOENT" });
});

test("review registration is discoverable without credentials", async (t) => {
  const d = await fixture(t);
  const result = await run(["help"], d);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /record-agent-review --pr/);
  assert.match(result.stdout, /--expected-review-binding/);
});
