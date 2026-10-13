import test from "node:test";
import assert from "node:assert/strict";
import { verifyPreRunCleanupReport } from "../lib/pre-run-cleanup-report.mjs";

const runtime = { dataDirectory: "/fixture", pid: 1, connectionId: "fixture" };
const config = { runtime };
const caseRecord = { id: "qq-group-a-root-files-read" };
test("pre-Run cleanup report binds both runtime observations and preserves feature uncertainty", async () => {
  const result = await verifyPreRunCleanupReport({ runtime, cases: [caseRecord] }, config, {
    readRuntime: () => structuredClone(runtime),
    verifyCleanup: async () => ({
      status: "CLEANUP_VERIFIED",
      cleanupVerified: true,
      cleanupOnly: true,
      actualQqDeliveryVerified: false,
    }),
  });
  assert.equal(result.status, "CLEANUP_VERIFIED");
  assert.deepEqual(result.runtime, runtime);
  assert.equal(result.cases[0].actualQqDeliveryVerified, false);
});
test("pre-Run cleanup report rejects runtime drift before or after cleanup", async () => {
  for (const changedAt of [0, 1]) {
    let reads = 0;
    await assert.rejects(
      verifyPreRunCleanupReport({ runtime, cases: [caseRecord] }, config, {
        readRuntime: () => (reads++ === changedAt ? { ...runtime, pid: 2 } : runtime),
        verifyCleanup: async () => ({ status: "CLEANUP_VERIFIED", cleanupVerified: true }),
      }),
      { code: "RUNTIME_CHANGED", cleanupVerified: false },
    );
  }
});

test("sent no-ingress cleanup carries account readers and remains feature-inconclusive", async () => {
  const clients = { driver: {}, bot: {} };
  const result = await verifyPreRunCleanupReport(
    { runtime, cases: [{ id: "ops-status-read", code: "INPUT_NOT_OBSERVED" }] },
    config,
    {
      clients,
      readRuntime: () => structuredClone(runtime),
      verifyCleanup: async (input) => {
        assert.equal(input.clients, clients);
        return {
          status: "CLEANUP_RECONCILED",
          cleanupVerified: true,
          cleanupOnly: true,
          actualQqDeliveryVerified: true,
          productIngressVerified: false,
          productRunObserved: false,
          featureStatus: "INCONCLUSIVE",
        };
      },
    },
  );
  assert.equal(result.status, "CLEANUP_RECONCILED");
  assert.equal(result.cases[0].actualQqDeliveryVerified, true);
  assert.equal(result.cases[0].productIngressVerified, false);
  assert.equal(result.cases[0].productRunObserved, false);
  assert.equal(result.cases[0].featureStatus, "INCONCLUSIVE");
});
