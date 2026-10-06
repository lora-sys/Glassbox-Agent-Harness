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

  for (const spec of specs) {
    const testCase = await executeCase(spec);
    cases.push(testCase);
    if (testCase.status !== "PASS") {
      if (
        Array.isArray(testCase.featureAssertions) &&
        (testCase.leaseRegistrationAttempted === true || testCase.sendAttempted === true)
      ) {
        if (
          testCase.status === "FAIL" &&
          testCase.code === "REPLY_ASSERTION_FAILED" &&
          verifyCleanupOnlyCase
        ) {
          try {
            const cleanup = await verifyCleanupOnlyCase(testCase);
            const receipt =
              cleanup?.status === "CLEANUP_VERIFIED" &&
              Array.isArray(cleanup.cases) &&
              cleanup.cases.length === 1 &&
              cleanup.cases[0]?.caseId === testCase.id &&
              cleanup.cases[0]?.cleanupVerified === true
                ? cleanup.cases[0]
                : undefined;
            if (receipt) {
              productAcceptance = {
                status: "FAIL",
                code: testCase.code,
                message: testCase.detail,
                cleanupRequired: true,
                cleanupVerified: true,
                cleanupOnly: receipt,
                runtime: cleanup.runtime,
                cases: productCases,
              };
              terminalStatus = "FAIL";
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
        const featureCase = Array.isArray(testCase.featureAssertions);
        const cleanupVerified = featureCase && error?.cleanupVerified === true;
        productAcceptance = {
          ...safe,
          cases: productCases,
          ...(featureCase ? { cleanupRequired: true, cleanupVerified } : {}),
        };
        if (featureCase && !cleanupVerified) cleanupStopRequired = true;
        terminalStatus = safe.status;
        break;
      }

      const evidence = verified?.cases?.length === 1 ? verified.cases[0] : undefined;
      const featureCase = Array.isArray(testCase.featureAssertions);
      if (
        verified?.status !== "PASS" ||
        !evidence ||
        (featureCase && evidence.cleanupVerified !== true)
      ) {
        const cleanupVerified = featureCase && evidence?.cleanupVerified === true;
        const failure = {
          status: "INCONCLUSIVE",
          code: featureCase ? "LEASE_CLEANUP_EVIDENCE" : "PRODUCT_EVIDENCE_INCOMPLETE",
          message: "单条用例的产品证据或独立清理回执不完整。",
          ...(featureCase ? { cleanupRequired: true, cleanupVerified } : {}),
          cases: productCases,
        };
        productAcceptance = failure;
        if (featureCase && !cleanupVerified) cleanupStopRequired = true;
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
