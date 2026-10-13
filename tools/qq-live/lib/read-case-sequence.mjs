import { isFixedPreRunReadCase } from "./pre-run-cleanup-cases.mjs";

export async function runReadCaseSequence({
  specs,
  executeCase,
  verifyProductCase,
  verifyCleanupOnlyCase,
  delay,
  serializeError,
}) {
  const cases = [];
  const productCases = [];
  let productAcceptance = { status: "BLOCKED", code: "NOT_CHECKED", cases: productCases };
  let cleanupStopRequired = false;
  let terminalStatus;
  const requiresLease = (testCase) =>
    testCase?.transportOnly === true || Array.isArray(testCase?.featureAssertions);
  const validPreRunCase = (testCase) => {
    const lease = testCase?.acceptanceLease;
    const startedAt =
      typeof testCase?.startedAt === "string" ? Date.parse(testCase.startedAt) : NaN;
    return (
      isFixedPreRunReadCase(testCase?.id) &&
      testCase.status === "BLOCKED" &&
      testCase.code === "API_REJECTED" &&
      Array.isArray(testCase.featureAssertions) &&
      testCase.leaseRegistrationAttempted === true &&
      testCase.leaseRevoked === true &&
      testCase.sendAttempted === true &&
      !Object.hasOwn(testCase, "sentMessageId") &&
      !Object.hasOwn(testCase, "inputBinding") &&
      typeof testCase.token === "string" &&
      /^[a-f0-9]{32}$/u.test(testCase.token) &&
      lease &&
      Object.keys(lease).sort().join(",") === "expiresAt,leaseId,toolsSha256" &&
      typeof lease.leaseId === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
        lease.leaseId,
      ) &&
      Number.isFinite(startedAt) &&
      Number.isSafeInteger(lease.expiresAt) &&
      lease.expiresAt > startedAt &&
      typeof lease.toolsSha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(lease.toolsSha256)
    );
  };
  const fixedPreRunCandidate = validPreRunCase;
  const preRunReceipt = (cleanup, testCase) => {
    const receipt =
      Array.isArray(cleanup?.cases) && cleanup.cases.length === 1 ? cleanup.cases[0] : undefined;
    const lease = testCase.acceptanceLease;
    if (
      cleanup?.status !== "CLEANUP_VERIFIED" ||
      !receipt ||
      receipt.caseId !== testCase.id ||
      receipt.leaseId !== lease?.leaseId ||
      receipt.marker !== testCase.token ||
      receipt.toolsSha256 !== lease?.toolsSha256 ||
      receipt.cleanupVerified !== true ||
      receipt.cleanupOnly !== true ||
      receipt.actualQqDeliveryVerified !== false ||
      receipt.featureStatus !== "INCONCLUSIVE" ||
      receipt.zeroMarkedMessages !== true ||
      receipt.zeroMarkedRuns !== true ||
      Object.hasOwn(receipt, "runId")
    )
      return undefined;
    return {
      caseId: receipt.caseId,
      leaseId: receipt.leaseId,
      marker: receipt.marker,
      toolsSha256: receipt.toolsSha256,
      cleanupVerified: true,
      cleanupOnly: true,
      actualQqDeliveryVerified: false,
      featureStatus: "INCONCLUSIVE",
      zeroMarkedMessages: true,
      zeroMarkedRuns: true,
    };
  };

  for (const spec of specs) {
    const testCase = await executeCase(spec);
    cases.push(testCase);
    if (testCase.status !== "PASS") {
      if (fixedPreRunCandidate(testCase)) {
        try {
          if (typeof verifyCleanupOnlyCase !== "function")
            throw new Error("cleanup verifier unavailable");
          const cleanup = await verifyCleanupOnlyCase(testCase);
          const receipt = preRunReceipt(cleanup, testCase);
          if (!receipt) throw new Error("pre-Run cleanup receipt is incomplete");
          productAcceptance = {
            status: "BLOCKED",
            code: "PRE_RUN_CLEANUP_ONLY",
            message: "许可已清理，但拒绝发生在 Run 创建前，未验证任何产品功能。",
            cleanupRequired: true,
            cleanupVerified: true,
            cleanupOnly: receipt,
            cases: productCases,
          };
          terminalStatus = "BLOCKED";
        } catch {
          cleanupStopRequired = true;
          productAcceptance = {
            status: "INCONCLUSIVE",
            code: "PRE_RUN_CLEANUP_EVIDENCE",
            message: "预运行许可清理未通过独立证据核验，必须停止并调查。",
            cleanupRequired: true,
            cleanupVerified: false,
            cases: productCases,
          };
          terminalStatus = "INCONCLUSIVE";
        }
        break;
      }
      if (
        requiresLease(testCase) &&
        (testCase.leaseRegistrationAttempted === true || testCase.sendAttempted === true)
      ) {
        const fixedAccountStatusTimeout =
          testCase.id === "qq-account-status-read" &&
          testCase.status === "INCONCLUSIVE" &&
          testCase.code === "REPLY_TIMEOUT";
        if (
          ((testCase.status === "FAIL" && testCase.code === "REPLY_ASSERTION_FAILED") ||
            fixedAccountStatusTimeout) &&
          verifyCleanupOnlyCase
        ) {
          try {
            const cleanup = await verifyCleanupOnlyCase(testCase);
            const timeoutReceiptValid =
              !fixedAccountStatusTimeout ||
              (cleanup?.cases?.[0]?.cleanupOnly === true &&
                cleanup.cases[0]?.actualQqDeliveryVerified === false &&
                cleanup.cases[0]?.persistedDeliveryStatus === "sent");
            const receipt =
              cleanup?.status === "CLEANUP_VERIFIED" &&
              Array.isArray(cleanup.cases) &&
              cleanup.cases.length === 1 &&
              cleanup.cases[0]?.caseId === testCase.id &&
              cleanup.cases[0]?.cleanupVerified === true &&
              timeoutReceiptValid
                ? cleanup.cases[0]
                : undefined;
            if (receipt) {
              productAcceptance = {
                status: fixedAccountStatusTimeout ? "INCONCLUSIVE" : "FAIL",
                code: testCase.code,
                message: testCase.detail,
                cleanupRequired: true,
                cleanupVerified: true,
                cleanupOnly: receipt,
                runtime: cleanup.runtime,
                cases: productCases,
              };
              terminalStatus = testCase.status;
              break;
            }
            throw Object.assign(new Error("Independent cleanup proof was incomplete."), {
              code: "LEASE_CLEANUP_EVIDENCE",
              status: "INCONCLUSIVE",
              cleanupVerified: false,
            });
          } catch (error) {
            const safe = serializeError(error);
            const cleanupVerified = error?.cleanupVerified === true;
            cleanupStopRequired = !cleanupVerified;
            productAcceptance = {
              ...safe,
              cleanupRequired: true,
              cleanupVerified,
              cases: productCases,
            };
            terminalStatus = cleanupVerified ? testCase.status : "INCONCLUSIVE";
            break;
          }
        }
        cleanupStopRequired = true;
        productAcceptance = {
          status: "INCONCLUSIVE",
          code: "LEASE_CLEANUP_EVIDENCE",
          message: "本轮功能用例未完成独立清理核验，必须先核实原 Run 和许可审计。",
          cleanupRequired: true,
          cleanupVerified: false,
          cases: productCases,
        };
        terminalStatus = "INCONCLUSIVE";
      } else if (verifyProductCase) {
        productAcceptance = {
          ...productAcceptance,
          status: testCase.status,
          code: testCase.code,
          message: testCase.detail,
          cases: productCases,
        };
        terminalStatus = testCase.status;
      }
      break;
    }

    if (verifyProductCase) {
      let verified;
      try {
        verified = await verifyProductCase(testCase);
      } catch (error) {
        const safe = serializeError(error);
        const leaseCase = requiresLease(testCase);
        const cleanupVerified = leaseCase && error?.cleanupVerified === true;
        productAcceptance = {
          ...safe,
          cases: productCases,
          ...(leaseCase ? { cleanupRequired: true, cleanupVerified } : {}),
        };
        if (leaseCase && !cleanupVerified) cleanupStopRequired = true;
        terminalStatus = safe.status;
        break;
      }

      const evidence = verified?.cases?.length === 1 ? verified.cases[0] : undefined;
      const leaseCase = requiresLease(testCase);
      if (
        verified?.status !== "PASS" ||
        !evidence ||
        (leaseCase && evidence.cleanupVerified !== true)
      ) {
        const cleanupVerified = leaseCase && evidence?.cleanupVerified === true;
        const failure = {
          status: "INCONCLUSIVE",
          code: leaseCase ? "LEASE_CLEANUP_EVIDENCE" : "PRODUCT_EVIDENCE_INCOMPLETE",
          message: "单条用例的产品证据或独立清理回执不完整。",
          ...(leaseCase ? { cleanupRequired: true, cleanupVerified } : {}),
          cases: productCases,
        };
        productAcceptance = failure;
        if (leaseCase && !cleanupVerified) cleanupStopRequired = true;
        terminalStatus = failure.status;
        break;
      }

      productCases.push(evidence);
      productAcceptance = {
        status: "PASS",
        runtime: verified.runtime,
        cases: productCases,
      };
    }

    if (delay) await delay();
  }

  return { cases, productAcceptance, cleanupStopRequired, terminalStatus };
}

export function productCleanupStopRequired(productAcceptance) {
  return productAcceptance?.cleanupRequired === true && productAcceptance.cleanupVerified !== true;
}

/** A verified read-only cleanup receipt never changes the original timeout result. */
export function fixedReadTimeoutCleanupConfirmed(productAcceptance, testCase) {
  const receipt = productAcceptance?.cleanupOnly;
  return (
    testCase?.id === "qq-account-status-read" &&
    testCase.status === "INCONCLUSIVE" &&
    testCase.code === "REPLY_TIMEOUT" &&
    productAcceptance?.status === "INCONCLUSIVE" &&
    productAcceptance.code === "REPLY_TIMEOUT" &&
    productAcceptance.cleanupRequired === true &&
    productAcceptance.cleanupVerified === true &&
    receipt?.caseId === testCase.id &&
    receipt.cleanupVerified === true &&
    receipt.cleanupOnly === true &&
    receipt.actualQqDeliveryVerified === false &&
    receipt.persistedDeliveryStatus === "sent" &&
    typeof receipt.runId === "string" &&
    receipt.runId.length > 0
  );
}

/** Confirm only the fixed no-Run cleanup receipt; this never means the feature passed. */
export function fixedPreRunCleanupConfirmed(productAcceptance, testCase) {
  const receipt = productAcceptance?.cleanupOnly;
  const lease = testCase?.acceptanceLease;
  const expectedReceiptKeys = [
    "caseId",
    "leaseId",
    "marker",
    "toolsSha256",
    "cleanupVerified",
    "cleanupOnly",
    "actualQqDeliveryVerified",
    "featureStatus",
    "zeroMarkedMessages",
    "zeroMarkedRuns",
  ];
  const receiptKeys =
    receipt && typeof receipt === "object" && !Array.isArray(receipt)
      ? Object.keys(receipt).sort()
      : [];
  const expectedKeys = [...expectedReceiptKeys].sort();
  return (
    isFixedPreRunReadCase(testCase?.id) &&
    testCase.status === "BLOCKED" &&
    testCase.code === "API_REJECTED" &&
    testCase.leaseRegistrationAttempted === true &&
    testCase.leaseRevoked === true &&
    testCase.sendAttempted === true &&
    Array.isArray(testCase.featureAssertions) &&
    !Object.hasOwn(testCase, "sentMessageId") &&
    !Object.hasOwn(testCase, "inputBinding") &&
    typeof testCase.token === "string" &&
    /^[a-f0-9]{32}$/u.test(testCase.token) &&
    lease &&
    typeof lease.leaseId === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(lease.leaseId) &&
    Number.isSafeInteger(lease.expiresAt) &&
    Number.isFinite(Date.parse(testCase.startedAt ?? "")) &&
    lease.expiresAt > Date.parse(testCase.startedAt) &&
    typeof lease.toolsSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(lease.toolsSha256) &&
    productAcceptance?.status === "BLOCKED" &&
    productAcceptance.code === "PRE_RUN_CLEANUP_ONLY" &&
    productAcceptance.cleanupRequired === true &&
    productAcceptance.cleanupVerified === true &&
    receiptKeys.length === expectedKeys.length &&
    receiptKeys.every((key, index) => key === expectedKeys[index]) &&
    receipt?.caseId === testCase.id &&
    receipt.leaseId === lease.leaseId &&
    receipt.marker === testCase.token &&
    receipt.toolsSha256 === lease.toolsSha256 &&
    receipt.cleanupVerified === true &&
    receipt.cleanupOnly === true &&
    receipt.actualQqDeliveryVerified === false &&
    receipt.featureStatus === "INCONCLUSIVE" &&
    receipt.zeroMarkedMessages === true &&
    receipt.zeroMarkedRuns === true &&
    !Object.hasOwn(receipt, "runId")
  );
}
