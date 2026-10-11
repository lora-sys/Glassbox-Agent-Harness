import { isDeepStrictEqual } from "node:util";
import { fail } from "./core.mjs";
import { MODERATION_FAMILY_ID, resolveModerationCli } from "./moderation-scenario.mjs";
import { createModerationCheckpoint } from "./moderation-checkpoint.mjs";
import { runModerationWorkflow } from "./moderation-workflow.mjs";
import { readModerationPolicyState } from "./moderation-state.mjs";
import {
  verifyModerationProductEvidence,
  verifyModerationStepEvidence,
} from "./moderation-product-evidence.mjs";
import { runtimeSnapshot } from "./product-evidence.mjs";

export function resolveModerationSelection({ command, caseId, config, approvedSuite } = {}) {
  return resolveModerationCli({ command, caseId, config, approvedSuite });
}

/** Called only after the shared CLI has acquired the account lock and connected observers. */
export async function runModerationCli({
  selection,
  config,
  clients,
  recorder,
  acceptance,
  signal,
  pendingPath,
  reportDirectory,
  reportRuntime,
  driverSha256,
  processIdentity,
  dependencies = {},
} = {}) {
  const reviewed = resolveModerationCli({
    command: "run",
    caseId: MODERATION_FAMILY_ID,
    config,
    approvedSuite: selection?.suiteSha256,
  });
  if (
    !selection ||
    !isDeepStrictEqual(
      Object.keys(selection).sort(),
      ["familyId", "groupId", "mode", "plan", "suiteSha256", "target"].sort(),
    ) ||
    !isDeepStrictEqual(selection, reviewed) ||
    selection.mode !== "run" ||
    !clients?.driver ||
    !clients?.bot ||
    !recorder ||
    !acceptance ||
    typeof pendingPath !== "string" ||
    typeof reportDirectory !== "string" ||
    !reportRuntime
  )
    fail("MODERATION_CLI", "禁言流程身份或审阅计划与当前配置不一致。", "INCONCLUSIVE");

  const checkpoint = await (dependencies.createCheckpoint ?? createModerationCheckpoint)({
    pendingPath,
    reportDirectory,
    runtime: reportRuntime,
    suiteSha256: selection.suiteSha256,
    driverSha256,
    processIdentity,
  });
  const result = await (dependencies.runWorkflow ?? runModerationWorkflow)({
    config,
    clients,
    recorder,
    acceptance,
    signal,
    expectedRuntime: reportRuntime,
    readRuntime: () => (dependencies.runtimeSnapshot ?? runtimeSnapshot)(config.runtime),
    readPolicyState: () => (dependencies.readPolicyState ?? readModerationPolicyState)(config),
    checkpoint: (row) =>
      checkpoint.write({ familyId: MODERATION_FAMILY_ID, runtime: reportRuntime, ...row }),
    verifyStep: (context) =>
      (dependencies.verifyStep ?? verifyModerationStepEvidence)({
        ...context,
        config,
        clients,
        expectedRuntime: reportRuntime,
        policyState: context.policyState,
      }),
    send: dependencies.replyCase,
  });
  let productAcceptance = {
    status: "INCONCLUSIVE",
    familyId: MODERATION_FAMILY_ID,
    runtime: reportRuntime,
    cleanupRequired: true,
    cleanupVerified: false,
    cases: [],
  };
  if (result.status === "MODERATION_WORKFLOW_VERIFIED") {
    try {
      productAcceptance = await (
        dependencies.verifyProductEvidence ?? verifyModerationProductEvidence
      )({
        cases: recorder.cases.filter((row) => row.moderation === true),
        config,
        clients,
        expectedRuntime: reportRuntime,
        policyState: result.policyState,
      });
      productAcceptance.cleanupRequired = true;
    } catch {
      result.status = "INCONCLUSIVE";
      result.requiresReconciliation = true;
      result.cleanupVerified = false;
      result.actualQqDeliveryVerified = false;
      result.error = { code: "MODERATION_PRODUCT_EVIDENCE", message: "禁言产品证据复核未通过。" };
    }
  }
  return {
    result,
    productAcceptance,
    checkpoint,
    complete: ({ reportPath, connectionsDrained, recheck }) =>
      checkpoint.complete({ result, reportPath, connectionsDrained, recheck }),
  };
}
