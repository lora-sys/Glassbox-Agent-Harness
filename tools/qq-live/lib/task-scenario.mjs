import { fail } from "./core.mjs";

const NONCE = /^[a-f0-9]{32}$/;
const TASK_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function invalidNonce() {
  fail("TASK_FIXTURE_NONCE", "Task 测试需要唯一的 32 位本轮编号。", "BLOCKED");
}

function taskFixtureId(value) {
  if (!TASK_UUID.test(value ?? ""))
    fail("TASK_FIXTURE_ID", "该步骤需要独立观察到的 Task UUID。", "BLOCKED");
  return value;
}

/** Build a fixed Owner-private Task fixture step. This does not execute or observe the Run. */
export function taskFixtureStep(stage, fixture) {
  const nonce = fixture?.nonce;
  if (!NONCE.test(nonce ?? "")) invalidNonce();

  let id, prompt, tool, action, resourceId, inputConstraint;
  if (stage === "create") {
    const title = `qqtest-task-${nonce}`;
    const description = `Isolated QQ acceptance fixture ${nonce}.`;
    const acceptanceCriteria = [`Cancel only Task fixture ${nonce}.`];
    id = "task-fixture-create";
    tool = "task_create";
    action = "task:create";
    resourceId = "agent-operations";
    inputConstraint = { title, description, acceptanceCriteria };
    prompt = `仅创建一个 Task。标题必须是 ${title}，描述必须是 ${description}，验收标准必须是 ${JSON.stringify(acceptanceCriteria)}。不要规划步骤，不要委派 Worker。请回复本轮编号 {{nonce}}。`;
  } else if (stage === "inspect" || stage === "cancel") {
    const taskId = taskFixtureId(fixture?.taskId);
    id = stage === "inspect" ? "task-fixture-inspect" : "task-fixture-cancel";
    tool = stage === "inspect" ? "task_get" : "task_cancel";
    action = stage === "inspect" ? "task:read" : "task:cancel";
    resourceId = `task-${taskId}`;
    inputConstraint = { taskId };
    prompt =
      stage === "inspect"
        ? `只读取 Task ${taskId}，说明其状态和标题。不要更改它。请回复本轮编号 {{nonce}}。`
        : `只取消 Task ${taskId}。不要规划步骤或操作其他 Task。请回复本轮编号 {{nonce}}。`;
  } else {
    fail("TASK_FIXTURE_STAGE", "该 Task 测试步骤未实现。", "BLOCKED");
  }

  return {
    id,
    chat: "private",
    prompt,
    expectContains: ["{{nonce}}"],
    sideEffect: stage === "inspect" ? "none" : "acceptance_fixture",
    leaseTools: [
      {
        name: tool,
        operations: [{ action, resourceId, inputConstraint }],
      },
    ],
    featureAssertions: [
      { kind: "trace", type: "tool_call", where: { name: tool }, count: 1 },
      {
        kind: "trace",
        type: "tool_result",
        where: { name: tool, isError: false },
        count: 1,
      },
    ],
  };
}
