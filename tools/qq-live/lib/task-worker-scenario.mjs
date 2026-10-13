import { fail } from "./core.mjs";

export const TASK_WORKER_FAMILY_ID = "task-worker-artifact-lifecycle";
const NONCE = /^[a-f0-9]{32}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const STAGES = ["create", "delegate", "inspect", "accept"];
const FILE_PREFIX = "qq-live-worker-";

function invalid(code, message) {
  fail(code, message, "BLOCKED");
}

function checkNonce(value) {
  if (typeof value !== "string" || !NONCE.test(value))
    invalid("TASK_WORKER_NONCE", "Task Worker fixture needs a unique 32-character nonce.");
}

function checkTaskId(value) {
  if (typeof value !== "string" || !UUID.test(value))
    invalid(
      "TASK_WORKER_TASK_ID",
      "This Task Worker step needs an independently observed Task UUID.",
    );
}

function taskNames(nonce) {
  return {
    title: `qqtest-worker-${nonce}`,
    description: `Isolated QQ Worker acceptance fixture ${nonce}.`,
    criterion: `Write exactly ${FILE_PREFIX}${nonce}.txt with the exact content ${nonce} followed by one newline.`,
    filename: `${FILE_PREFIX}${nonce}.txt`,
  };
}

/** Build one fixed private Task Worker lifecycle step. No workspace is model-selectable. */
export function taskWorkerFixtureStep(stage, fixture = {}) {
  checkNonce(fixture.fixtureNonce);
  if (!STAGES.includes(stage)) invalid("TASK_WORKER_STAGE", "Task Worker stage is unsupported.");
  const nonce = fixture.fixtureNonce;
  const names = taskNames(nonce);
  let tools;
  let prompt;
  let sideEffect = "acceptance_fixture";

  if (stage === "create") {
    tools = [
      {
        name: "task_create",
        operations: [
          {
            action: "task:create",
            resourceId: "agent-operations",
            inputConstraint: {
              title: names.title,
              description: names.description,
              acceptanceCriteria: [names.criterion],
            },
          },
        ],
      },
    ];
    prompt = `仅创建一个 Task。标题必须是 ${names.title}，描述必须是 ${names.description}，验收标准必须是 ${JSON.stringify([names.criterion])}。不要委派 Worker 或规划其他步骤。回复本轮编号 {{nonce}}。`;
  } else {
    checkTaskId(fixture.taskId);
    const taskId = fixture.taskId;
    if (stage === "delegate") {
      const workerPrompt = `Use only the authorized worker_write_file operation to create exactly ${names.filename} in the fixed server-selected workspace. The entire file content must be ${nonce} followed by one newline. Do not use shell, network, or any other file operation. Do not select or change a workspace or path.`;
      tools = [
        {
          name: "task_delegate",
          operations: [
            {
              action: "task:delegate",
              resourceId: `task-${taskId}`,
              inputConstraint: { taskId, prompt: workerPrompt },
            },
          ],
        },
      ];
      prompt = `只委派 Task ${taskId}，Worker 指令必须逐字为：${workerPrompt} 回复本轮编号 {{nonce}}。`;
    } else if (stage === "inspect") {
      tools = [
        {
          name: "task_get",
          operations: [
            { action: "task:read", resourceId: `task-${taskId}`, inputConstraint: { taskId } },
          ],
        },
        {
          name: "worker_read",
          operations: [
            { action: "worker:read", resourceId: `task-${taskId}`, inputConstraint: { taskId } },
          ],
        },
      ];
      sideEffect = "none";
      prompt = `只检查 Task ${taskId} 和它绑定的 Worker。先读取 Task，再读取 Worker 状态。不得修改 Task、重新委派或操作其他资源。只有确认 Worker 已完成后回复本轮编号 {{nonce}}。`;
    } else {
      tools = [
        {
          name: "task_accept",
          operations: [
            {
              action: "task:accept",
              resourceId: `task-${taskId}`,
              inputConstraint: { taskId },
            },
          ],
        },
      ];
      prompt = `只在 Task ${taskId} 已处于 review 且验收文件已独立验证时接受它。不要重委派或操作其他 Task。回复本轮编号 {{nonce}}。`;
    }
  }

  const assertions = [];
  for (const tool of tools) {
    assertions.push({ kind: "trace", type: "tool_call", where: { name: tool.name }, count: 1 });
    assertions.push({
      kind: "trace",
      type: "tool_result",
      where: { name: tool.name, isError: false },
      count: 1,
    });
  }
  return {
    id: `task-worker-${stage}`,
    chat: "private",
    prompt,
    expectContains: ["{{nonce}}"],
    sideEffect,
    leaseTools: tools,
    featureAssertions: assertions,
  };
}

/** Fixed four-stage plan for displaying the Task Worker fixture workflow. */
export function taskWorkerFamilyPlan() {
  const nonce = "0".repeat(32);
  const taskId = "00000000-0000-4000-8000-000000000001";
  return {
    familyId: TASK_WORKER_FAMILY_ID,
    stages: STAGES.map((stage) => ({
      stage,
      spec: taskWorkerFixtureStep(stage, { fixtureNonce: nonce, taskId }),
    })),
    cleanup:
      "Retain the dedicated fixture Task, Attempt, Worker workspace and verified artifact; stop on unverified state.",
    coverage:
      "This fixed fixture verifies one delegated Worker file artifact, not general workspace or Worker capabilities.",
  };
}
