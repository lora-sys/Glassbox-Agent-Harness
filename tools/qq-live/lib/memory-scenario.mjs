import { fail } from "./core.mjs";

const TOOL = "owner_memory_admin";
export function memoryFixtureProject(nonce) {
  if (!/^[a-f0-9]{32}$/.test(nonce ?? ""))
    fail("MEMORY_FIXTURE_NONCE", "记忆测试需要唯一的 32 位本轮编号。");
  return `qqtest-${nonce}`;
}

/** Fixed acceptance messages only. IDs must be discovered with the independent fixture observer. */
export function memoryFixtureStep(stage, fixture) {
  const projectId = memoryFixtureProject(fixture?.nonce);
  let command, action, input;
  if (stage === "feedback") {
    const statement = `qqtest-${fixture.nonce}`;
    command = `/memory feedback project:${projectId} explicit_positive ${statement}`;
    action = "memory:write";
    input = {
      action: "feedback",
      scopeType: "project",
      projectId,
      signalType: "explicit_positive",
      statement,
    };
  } else if (["promote", "reject", "expire"].includes(stage)) {
    const kind = stage === "expire" ? "memory" : "candidate";
    const id = fixture[`${kind}Id`];
    if (!new RegExp(`^${kind}_[a-f0-9]{32}$`).test(id ?? ""))
      fail("MEMORY_FIXTURE_ID", "治理步骤需要独立核对的新测试资源 ID。");
    command = `/memory ${stage} ${id}`;
    action = "memory:govern";
    input = { action: stage, id };
  } else fail("MEMORY_FIXTURE_STAGE", "该记忆测试步骤未实现。");
  return {
    id: `memory-${stage}`,
    chat: "private",
    prompt: `${command}\n请在回复中包含本轮测试编号 {{nonce}}。`,
    expectContains: ["{{nonce}}"],
    sideEffect: "acceptance_fixture",
    leaseTools: [
      { name: TOOL, operations: [{ action, resourceId: "owner-memory", inputConstraint: input }] },
    ],
    featureAssertions: [
      { kind: "trace", type: "tool_result", where: { name: TOOL, isError: false }, count: 1 },
    ],
  };
}
