import { digest, fail } from "./core.mjs";
import { isDeepStrictEqual } from "node:util";
import { groupPolicyFixtureConfig } from "./group-policy-config.mjs";
import { GROUP_POLICY_FAMILY_ID, groupPolicyPlan } from "./group-policy-scenario.mjs";
import { readGroupPolicyState } from "./group-policy-state.mjs";
import { createGroupPolicyCheckpoint } from "./group-policy-checkpoint.mjs";
import { runGroupPolicyWorkflow } from "./group-policy-workflow.mjs";
import {
  verifyGroupPolicyHistoryStep,
  verifyGroupPolicyStep,
} from "./group-policy-step-verifier.mjs";
import { runtimeSnapshot } from "./product-evidence.mjs";
import { replyCase } from "./runner.mjs";

function planFor(config) {
  const fixture = groupPolicyFixtureConfig(config);
  const groupA = config.groups.find((group) => group.alias === "A");
  const groupB = config.groups.find((group) => group.alias === "B");
  const runtime = config.runtime;
  const bindings = {
    actors: {
      ownerId: config.driver.qq,
      botId: config.bot.qq,
      principalKind: "owner",
    },
    scope: {
      connectionId: runtime.connectionId,
      botId: config.bot.qq,
      chatType: "private",
      chatId: config.driver.qq,
      senderId: config.driver.qq,
      threadId: runtime.threadId ?? null,
    },
    groups: { A: groupA.id, B: groupB.id },
    runtime: {
      checkout: runtime.checkout,
      dataDirectory: runtime.dataDirectory,
      expectedCommit: runtime.expectedCommit,
      ...(runtime.expectedSourceTreeSha256 === undefined
        ? {}
        : { expectedSourceTreeSha256: runtime.expectedSourceTreeSha256 }),
      connectionId: runtime.connectionId,
      threadId: runtime.threadId ?? null,
    },
  };
  const plan = { ...groupPolicyPlan(fixture.groupId), bindings };
  return {
    fixture,
    plan,
    suiteSha256: digest(JSON.stringify(plan)),
  };
}

/** Resolve the fixed group-B plan or validate its reviewed live invocation. */
export function resolveGroupPolicyCli({ command, caseId, config, approvedSuite } = {}) {
  const { fixture, plan, suiteSha256 } = planFor(config);
  if (command === "plan") {
    if (caseId && caseId !== GROUP_POLICY_FAMILY_ID)
      fail("GROUP_POLICY_CASE", "群策略只支持固定的群策略隔离用例。");
    return {
      mode: "plan",
      familyId: GROUP_POLICY_FAMILY_ID,
      suiteSha256,
      ...plan,
    };
  }
  if (command !== "run" || caseId !== GROUP_POLICY_FAMILY_ID)
    fail("GROUP_POLICY_CASE", "群策略实机运行必须选择固定的群策略隔离用例。");
  if (!config?.runtime) fail("GROUP_POLICY_RUNTIME", "群策略实机运行必须核对验收服务版本。");
  if (!Number.isSafeInteger(config.maxMessages) || config.maxMessages < 3)
    fail("MESSAGE_BUDGET", "群策略流程需要三条消息预算。");
  if (approvedSuite !== suiteSha256)
    fail("SUITE_APPROVAL", "请先审阅固定群策略流程并提供 plan 输出的 SHA256。");
  return {
    mode: "run",
    familyId: GROUP_POLICY_FAMILY_ID,
    groupId: fixture.groupId,
    suiteSha256,
    plan,
  };
}

/**
 * Execute the fixed three-message flow under the CLI's already-held account lock.
 * The caller owns report persistence, drained-connection confirmation, and guard completion.
 */
export async function runGroupPolicyCli({
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
  const reviewed =
    selection?.mode === "run"
      ? resolveGroupPolicyCli({
          command: "run",
          caseId: GROUP_POLICY_FAMILY_ID,
          config,
          approvedSuite: selection.suiteSha256,
        })
      : null;
  if (
    !reviewed ||
    !isDeepStrictEqual(
      Object.keys(selection).sort(),
      ["familyId", "groupId", "mode", "plan", "suiteSha256"].sort(),
    ) ||
    selection?.mode !== "run" ||
    selection.familyId !== GROUP_POLICY_FAMILY_ID ||
    !isDeepStrictEqual(selection, { ...reviewed, plan: reviewed.plan }) ||
    !isDeepStrictEqual(selection.plan, reviewed.plan) ||
    selection.groupId !== config?.groupPolicyFixtures?.groupId ||
    !clients?.driver ||
    !clients?.bot ||
    !recorder ||
    !acceptance ||
    typeof pendingPath !== "string" ||
    typeof reportDirectory !== "string" ||
    !reportRuntime
  )
    fail("GROUP_POLICY_CLI", "群策略执行上下文或计划身份无效。", "INCONCLUSIVE");

  const createCheckpoint = dependencies.createCheckpoint ?? createGroupPolicyCheckpoint;
  const executeWorkflow = dependencies.runWorkflow ?? runGroupPolicyWorkflow;
  const readState = dependencies.readState ?? readGroupPolicyState;
  const readRuntime = dependencies.runtimeSnapshot ?? runtimeSnapshot;
  const verifyStep =
    dependencies.verifyStep ??
    ((context, verifierDependencies) =>
      context.stage === "history-check"
        ? verifyGroupPolicyHistoryStep(context, verifierDependencies)
        : verifyGroupPolicyStep(context, verifierDependencies));
  let baseline;
  const checkpoint = await createCheckpoint({
    pendingPath,
    reportDirectory,
    runtime: reportRuntime,
    suiteSha256: selection.suiteSha256,
    driverSha256,
    processIdentity,
  });
  const result = await executeWorkflow({
    groupId: selection.groupId,
    captureState: (options) => readState(config, options),
    readRuntime: () => readRuntime(config.runtime),
    checkpoint: (row) => {
      baseline ??= structuredClone(row.baseline);
      return checkpoint.write(row);
    },
    executeStep: async (stage, spec, hooks) => {
      const transportCase = await (dependencies.replyCase ?? replyCase)(
        config,
        clients,
        recorder,
        spec,
        signal,
        { ...acceptance, ...hooks },
      );
      return { transportCase };
    },
    verifyStep: (context) =>
      verifyStep(
        {
          ...context,
          config,
          clients,
          expectedRuntime: reportRuntime,
        },
        dependencies.stepVerifierDependencies,
      ),
    signal,
  });
  return {
    result,
    baseline,
    checkpoint,
    complete: ({ reportPath, connectionsDrained, recheck }) =>
      checkpoint.complete({
        result,
        reportPath,
        connectionsDrained,
        recheck,
      }),
  };
}
