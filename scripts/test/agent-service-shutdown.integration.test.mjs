import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readLinuxProcessIdentity } from "../service-process-identity.mts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const serviceCli = join(repoRoot, "scripts/agent-service.mts");
const missingCheckout = join(tmpdir(), "glassbox-missing-checkout");

function dataFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "agent-service-shutdown-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function runDown(directory) {
  return spawnSync(process.execPath, ["--import", "tsx", serviceCli, "down"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, GLASSBOX_DATA_DIR: directory },
    timeout: 20_000,
  });
}

test("agent down tolerates transient post-SIGTERM status uncertainty for its verified process", async (t) => {
  const directory = dataFixture(t);
  const code = "setInterval(() => {}, 1000)";
  const child = spawn(process.execPath, ["-e", code, join(missingCheckout, "index.ts")], {
    cwd: tmpdir(),
    stdio: "ignore",
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });
  const identity = await new Promise((resolveIdentity, reject) => {
    child.once("error", reject);
    child.once("spawn", async () => {
      try {
        const value = await readLinuxProcessIdentity(child.pid);
        assert.ok(value, "the spawned fixture has a verified Linux identity");
        resolveIdentity(value);
      } catch (error) {
        reject(error);
      }
    });
  });
  const entry = {
    name: "napcat",
    pid: child.pid,
    startedAt: new Date(0).toISOString(),
    executable: process.execPath,
    args: ["-e", code, join(missingCheckout, "index.ts")],
    cwd: tmpdir(),
    linuxIdentity: identity,
  };
  writeFileSync(join(directory, "service-processes.json"), JSON.stringify([entry]), {
    mode: 0o600,
  });

  const result = runDown(directory);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { status: "stopped" });
  if (child.exitCode === null) await new Promise((resolveExit) => child.once("exit", resolveExit));
  assert.equal(child.signalCode, "SIGTERM");
});
