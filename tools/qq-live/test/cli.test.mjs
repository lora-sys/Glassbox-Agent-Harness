import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { world, baseConfig } from "./fixture.mjs";
import { digest } from "../lib/core.mjs";
const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));

test("lesson registration rejects execution flags before reading configuration or sending", async (t) => {
  const d = await dir(t);
  for (const options of [
    [],
    ["--input", "lesson.json", "--live"],
    ["--input", "lesson.json", "--case", "group-A"],
    ["--input", "lesson.json", "--pr", "https://example.invalid/pr"],
  ]) {
    const result = await run(["record-lesson", ...options], d);
    assert.notEqual(result.code, 0);
    assert.ok(result.stderr.includes("ARGUMENT"));
  }
  const input = join(d, "invalid-lesson.json");
  await writeFile(input, '{"private":"do-not-expose-this-value"');
  const invalid = await run(["record-lesson", "--input", input], d);
  assert.notEqual(invalid.code, 0);
  assert.ok(!`${invalid.stdout}${invalid.stderr}`.includes("do-not-expose-this-value"));
});
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
test("delivery commands reject missing inputs and implicit merge before network access", async (t) => {
  const d = await dir(t);
  const configPath = join(d, "config.json");
  const out = join(d, "reports");
  await writeFile(configPath, JSON.stringify({ ...baseConfig(), runtime: {} }));
  const checked = await run(["delivery-check", "--config", configPath, "--out", out], d);
  assert.equal(checked.code, 2);
  assert.ok(checked.stderr.includes("DELIVERY_ARGUMENT"));
  const merged = await run(["deliver", "--config", configPath, "--out", out], d);
  assert.equal(merged.code, 2);
  assert.ok(merged.stderr.includes("LIVE_REQUIRED"));
  await assert.rejects(stat(out), { code: "ENOENT" });
});

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

test("reconcile-memory is a named command and requires enabled isolated fixture configuration", async (t) => {
  const d = await dir(t);
  const p = join(d, "c.json");
  await writeFile(p, JSON.stringify(baseConfig()));
  const result = await run(["reconcile-memory", "--config", p], d);
  assert.equal(result.code, 2);
  assert.match(result.stderr + result.stdout, /MEMORY_FIXTURE_DISABLED/);
  assert.doesNotMatch(result.stderr + result.stdout, /未知命令/);
  const helpResult = await run(["help"], d);
  assert.match(helpResult.stdout, /reconcile-memory --live --approve-suite/);
});
test("fixed Memory lifecycle plan exposes all steps without enabling writes", async (t) => {
  const d = await dir(t),
    p = join(d, "c.json");
  await writeFile(p, JSON.stringify(baseConfig()));
  const r = await run(["plan", "--case", "memory-lifecycle", "--config", p], d);
  assert.equal(r.code, 0);
  const plan = JSON.parse(r.stdout);
  assert.deepEqual(
    plan.stages.map((s) => s.stage),
    ["feedback", "promote", "expire"],
  );
  assert.ok(plan.stages[0].spec.prompt.includes("qqtest-{{fixture_nonce}}"));
  assert.ok(plan.stages[1].spec.prompt.includes("{{candidate_id}}"));
  assert.ok(plan.stages[2].spec.prompt.includes("{{memory_id}}"));
  assert.match(plan.suiteSha256, /^[a-f0-9]{64}$/);
  const blocked = await run(
    [
      "run",
      "--live",
      "--case",
      "memory-lifecycle",
      "--config",
      p,
      "--approve-suite",
      plan.suiteSha256,
    ],
    d,
  );
  assert.equal(blocked.code, 2);
  assert.ok(blocked.stderr.includes("FEATURE_RUNTIME_REQUIRED"));
});
test("Memory fixture writes require explicit enablement before networking", async (t) => {
  const d = await dir(t),
    p = join(d, "c.json");
  await writeFile(p, JSON.stringify({ ...baseConfig(), runtime: {} }));
  const r = await run(["run", "--live", "--case", "memory-lifecycle", "--config", p], d);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("MEMORY_FIXTURE_DISABLED"));
});
test("fixed Memory lifecycle rejects changed approval, insufficient budget, and custom suites", async (t) => {
  const d = await dir(t),
    p = join(d, "c.json"),
    suite = join(d, "s.json");
  const config = {
    ...baseConfig(),
    runtime: {},
    memoryFixtures: { enabled: true, retainAuditConfirmed: true },
  };
  await writeFile(p, JSON.stringify(config));
  await writeFile(suite, "{}");
  const approved = JSON.parse(
    (await run(["plan", "--case", "memory-lifecycle", "--config", p], d)).stdout,
  ).suiteSha256;
  const wrong = await run(
    [
      "run",
      "--live",
      "--case",
      "memory-lifecycle",
      "--config",
      p,
      "--approve-suite",
      "0".repeat(64),
    ],
    d,
  );
  assert.equal(wrong.code, 2);
  assert.ok(wrong.stderr.includes("SUITE_APPROVAL"));
  await writeFile(p, JSON.stringify({ ...config, maxMessages: 2 }));
  const budget = await run(
    ["run", "--live", "--case", "memory-lifecycle", "--config", p, "--approve-suite", approved],
    d,
  );
  assert.equal(budget.code, 2);
  assert.ok(budget.stderr.includes("MESSAGE_BUDGET"));
  const mixed = await run(
    ["plan", "--case", "memory-lifecycle", "--config", p, "--scenarios", suite],
    d,
  );
  assert.equal(mixed.code, 2);
  assert.ok(mixed.stderr.includes("ARGUMENT"));
});
test("pending Memory fixtures block the account even with another report directory", async (t) => {
  const d = await dir(t),
    w = await world();
  t.after(() => w.close());
  const p = join(d, "c.json"),
    locks = join(d, ".glassbox-qq-live-locks");
  await writeFile(p, JSON.stringify(w.config));
  const suiteSha256 = JSON.parse((await run(["plan", "--config", p], d)).stdout).suiteSha256;
  await writeFile(p, JSON.stringify({ ...w.config, runtime: {} }));
  await mkdir(locks);
  const pending = join(locks, digest(w.config.driver.qq).slice(0, 24) + ".memory-pending.json");
  await writeFile(pending, "{}");
  const r = await run(
    [
      "run",
      "--live",
      "--approve-suite",
      suiteSha256,
      "--config",
      p,
      "--out",
      join(d, "different-reports"),
    ],
    d,
  );
  assert.equal(r.code, 2);
  assert.ok(
    JSON.parse(await readFile(join(d, "different-reports", "latest.json"), "utf8")).error.code ===
      "MEMORY_RECONCILIATION_REQUIRED",
  );
  assert.equal(w.actions.length, 0);
  assert.equal(await readFile(pending, "utf8"), "{}");
});
test("default sends are blocked without runtime and identity-bound zero-tool approval", async (t) => {
  const d = await dir(t),
    w = await world();
  t.after(() => w.close());
  const p = join(d, "c.json"),
    out = join(d, "reports");
  await writeFile(p, JSON.stringify(w.config));
  const blocked = await run(["run", "--live", "--config", p, "--out", out], d);
  assert.equal(blocked.code, 2);
  assert.match(blocked.stderr, /TRANSPORT_RUNTIME_REQUIRED/);
  assert.equal(w.actions.length, 0);
  await writeFile(p, JSON.stringify({ ...w.config, runtime: {} }));
  const unapproved = await run(
    ["run", "--live", "--approve-suite", "0".repeat(64), "--config", p, "--out", out],
    d,
  );
  assert.equal(unapproved.code, 2);
  assert.match(unapproved.stderr, /SUITE_APPROVAL/);
  assert.equal(w.actions.length, 0);
});
test("transport suite rejects partial route selection before networking", async (t) => {
  const d = await dir(t);
  const w = await world();
  t.after(() => w.close());
  const p = join(d, "c.json"),
    out = join(d, "reports");
  await writeFile(p, JSON.stringify(w.config));
  for (const route of ["private", "group-A", "group-B"]) {
    const result = await run(["run", "--live", "--case", route, "--config", p, "--out", out], d);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /TRANSPORT_SUITE_FIXED/);
  }
  assert.equal(w.driver.authCount, 0);
  assert.equal(w.bot.authCount, 0);
  await assert.rejects(stat(out), { code: "ENOENT" });
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

test("schema 3 Memory family hashes original suite bytes and plans without network access", async (t) => {
  const d = await dir(t);
  const configPath = join(d, "c.json");
  const suitePath = join(d, "memory-suite.json");
  const suiteText = `{
  "schemaVersion": 3,
  "cases": [
    {
      "id": "memory-project-promote-expire",
      "kind": "memory-lifecycle",
      "workflow": "promote-expire",
      "chat": "private"
    }
  ]
}
`;
  await writeFile(configPath, JSON.stringify(baseConfig()));
  await writeFile(suitePath, suiteText);

  const planResult = await run(
    ["plan", "--config", configPath, "--scenarios", suitePath, "--out", join(d, "plan-out")],
    d,
  );
  assert.equal(planResult.code, 0);
  const plan = JSON.parse(planResult.stdout);
  assert.equal(plan.suiteSha256, digest(suiteText));
  assert.deepEqual(plan.cases, [
    {
      id: "memory-project-promote-expire",
      kind: "memory-lifecycle",
      workflow: "promote-expire",
      chat: "private",
    },
  ]);
  assert.deepEqual(
    plan.memoryPlan.stages.map((stage) => stage.stage),
    ["feedback", "promote", "expire"],
  );
});

test("schema 3 plans both fixed Memory families with original suite approval", async (t) => {
  const d = await dir(t);
  const configPath = join(d, "c.json");
  const suitePath = join(d, "families.json");
  const suiteText = JSON.stringify({
    schemaVersion: 3,
    cases: [
      {
        id: "memory-project-promote-expire",
        kind: "memory-lifecycle",
        workflow: "promote-expire",
        chat: "private",
      },
      {
        id: "memory-project-feedback-reject",
        kind: "memory-lifecycle",
        workflow: "feedback-reject",
        chat: "private",
      },
    ],
  });
  await writeFile(configPath, JSON.stringify(baseConfig()));
  await writeFile(suitePath, suiteText);
  const result = await run(["plan", "--config", configPath, "--scenarios", suitePath], d);
  assert.equal(result.code, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.suiteSha256, digest(suiteText));
  assert.deepEqual(
    plan.memoryPlans.map(({ plan }) => plan.stages.map(({ stage }) => stage)),
    [
      ["feedback", "promote", "expire"],
      ["feedback", "reject"],
    ],
  );
});

test("schema 3 reject family blocks a one-message budget before network", async (t) => {
  const d = await dir(t);
  const configPath = join(d, "c.json");
  const suitePath = join(d, "reject.json");
  const suiteText = JSON.stringify({
    schemaVersion: 3,
    cases: [
      {
        id: "memory-project-feedback-reject",
        kind: "memory-lifecycle",
        workflow: "feedback-reject",
        chat: "private",
      },
    ],
  });
  await writeFile(
    configPath,
    JSON.stringify({
      ...baseConfig(),
      runtime: {},
      maxMessages: 1,
      memoryFixtures: { enabled: true, retainAuditConfirmed: true },
    }),
  );
  await writeFile(suitePath, suiteText);
  const out = join(d, "out");
  const result = await run(
    [
      "run",
      "--live",
      "--config",
      configPath,
      "--scenarios",
      suitePath,
      "--case",
      "memory-project-feedback-reject",
      "--approve-suite",
      digest(suiteText),
      "--out",
      out,
    ],
    d,
  );
  assert.equal(result.code, 2);
  assert.match(result.stderr + result.stdout, /MESSAGE_BUDGET/);
  await assert.rejects(stat(out), { code: "ENOENT" });
});

test("schema 3 Memory run rejects missing case, approval, fixture enablement and message budget before network", async (t) => {
  const d = await dir(t);
  const configPath = join(d, "c.json");
  const suitePath = join(d, "memory-suite.json");
  const out = join(d, "run-out");
  const suiteText = JSON.stringify({
    schemaVersion: 3,
    cases: [
      {
        id: "memory-project-promote-expire",
        kind: "memory-lifecycle",
        workflow: "promote-expire",
        chat: "private",
      },
    ],
  });
  const suiteSha256 = digest(suiteText);
  const config = {
    ...baseConfig(),
    runtime: {},
    memoryFixtures: { enabled: true, retainAuditConfirmed: true },
  };
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(suitePath, suiteText);
  const common = ["run", "--live", "--config", configPath, "--scenarios", suitePath, "--out", out];

  const missingCase = await run([...common, "--approve-suite", suiteSha256], d);
  assert.equal(missingCase.code, 2);
  assert.match(missingCase.stderr + missingCase.stdout, /CASE_FAMILY_REQUIRED/);

  const chosen = [...common, "--case", "memory-project-promote-expire"];
  const wrongApproval = await run([...chosen, "--approve-suite", "0".repeat(64)], d);
  assert.equal(wrongApproval.code, 2);
  assert.match(wrongApproval.stderr + wrongApproval.stdout, /SUITE_APPROVAL/);

  await writeFile(
    configPath,
    JSON.stringify({ ...config, memoryFixtures: { enabled: false, retainAuditConfirmed: true } }),
  );
  const disabled = await run([...chosen, "--approve-suite", suiteSha256], d);
  assert.equal(disabled.code, 2);
  assert.match(disabled.stderr + disabled.stdout, /MEMORY_FIXTURE_DISABLED/);

  await writeFile(configPath, JSON.stringify({ ...config, maxMessages: 2 }));
  const insufficientBudget = await run([...chosen, "--approve-suite", suiteSha256], d);
  assert.equal(insufficientBudget.code, 2);
  assert.match(insufficientBudget.stderr + insufficientBudget.stdout, /MESSAGE_BUDGET/);

  await assert.rejects(stat(out), { code: "ENOENT" });
});

test("schema 3 Memory plan rejects custom family fields before network access", async (t) => {
  const d = await dir(t);
  const configPath = join(d, "c.json");
  const suitePath = join(d, "memory-suite.json");
  await writeFile(configPath, JSON.stringify(baseConfig()));
  await writeFile(
    suitePath,
    JSON.stringify({
      schemaVersion: 3,
      cases: [
        {
          id: "memory-project-promote-expire",
          kind: "memory-lifecycle",
          workflow: "promote-expire",
          chat: "private",
          prompt: "custom command {{nonce}}",
        },
      ],
    }),
  );
  const out = join(d, "invalid-out");
  const result = await run(
    ["plan", "--config", configPath, "--scenarios", suitePath, "--out", out],
    d,
  );
  assert.equal(result.code, 2);
  assert.match(result.stderr + result.stdout, /FEATURE_MEMORY_FAMILY/);
  await assert.rejects(stat(out), { code: "ENOENT" });
});
test("default feature inventory reports unimplemented executable coverage without credentials", async (t) => {
  const d = await dir(t),
    result = await run(["coverage"], d);
  assert.equal(result.code, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "BLOCKED");
  assert.ok(JSON.parse(result.stdout).gaps.some((g) => g.code === "CASE_NOT_EXECUTABLE"));
});
test("history plan resolves the configured group but approves the original suite bytes", async (t) => {
  const d = await dir(t),
    configPath = join(d, "c.json"),
    suitePath = join(d, "s.json");
  await writeFile(configPath, JSON.stringify(baseConfig()));
  const suiteText = JSON.stringify({
    schemaVersion: 2,
    cases: [
      {
        id: "history-test",
        chat: "A",
        prompt: "Search group_history_search for {{nonce}} with limit 1",
        expectContains: ["{{nonce}}"],
        sideEffect: "none",
        leaseTools: [
          {
            name: "group_history_search",
            operations: [
              {
                action: "history:read",
                resourceId: "group:{{group:A}}",
                inputConstraint: { query: "{{nonce}}", limit: 1 },
              },
            ],
          },
        ],
        featureAssertions: [
          {
            kind: "trace",
            type: "tool_result",
            where: { name: "group_history_search", isError: false },
            count: 1,
          },
          {
            kind: "trace",
            type: "history_retrieval",
            where: {
              query: "{{nonce}}",
              groups: ["{{group:A}}"],
              resources: ["group:{{group:A}}"],
              sourceKind: "channel_message",
              retrievalMode: "lexical",
            },
            count: 1,
          },
        ],
      },
    ],
  });
  await writeFile(suitePath, suiteText);
  const planned = await run(["plan", "--config", configPath, "--scenarios", suitePath], d);
  assert.equal(planned.code, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  assert.equal(plan.suiteSha256, digest(suiteText));
  assert.equal(plan.cases[0].leaseTools[0].operations[0].resourceId, "group:20001");
  assert.deepEqual(plan.cases[0].featureAssertions[1].where.groups, ["20001"]);
  assert.equal(plan.cases[0].featureAssertions[1].where.query, "{{nonce}}");
});
test("invalid configuration blocks before networking", async (t) => {
  const d = await dir(t);
  const p = join(d, "c.json");
  await writeFile(p, '{"schemaVersion":1}');
  assert.equal((await run(["doctor", "--config", p], d)).code, 2);
});
test("transport plan fixes the three zero-tool cases and binds identities into approval", async (t) => {
  const d = await dir(t);
  const p = join(d, "c.json");
  const config = baseConfig();
  await writeFile(p, JSON.stringify(config));
  const planned = await run(["plan", "--case", "transport-smoke", "--config", p], d);
  assert.equal(planned.code, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  assert.equal(plan.transportOnly, true);
  assert.equal(plan.familyId, "qq-transport-smoke");
  assert.deepEqual(
    plan.cases.map((c) => [c.id, c.chat, c.leaseTools]),
    [
      ["transport-private", "private", []],
      ["transport-group-A", "A", []],
      ["transport-group-B", "B", []],
    ],
  );
  assert.match(plan.suiteSha256, /^[a-f0-9]{64}$/);

  const changed = { ...config, groups: [config.groups[0], { ...config.groups[1], id: "20009" }] };
  await writeFile(p, JSON.stringify(changed));
  const replanned = await run(["plan", "--config", p], d);
  assert.notEqual(JSON.parse(replanned.stdout).suiteSha256, plan.suiteSha256);
});

test("transport run rejects missing runtime and approval before creating output or connecting", async (t) => {
  const d = await dir(t);
  const w = await world();
  t.after(() => w.close());
  const p = join(d, "c.json"),
    out = join(d, "reports");
  await writeFile(p, JSON.stringify(w.config));
  const noRuntime = await run(["run", "--live", "--config", p, "--out", out], d);
  assert.equal(noRuntime.code, 2);
  assert.match(noRuntime.stderr, /TRANSPORT_RUNTIME_REQUIRED/);
  await assert.rejects(stat(out), { code: "ENOENT" });
  assert.equal(w.driver.authCount, 0);
  assert.equal(w.bot.authCount, 0);

  const plan = JSON.parse((await run(["plan", "--config", p], d)).stdout);
  await writeFile(p, JSON.stringify({ ...w.config, runtime: {} }));
  const noApproval = await run(["run", "--live", "--config", p, "--out", out], d);
  assert.equal(noApproval.code, 2);
  assert.match(noApproval.stderr, /SUITE_APPROVAL/);
  await assert.rejects(stat(out), { code: "ENOENT" });
  assert.equal(w.driver.authCount, 0);
  assert.equal(w.bot.authCount, 0);

  const missingRuntime = await run(
    ["run", "--live", "--approve-suite", plan.suiteSha256, "--config", p, "--out", out],
    d,
  );
  assert.equal(missingRuntime.code, 2);
  const blockedReport = JSON.parse(await readFile(join(out, "latest.json"), "utf8"));
  assert.equal(blockedReport.error.code, "RUNTIME_CONFIG");
  assert.equal(w.driver.authCount, 0);
  assert.equal(w.bot.authCount, 0);
});
test("STOP file blocks all outgoing messages", async (t) => {
  const d = await dir(t);
  const w = await world();
  t.after(() => w.close());
  const p = join(d, "c.json"),
    out = join(d, "reports");
  await writeFile(p, JSON.stringify(w.config));
  const suiteSha256 = JSON.parse((await run(["plan", "--config", p], d)).stdout).suiteSha256;
  await writeFile(p, JSON.stringify({ ...w.config, runtime: {} }));
  await mkdir(out);
  await writeFile(join(out, "STOP"), "stop");
  const r = await run(
    ["run", "--live", "--approve-suite", suiteSha256, "--config", p, "--out", out],
    d,
  );
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
test("moderation live command is blocked before creating files or connecting", async (t) => {
  const d = await dir(t);
  const w = await world({ mode: "pretend" });
  t.after(() => w.close());
  const p = join(d, "c.json"),
    out = join(d, "reports");
  await writeFile(p, JSON.stringify(w.config));
  const r = await run(["run", "--live", "--case", "moderation", "--config", p, "--out", out], d);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /MODERATION_LEASE_UNSUPPORTED/);
  await assert.rejects(stat(out), { code: "ENOENT" });
  assert.equal(w.driver.authCount, 0);
  assert.equal(w.bot.authCount, 0);
});

test("history family plan exposes fixed seed and evidence-derived recall without network", async (t) => {
  const d = await dir(t),
    p = join(d, "config.json"),
    suite = join(d, "history-suite.json");
  await writeFile(p, JSON.stringify(baseConfig()));
  await writeFile(
    suite,
    JSON.stringify({
      schemaVersion: 4,
      cases: [{ id: "history-group-seed-private-recall", kind: "history-seed", chat: "A" }],
    }),
  );
  const r = await run(["plan", "--config", p, "--scenarios", suite], d);
  assert.equal(r.code, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.deepEqual(
    plan.historyPlan.stages.map((s) => s.stage),
    ["seed", "recall"],
  );
  assert.equal(plan.historyPlan.stages[0].spec.chat, "A");
  assert.match(plan.historyPlan.stages[1].note, /verified seed/);
  assert.match(plan.suiteSha256, /^[a-f0-9]{64}$/);
});

test("isolation family plan exposes B seed and A-only exclusion without network", async (t) => {
  const d = await dir(t),
    p = join(d, "config.json"),
    suite = join(d, "isolation-suite.json");
  await writeFile(p, JSON.stringify(baseConfig()));
  await writeFile(
    suite,
    JSON.stringify({
      schemaVersion: 5,
      cases: [{ id: "history-cross-group-isolation", kind: "history-isolation", chat: "B" }],
    }),
  );
  const r = await run(["plan", "--config", p, "--scenarios", suite], d);
  assert.equal(r.code, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.deepEqual(
    plan.historyIsolationPlan.stages.map((s) => s.stage),
    ["seed", "exclusion"],
  );
  assert.equal(plan.historyIsolationPlan.stages[0].spec.chat, "B");
  assert.match(plan.historyIsolationPlan.stages[1].note, /group A/);
  assert.match(plan.suiteSha256, /^[a-f0-9]{64}$/);
  const unselected = await run(["run", "--live", "--config", p, "--scenarios", suite], d);
  assert.equal(unselected.code, 2);
  assert.match(unselected.stdout + unselected.stderr, /CASE_FAMILY_REQUIRED/);
});
