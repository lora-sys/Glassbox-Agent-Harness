import test from "node:test";
import assert from "node:assert/strict";
import { runReadCaseSequence, productCleanupStopRequired } from "../lib/read-case-sequence.mjs";

const featureCase = (id, overrides = {}) => ({
  id,
  status: "PASS",
  featureAssertions: [{ kind: "trace" }],
  leaseRegistrationAttempted: true,
  sendAttempted: true,
  ...overrides,
});
const safeError = (error) => ({
  code: error.code ?? "INTERNAL_ERROR",
  status: error.status ?? "INCONCLUSIVE",
  message: error.message,
});

test("verifies each successful case before executing the next message", async () => {
  const order = [];
  const result = await runReadCaseSequence({
    specs: [{ id: "one" }, { id: "two" }],
    executeCase: async (spec) => {
      order.push(`send:${spec.id}`);
      return featureCase(spec.id);
    },
    verifyProductCase: async (row) => {
      order.push(`verify:${row.id}`);
      return {
        status: "PASS",
        runtime: { commit: "abc" },
        cases: [{ caseId: row.id, cleanupVerified: true }],
      };
    },
    delay: async () => order.push("gap"),
    serializeError: safeError,
  });

  assert.deepEqual(order, ["send:one", "verify:one", "gap", "send:two", "verify:two", "gap"]);
  assert.equal(result.productAcceptance.status, "PASS");
  assert.deepEqual(
    result.productAcceptance.cases.map((row) => row.caseId),
    ["one", "two"],
  );
  assert.equal(result.cleanupStopRequired, false);
});

test("stops before the next case and requests STOP when product verification cannot prove cleanup", async () => {
  const sent = [];
  const error = Object.assign(new Error("Run evidence missing"), {
    code: "RUN_EVIDENCE",
    status: "INCONCLUSIVE",
    cleanupVerified: false,
  });
  const result = await runReadCaseSequence({
    specs: [{ id: "one" }, { id: "must-not-send" }],
    executeCase: async (spec) => {
      sent.push(spec.id);
      return featureCase(spec.id);
    },
    verifyProductCase: async () => {
      throw error;
    },
    serializeError: safeError,
  });

  assert.deepEqual(sent, ["one"]);
  assert.equal(result.productAcceptance.code, "RUN_EVIDENCE");
  assert.equal(result.productAcceptance.cleanupVerified, false);
  assert.equal(result.cleanupStopRequired, true);
  assert.equal(productCleanupStopRequired(result.productAcceptance), true);
});

test("preserves a post-cleanup feature failure without treating it as unknown cleanup", async () => {
  const sent = [];
  const error = Object.assign(new Error("Independent read did not match."), {
    code: "GROUP_FILES_MISMATCH",
    status: "INCONCLUSIVE",
    cleanupVerified: true,
  });
  const result = await runReadCaseSequence({
    specs: [{ id: "one" }, { id: "must-not-send" }],
    executeCase: async (spec) => {
      sent.push(spec.id);
      return featureCase(spec.id);
    },
    verifyProductCase: async () => {
      throw error;
    },
    serializeError: (value) => ({ ...safeError(value), cleanupVerified: value.cleanupVerified }),
  });

  assert.deepEqual(sent, ["one"]);
  assert.equal(result.productAcceptance.code, "GROUP_FILES_MISMATCH");
  assert.equal(result.productAcceptance.status, "INCONCLUSIVE");
  assert.equal(result.productAcceptance.cleanupVerified, true);
  assert.equal(result.cleanupStopRequired, false);
});

test("a reply assertion failure with independently confirmed cleanup remains FAIL without STOP", async () => {
  const sent = [];
  const result = await runReadCaseSequence({
    specs: [{ id: "one" }, { id: "must-not-send" }],
    executeCase: async (spec) => {
      sent.push(spec.id);
      return featureCase(spec.id, {
        status: "FAIL",
        code: "REPLY_ASSERTION_FAILED",
        detail: "Expected reply did not match.",
      });
    },
    verifyCleanupOnlyCase: async () => ({
      status: "CLEANUP_VERIFIED",
      runtime: { commit: "abc" },
      cases: [{ caseId: "one", runId: "actual-run", cleanupVerified: true }],
    }),
    serializeError: safeError,
  });

  assert.deepEqual(sent, ["one"]);
  assert.equal(result.terminalStatus, "FAIL");
  assert.equal(result.productAcceptance.status, "FAIL");
  assert.equal(result.productAcceptance.code, "REPLY_ASSERTION_FAILED");
  assert.equal(result.productAcceptance.cleanupVerified, true);
  assert.deepEqual(result.productAcceptance.cleanupOnly, {
    caseId: "one",
    runId: "actual-run",
    cleanupVerified: true,
  });
  assert.equal(result.cleanupStopRequired, false);
  assert.equal(productCleanupStopRequired(result.productAcceptance), false);
});

test("unknown transport outcome stops after an attempted feature send", async () => {
  const sent = [];
  const result = await runReadCaseSequence({
    specs: [{ id: "one" }, { id: "must-not-send" }],
    executeCase: async (spec) => {
      sent.push(spec.id);
      return featureCase(spec.id, { status: "INCONCLUSIVE", code: "REPLY_TIMEOUT" });
    },
    verifyProductCase: async () => assert.fail("transport failure must not be product-verified"),
    serializeError: safeError,
  });

  assert.deepEqual(sent, ["one"]);
  assert.equal(result.terminalStatus, "INCONCLUSIVE");
  assert.equal(result.productAcceptance.code, "LEASE_CLEANUP_EVIDENCE");
  assert.equal(result.cleanupStopRequired, true);
});

test("non-feature failures do not claim lease cleanup is required", async () => {
  const result = await runReadCaseSequence({
    specs: [{ id: "ordinary" }],
    executeCase: async () => ({
      id: "ordinary",
      status: "FAIL",
      code: "REPLY_ASSERTION_FAILED",
      sendAttempted: true,
    }),
    verifyProductCase: async () => assert.fail("failed transport must not be product-verified"),
    serializeError: safeError,
  });

  assert.equal(result.cleanupStopRequired, false);
  assert.equal(productCleanupStopRequired(result.productAcceptance), false);
});
