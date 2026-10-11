import { digest, fail } from "./core.mjs";
import { isDeepStrictEqual } from "node:util";
import { groupPolicyFixtureConfig } from "./group-policy-config.mjs";
import {
  GROUP_MEMBERS_POLICY_FAMILY_ID,
  groupMembersPolicyPlan,
} from "./group-members-policy-scenario.mjs";
import { readGroupMembersPolicyState } from "./group-members-policy-state.mjs";
import { createGroupMembersPolicyCheckpoint } from "./group-members-policy-checkpoint.mjs";
import { runGroupMembersPolicyWorkflow } from "./group-members-policy-workflow.mjs";
import { verifyGroupMembersPolicyStep } from "./group-members-policy-step-verifier.mjs";
import { runtimeSnapshot } from "./product-evidence.mjs";
import { replyCase } from "./runner.mjs";

function planFor(config) {
  const fixture = groupPolicyFixtureConfig(config);
  const groupA = config.groups.find((group) => group.alias === "A");
  const groupB = config.groups.find((group) => group.alias === "B");
  const runtime = config.runtime;
  const bindings = {
    actors: { ownerId: config.driver.qq, botId: config.bot.qq, principalKind: "owner" },
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
  const plan = { ...groupMembersPolicyPlan(fixture.groupId), bindings };
  return { fixture, plan, suiteSha256: digest(JSON.stringify(plan)) };
}

export function resolveGroupMembersPolicyCli({ command, caseId, config, approvedSuite } = {}) {
  const { fixture, plan, suiteSha256 } = planFor(config);
  if (command === "plan") {
    if (caseId && caseId !== GROUP_MEMBERS_POLICY_FAMILY_ID)
      fail("GROUP_MEMBERS_POLICY_CASE", "群成员权限只支持固定的群 B 隔离用例。");
    return { mode: "plan", familyId: GROUP_MEMBERS_POLICY_FAMILY_ID, suiteSha256, ...plan };
  }
  if (command !== "run" || caseId !== GROUP_MEMBERS_POLICY_FAMILY_ID)
    fail("GROUP_MEMBERS_POLICY_CASE", "群成员权限实机运行必须选择固定用例。");
  if (!config?.runtime)
    fail("GROUP_MEMBERS_POLICY_RUNTIME", "群成员权限实机运行必须核对服务版本。");
  if (!Number.isSafeInteger(config.maxMessages) || config.maxMessages < 3)
    fail("MESSAGE_BUDGET", "群成员权限流程需要三条消息预算。");
  if (approvedSuite !== suiteSha256)
    fail("SUITE_APPROVAL", "请先审阅固定群成员权限流程并提供 plan 输出的 SHA256。");
  return {
    mode: "run",
    familyId: GROUP_MEMBERS_POLICY_FAMILY_ID,
    groupId: fixture.groupId,
    suiteSha256,
    plan,
  };
}

export async function runGroupMembersPolicyCli({
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
      ? resolveGroupMembersPolicyCli({
          command: "run",
          caseId: GROUP_MEMBERS_POLICY_FAMILY_ID,
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
    !isDeepStrictEqual(selection, reviewed) ||
    selection.groupId !== config?.groupPolicyFixtures?.groupId ||
    !clients?.driver ||
    !clients?.bot ||
    !recorder ||
    !acceptance ||
    typeof pendingPath !== "string" ||
    typeof reportDirectory !== "string" ||
    !reportRuntime
  )
    fail("GROUP_MEMBERS_POLICY_CLI", "群成员权限执行上下文或计划身份无效。", "INCONCLUSIVE");

  const createCheckpoint = dependencies.createCheckpoint ?? createGroupMembersPolicyCheckpoint;
  const executeWorkflow = dependencies.runWorkflow ?? runGroupMembersPolicyWorkflow;
  const readState = dependencies.readState ?? readGroupMembersPolicyState;
  const readRuntime = dependencies.runtimeSnapshot ?? runtimeSnapshot;
  const verifyStep = dependencies.verifyStep ?? verifyGroupMembersPolicyStep;
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
        { ...context, config, clients, expectedRuntime: reportRuntime },
        dependencies.stepVerifierDependencies,
      ),
    signal,
  });
  return {
    result,
    baseline,
    checkpoint,
    complete: ({ reportPath, connectionsDrained, recheck }) =>
      checkpoint.complete({ result, reportPath, connectionsDrained, recheck }),
  };
}
