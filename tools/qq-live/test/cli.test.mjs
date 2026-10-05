import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { world, baseConfig } from "./fixture.mjs";
const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
async function run(args, dir, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: dir,
      env: {
        ...process.env,
        HOME: dir,
        USERPROFILE: dir,
        DRIVER_TOKEN: "fixture-token-only",
        BOT_TOKEN: "fixture-token-only",
        ...extraEnv,
      },
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
async function dir(t) {
  const d = await mkdtemp(join(tmpdir(), "qq-live-cli-"));
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
}
test("init creates config and refuses overwriting", async (t) => {
  const d = await dir(t);
  const p = join(d, "c.json");
  assert.equal((await run(["init", "--config", p], d)).code, 0);
  assert.equal((await run(["init", "--config", p], d)).code, 2);
});
test("help requires no credentials or network", async (t) => {
  const d = await dir(t);
  assert.equal((await run(["help"], d)).code, 0);
});
test("unknown ordinary send persists STOP and blocks a later run", async (t) => {
  const d = await dir(t),
    w = await world({ ack: "timeout" });
  t.after(() => w.close());
  const p = join(d, "c.json"),
    out = join(d, "reports");
  await writeFile(p, JSON.stringify(w.config));
  const first = await run(["run", "--live", "--case", "private", "--config", p, "--out", out], d);
  assert.equal(first.code, 3);
  assert.ok(await readFile(join(out, "STOP"), "utf8"));
  const count = w.actions.length;
  assert.equal((await run(["run", "--live", "--config", p, "--out", out], d)).code, 2);
  assert.equal(w.actions.length, count);
});
test("custom live prompts are blocked before any network operation", async (t) => {
  const d = await dir(t),
    p = join(d, "c.json"),
    suite = join(d, "s.json");
  await writeFile(p, JSON.stringify(baseConfig()));
  await writeFile(suite, "{}");
  const r = await run(["run", "--live", "--config", p, "--scenarios", suite], d);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("CUSTOM_LIVE_UNSUPPORTED"));
});
test("structured read suite plans locally but cannot run without runtime identity", async (t) => {
  const d = await dir(t),
    p = join(d, "c.json"),
    suite = join(d, "s.json");
  await writeFile(p, JSON.stringify(baseConfig()));
  await writeFile(
    suite,
    JSON.stringify({
      schemaVersion: 2,
      cases: [
        {
          id: "ops-read",
          chat: "private",
          prompt: "查询 ops_status 并回复 {{nonce}}",
          expectContains: ["{{nonce}}"],
          sideEffect: "none",
          leaseTools: [
            {
              name: "ops_status",
              operations: [
                { action: "ops:status", resourceId: "agent-operations", inputConstraint: {} },
              ],
            },
          ],
          featureAssertions: [
            {
              kind: "trace",
              type: "tool_result",
              where: { name: "ops_status", isError: false },
              count: 1,
            },
          ],
        },
      ],
    }),
  );
  const planned = await run(["plan", "--config", p, "--scenarios", suite], d);
  assert.equal(planned.code, 0, planned.stderr);
  assert.match(JSON.parse(planned.stdout).suiteSha256, /^[a-f0-9]{64}$/);
  const blocked = await run(["run", "--live", "--config", p, "--scenarios", suite], d);
  assert.equal(blocked.code, 2);
  assert.ok(blocked.stderr.includes("FEATURE_RUNTIME_REQUIRED"));
});
test("default feature inventory reports unimplemented executable coverage without credentials", async (t) => {
  const d = await dir(t),
    result = await run(["coverage"], d);
  assert.equal(result.code, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "BLOCKED");
  assert.ok(JSON.parse(result.stdout).gaps.some((g) => g.code === "CASE_NOT_EXECUTABLE"));
});
test("invalid configuration blocks before networking", async (t) => {
  const d = await dir(t);
  const p = join(d, "c.json");
  await writeFile(p, '{"schemaVersion":1}');
  assert.equal((await run(["doctor", "--config", p], d)).code, 2);
});
test("CLI performs three local-fixture round trips and writes report", async (t) => {
  const d = await dir(t);
  const w = await world();
  t.after(() => w.close());
  const p = join(d, "c.json"),
    out = join(d, "reports");
  await writeFile(p, JSON.stringify(w.config));
  const r = await run(["run", "--live", "--config", p, "--out", out], d);
  assert.equal(r.code, 3, r.stderr + r.stdout);
  const report = JSON.parse(await readFile(join(out, "latest.json")));
  assert.equal(report.cases.length, 3);
  assert.equal(report.productAcceptance.status, "BLOCKED");
  assert.ok(report.cases.every((c) => c.status === "PASS"));
  const events = await readFile(join(report.reportDirectory, "events.jsonl"), "utf8");
  assert.ok(!events.includes("fixture-token-only"));
});
test("STOP file blocks all outgoing messages", async (t) => {
  const d = await dir(t);
  const w = await world();
  t.after(() => w.close());
  const p = join(d, "c.json"),
    out = join(d, "reports");
  await writeFile(p, JSON.stringify(w.config));
  await mkdir(out);
  await writeFile(join(out, "STOP"), "stop");
  const r = await run(["run", "--live", "--config", p, "--out", out], d);
  assert.equal(r.code, 2);
  assert.equal(w.actions.length, 0);
});
test("missing --live is not silently accepted", async (t) => {
  const d = await dir(t);
  const p = join(d, "c.json");
  await writeFile(p, JSON.stringify(baseConfig()));
  const r = await run(["run", "--config", p], d);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("LIVE_REQUIRED"));
});
test("unknown case cannot produce an empty pass", async (t) => {
  const d = await dir(t);
  const p = join(d, "c.json");
  await writeFile(p, JSON.stringify(baseConfig()));
  const r = await run(["run", "--live", "--case", "unknown", "--config", p], d);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("CASE_NOT_FOUND"));
});
test("ambiguous moderation creates persistent safety STOP", async (t) => {
  const d = await dir(t);
  const w = await world({ mode: "pretend" });
  t.after(() => w.close());
  const p = join(d, "c.json"),
    out = join(d, "reports");
  await writeFile(p, JSON.stringify(w.config));
  const r = await run(["run", "--live", "--case", "moderation", "--config", p, "--out", out], d);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.ok((await readFile(join(out, "STOP"), "utf8")).includes("CLEANUP_UNCONFIRMED"));
});
