import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readDeliveryJson,
  validateReportManifest,
  runDeliveryCli,
  readDeliveryRemoteEvidence,
  assertNoPendingAcceptanceFixtures,
} from "../lib/delivery-cli.mjs";
import { baseConfig } from "./fixture.mjs";
import { digest } from "../lib/core.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "qq-delivery-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("delivery checks both account-wide fixture anchors again before merge", async (t) => {
  const directory = await fixture(t);
  const account = "a".repeat(24);
  await assertNoPendingAcceptanceFixtures(directory, account);
  for (const [kind, code] of [
    ["memory", "MEMORY_FIXTURE_PENDING"],
    ["taste", "TASTE_FIXTURE_PENDING"],
  ]) {
    const path = join(directory, `${account}.${kind}-pending.json`);
    await writeFile(path, "{}");
    await assert.rejects(assertNoPendingAcceptanceFixtures(directory, account), { code });
    await rm(path);
    await assertNoPendingAcceptanceFixtures(directory, account);
    await mkdir(path);
    await assert.rejects(assertNoPendingAcceptanceFixtures(directory, account), { code });
    await rm(path, { recursive: true });
  }
});

test("post-merge evidence uses the adapter's merged checks contract instead of candidate checks", async () => {
  const commit = "b".repeat(40);
  const candidate = "a".repeat(40);
  const merged = {
    commit,
    checks: [{ name: "merged-job", commit, status: "SUCCESS" }],
    requiredCheckNames: ["merged-job"],
  };
  const remote = {
    headCommit: candidate,
    state: "MERGED",
    mergeCommit: commit,
    checks: [{ name: "candidate-job", commit: candidate }],
    requiredCheckNames: ["candidate-job"],
  };
  const github = {
    readRemote: async () => remote,
    readMergedChecks: async (expected) => {
      assert.equal(expected, commit);
      return merged;
    },
  };
  assert.deepEqual(await readDeliveryRemoteEvidence(github, candidate), remote);
  const evidence = await readDeliveryRemoteEvidence(github, commit, true);
  assert.deepEqual(evidence.checks, merged.checks);
  assert.deepEqual(evidence.requiredCheckNames, merged.requiredCheckNames);
  assert.equal(evidence.headCommit, candidate);
  assert.equal(evidence.mergeCommit, commit);
  assert.equal(evidence.checksCommit, commit);
  for (const invalid of [
    { ...merged, commit: candidate },
    { ...merged, requiredCheckNames: undefined },
  ]) {
    github.readMergedChecks = async () => invalid;
    await assert.rejects(readDeliveryRemoteEvidence(github, commit, true), {
      code: "POST_MERGE_CI",
    });
  }
});

test("delivery report manifest is bounded and cannot contain judgments or duplicate paths", () => {
  assert.deepEqual(validateReportManifest({ schemaVersion: 1, reports: ["one/report.json"] }), [
    "one/report.json",
  ]);
  for (const invalid of [
    null,
    [],
    { schemaVersion: 1, reports: [] },
    { schemaVersion: 1, reports: ["a", "a"] },
    { schemaVersion: 1, reports: [4] },
    { schemaVersion: 1, reports: ["a"], review: { status: "PASS" } },
    { schemaVersion: 1, reports: Array.from({ length: 101 }, (_, n) => `${n}`) },
  ])
    assert.throws(
      () => validateReportManifest(invalid),
      (error) => error.code === "DELIVERY_MANIFEST",
    );
});

test("delivery JSON rejects oversized, malformed and non-file evidence", async (t) => {
  const directory = await fixture(t);
  const path = join(directory, "report.json");
  await writeFile(path, '{"status":"PASS"}');
  assert.deepEqual(await readDeliveryJson(path), { status: "PASS" });
  await assert.rejects(readDeliveryJson(path, 3), (error) => error.code === "DELIVERY_FILE");
  await writeFile(path, "malformed");
  await assert.rejects(readDeliveryJson(path), (error) => error.code === "DELIVERY_FILE");
  await assert.rejects(readDeliveryJson(directory), (error) => error.code === "DELIVERY_FILE");
});

test("delivery refuses incomplete baseline before reports, output, validation or GitHub access", async (t) => {
  const directory = await fixture(t);
  const suitePath = join(directory, "suite.json");
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
  await writeFile(suitePath, suiteText);
  const out = join(directory, "out");
  await assert.rejects(
    runDeliveryCli(
      { ...baseConfig(), runtime: {} },
      {
        pr: "https://github.com/example/repo/pull/1",
        scenarios: suitePath,
        reports: join(directory, "nonexistent.json"),
        "approve-suite": digest(suiteText),
      },
      out,
    ),
    (error) => error.code === "COVERAGE_GATE",
  );
  await mkdir(out);
});

test("delivery refuses missing arguments and changed suite approval", async (t) => {
  const directory = await fixture(t);
  await assert.rejects(
    runDeliveryCli(baseConfig(), {}, directory),
    (error) => error.code === "DELIVERY_ARGUMENT",
  );
  const path = join(directory, "suite.json");
  await writeFile(path, "{}");
  await assert.rejects(
    runDeliveryCli(
      { ...baseConfig(), runtime: {} },
      {
        pr: "https://github.com/example/repo/pull/1",
        scenarios: path,
        reports: "missing",
        "approve-suite": "0".repeat(64),
      },
      directory,
    ),
    (error) => error.code === "SUITE_APPROVAL",
  );
});
