import test from "node:test";
import assert from "node:assert/strict";
import { shouldCreateSafetyStop } from "../cli.mjs";
const caseRecord = {
  id: "qq-group-a-root-files-read",
  status: "BLOCKED",
  code: "API_REJECTED",
  token: "a".repeat(32),
  startedAt: "2026-10-06T10:00:00.000Z",
  featureAssertions: [],
  leaseRegistrationAttempted: true,
  leaseRegistered: true,
  leaseRevoked: true,
  sendAttempted: true,
  acceptanceLease: {
    leaseId: "11111111-1111-4111-8111-111111111111",
    toolsSha256: "b".repeat(64),
    expiresAt: Date.parse("2026-10-06T10:10:00.000Z"),
  },
};
const report = {
  status: "BLOCKED",
  cases: [caseRecord],
  productAcceptance: {
    status: "BLOCKED",
    code: "PRE_RUN_CLEANUP_ONLY",
    cleanupRequired: true,
    cleanupVerified: true,
    cleanupOnly: {
      caseId: caseRecord.id,
      leaseId: caseRecord.acceptanceLease.leaseId,
      marker: caseRecord.token,
      toolsSha256: caseRecord.acceptanceLease.toolsSha256,
      cleanupVerified: true,
      cleanupOnly: true,
      actualQqDeliveryVerified: false,
      featureStatus: "INCONCLUSIVE",
      zeroMarkedMessages: true,
      zeroMarkedRuns: true,
    },
  },
};
test("STOP remains unless the exact pre-Run cleanup receipt proves zero marked input", () => {
  assert.equal(shouldCreateSafetyStop(report), false);
  for (const mutate of [
    (r) => delete r.productAcceptance.cleanupOnly,
    (r) => (r.productAcceptance.cleanupOnly.marker = "c".repeat(32)),
    (r) => (r.productAcceptance.cleanupOnly.zeroMarkedRuns = false),
    (r) => (r.productAcceptance.cleanupOnly.actualQqDeliveryVerified = true),
  ]) {
    const changed = structuredClone(report);
    mutate(changed);
    assert.equal(shouldCreateSafetyStop(changed), true);
  }
});
