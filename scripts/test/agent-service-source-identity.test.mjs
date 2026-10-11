import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readLinuxProcessIdentity } from "../service-process-identity.mts";
import { serviceSourceIdentity } from "../service-source-identity.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const serviceCli = join(repoRoot, "scripts/agent-service.mts");
const processCode = "setInterval(() => {}, 1000)";
const missingCheckout = join(tmpdir(), "glassbox-missing-checkout");

function dataFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "agent-service-source-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function dirtySourceFixture(t) {
  const checkout = mkdtempSync(join(tmpdir(), "agent-service-source-checkout-"));
  chmodSync(checkout, 0o700);
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: checkout });
  execFileSync("git", ["config", "user.name", "Glassbox test"], { cwd: checkout });
  execFileSync("git", ["config", "user.email", "glassbox-test@example.invalid"], {
    cwd: checkout,
  });
  const entry = join(checkout, "index.ts");
  writeFileSync(entry, "export const source = 'committed';\n");
  execFileSync("git", ["add", "index.ts"], { cwd: checkout });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: checkout });
  writeFileSync(entry, "export const source = 'dirty';\n");
  return checkout;
}

function processFixture(t, { staleBoot = false } = {}) {
  const child = spawn(process.execPath, ["-e", processCode, join(missingCheckout, "index.ts")], {
    cwd: tmpdir(),
    stdio: "ignore",
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });
  return new Promise((resolveIdentity, reject) => {
    child.once("error", reject);
    child.once("spawn", async () => {
      try {
        const identity = await readLinuxProcessIdentity(child.pid);
        assert.ok(identity, "spawned fixture process has a Linux identity");
        resolveIdentity({
          child,
          identity: staleBoot
            ? { ...identity, bootId: "00000000-0000-0000-0000-000000000000" }
            : identity,
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function writeState(directory, processEntry) {
  const statePath = join(directory, "service-processes.json");
  writeFileSync(statePath, JSON.stringify([processEntry], null, 2), { mode: 0o600 });
  return statePath;
}

function runService(command, directory, port = "0") {
  return spawnSync(process.execPath, ["--import", "tsx", serviceCli, command], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, GLASSBOX_DATA_DIR: directory, PORT: port },
    timeout: 20_000,
  });
}

function savedEntry(child, identity, extra = {}) {
  return {
    name: "glassbox",
    pid: child.pid,
    startedAt: new Date(0).toISOString(),
    executable: process.execPath,
    args: ["-e", processCode, join(missingCheckout, "index.ts")],
    cwd: missingCheckout,
    linuxIdentity: identity,
    launchCommit: "a".repeat(40),
    launchClean: false,
    ...extra,
  };
}

test("status keeps a verified live PID but blocks readiness when its checkout is missing", async (t) => {
  const directory = dataFixture(t);
  const { child, identity } = await processFixture(t);
  const statePath = writeState(directory, savedEntry(child, identity));
  const before = readFileSync(statePath, "utf8");

  const result = runService("status", directory);
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.deepEqual(status.processes[0], {
    name: "glassbox",
    pid: child.pid,
    running: true,
    status: "running",
    checkout: missingCheckout,
    startedAt: new Date(0).toISOString(),
    launchCommit: "a".repeat(40),
    launchClean: false,
    launchSourceTreeSha256: null,
    checkoutSourceVerified: false,
  });
  assert.equal(status.glassboxReady, false);
  assert.equal(readFileSync(statePath, "utf8"), before);
  assert.equal(child.exitCode, null);
});

test("a process recorded from an earlier Linux boot is stopped without signaling a reused PID", async (t) => {
  const directory = dataFixture(t);
  const { child, identity } = await processFixture(t, { staleBoot: true });
  const statePath = writeState(directory, savedEntry(child, identity));
  const before = readFileSync(statePath, "utf8");

  const result = runService("status", directory);
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.processes[0].status, "stopped");
  assert.equal(status.processes[0].running, false);
  assert.equal(status.glassboxReady, false);
  assert.equal(readFileSync(statePath, "utf8"), before);
  assert.equal(child.exitCode, null, "current process using the PID is left untouched");
});

test("malformed saved source digests fail closed without changing the receipt", async (t) => {
  const directory = dataFixture(t);
  const { child, identity } = await processFixture(t);
  const statePath = writeState(
    directory,
    savedEntry(child, identity, {
      launchSourceTreeSha256: "not-a-digest",
    }),
  );
  const before = readFileSync(statePath, "utf8");

  const result = runService("status", directory);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid service state/u);
  assert.equal(readFileSync(statePath, "utf8"), before);
  assert.equal(child.exitCode, null);
});

test("a listening endpoint with matching source does not make an earlier-boot process ready", async (t) => {
  const directory = dataFixture(t);
  const checkout = dirtySourceFixture(t);
  const code =
    "require('node:http').createServer((q,r)=>r.end('ok')).listen(0,'127.0.0.1',function(){console.log(this.address().port)})";
  const child = spawn(process.execPath, ["-e", code, join(checkout, "index.ts")], {
    cwd: checkout,
    stdio: ["ignore", "pipe", "ignore"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });
  const port = await new Promise((resolvePort, reject) => {
    child.once("error", reject);
    child.stdout.once("data", (data) => resolvePort(data.toString().trim()));
  });
  const identity = await readLinuxProcessIdentity(child.pid);
  assert.ok(identity);
  const source = serviceSourceIdentity(checkout);
  assert.ok(source?.launchCommit);
  assert.equal(source.launchClean, false);
  assert.match(source.launchSourceTreeSha256 ?? "", /^[a-f0-9]{64}$/u);
  writeState(directory, {
    ...savedEntry(child, { ...identity, bootId: "00000000-0000-0000-0000-000000000000" }),
    args: ["-e", code, join(checkout, "index.ts")],
    cwd: checkout,
    ...source,
  });
  const result = runService("status", directory, port);
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(
    status.processes[0].checkoutSourceVerified,
    true,
    JSON.stringify({
      captured: source,
      current: serviceSourceIdentity(checkout),
      status: {
        launchCommit: status.processes[0].launchCommit,
        launchClean: status.processes[0].launchClean,
        launchSourceTreeSha256: status.processes[0].launchSourceTreeSha256,
      },
    }),
  );
  assert.equal(status.processes[0].status, "stopped");
  assert.equal(status.glassboxReady, false);
  assert.equal(child.exitCode, null);
});
