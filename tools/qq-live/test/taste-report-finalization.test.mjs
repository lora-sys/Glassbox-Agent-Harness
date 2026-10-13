import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  finalizeTasteFamilyAcceptance,
  tasteFixtureCheckpointRemovable,
} from "../lib/taste-report-finalization.mjs";

const TASTE_FAMILY_ID = "taste-project-feedback-lifecycle";

test("Taste verifier sees a PASS candidate but a thrown final proof leaves the persisted report INCONCLUSIVE", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "taste-finalize-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = {
    status: "BLOCKED",
    runtime: { pid: 77 },
    productAcceptance: { status: "BLOCKED" },
    tasteLifecycle: { status: "PASS", requiresReconciliation: false },
  };
  const pendingPath = join(directory, "taste-pending.json");
  await writeFile(pendingPath, "pending-checkpoint\n");
  await assert.rejects(
    finalizeTasteFamilyAcceptance(report, async (candidate) => {
      assert.equal(candidate.status, "PASS");
      assert.equal(candidate.productAcceptance.status, "PASS");
      throw Object.assign(new Error("final state changed"), { status: "INCONCLUSIVE" });
    }),
  );
  assert.equal(report.status, "INCONCLUSIVE");
  assert.equal(report.productAcceptance.status, "INCONCLUSIVE");
  assert.equal(tasteFixtureCheckpointRemovable(report), false);
  await writeFile(join(directory, "report.json"), JSON.stringify(report));
  assert.equal(
    JSON.parse(await readFile(join(directory, "report.json"), "utf8")).status,
    "INCONCLUSIVE",
  );
  assert.equal(await readFile(pendingPath, "utf8"), "pending-checkpoint\n");
});

test("Taste checkpoint becomes removable only after final family PASS", async () => {
  const report = {
    status: "BLOCKED",
    runtime: { pid: 77 },
    tasteLifecycle: { status: "PASS", requiresReconciliation: false },
  };
  const acceptance = await finalizeTasteFamilyAcceptance(report, async (candidate) => {
    assert.equal(candidate.status, "PASS");
    return {
      status: "PASS",
      familyId: TASTE_FAMILY_ID,
      runtime: candidate.runtime,
      stageRunIds: ["one"],
    };
  });
  assert.equal(acceptance.status, "PASS");
  assert.equal(report.status, "PASS");
  assert.equal(report.productAcceptance.status, "PASS");
  assert.equal(tasteFixtureCheckpointRemovable(report), true);
});
