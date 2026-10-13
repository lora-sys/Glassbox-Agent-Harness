import test from "node:test";
import assert from "node:assert/strict";
import { LiveError } from "../lib/core.mjs";
import { applyCloseDrainFailure } from "../cli.mjs";

test("close failure blocks acceptance while preserving per-case cleanup proof", () => {
  const report = {
    status: "PASS",
    transportOnly: true,
    transportStatus: "PASS",
    cases: [{ sendAttempted: true }],
    productAcceptance: {
      status: "TRANSPORT_ONLY",
      acceptanceKind: "TRANSPORT_ONLY",
      cleanupVerified: true,
      cases: [{ status: "PASS", cleanupVerified: true }],
    },
  };

  applyCloseDrainFailure(
    report,
    new LiveError("WS_CLOSE_UNCONFIRMED", "OneBot close was not confirmed.", "INCONCLUSIVE"),
  );

  assert.equal(report.status, "INCONCLUSIVE");
  assert.equal(report.productAcceptance.status, "INCONCLUSIVE");
  assert.equal(report.productAcceptance.code, "WS_CLOSE_UNCONFIRMED");
  assert.equal(report.transportStatus, "INCONCLUSIVE");
  assert.equal(report.cleanupStopRequired, true);
  assert.equal(report.productAcceptance.cleanupVerified, true);
  assert.deepEqual(report.productAcceptance.cases, [{ status: "PASS", cleanupVerified: true }]);
});

test("close failure does not overwrite an earlier case failure or request STOP before sends", () => {
  const report = {
    status: "FAIL",
    cases: [],
    productAcceptance: { status: "FAIL", code: "REPLY_ASSERTION_FAILED" },
  };

  applyCloseDrainFailure(
    report,
    new LiveError("WS_CLOSE_TIMEOUT", "OneBot close confirmation timed out.", "INCONCLUSIVE"),
  );

  assert.equal(report.status, "FAIL");
  assert.equal(report.productAcceptance.status, "FAIL");
  assert.equal(report.productAcceptance.code, "REPLY_ASSERTION_FAILED");
  assert.equal(report.cleanupStopRequired, undefined);
  assert.equal(report.connectionClose.code, "WS_CLOSE_TIMEOUT");
});
