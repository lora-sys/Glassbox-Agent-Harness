import test from "node:test";
import assert from "node:assert/strict";
import { taskFixtureStep } from "../lib/task-scenario.mjs";

const nonce = "a".repeat(32);
const taskId = "123e4567-e89b-42d3-a456-426614174000";

test("create is private and permits one exact nonce-named Task without delegation", () => {
  const spec = taskFixtureStep("create", { nonce });
  assert.equal(spec.chat, "private");
  assert.deepEqual(spec.leaseTools, [
    {
      name: "task_create",
      operations: [
        {
          action: "task:create",
          resourceId: "agent-operations",
          inputConstraint: {
            title: `qqtest-task-${nonce}`,
            description: `Isolated QQ acceptance fixture ${nonce}.`,
            acceptanceCriteria: [`Cancel only Task fixture ${nonce}.`],
          },
        },
      ],
    },
  ]);
  assert.match(spec.prompt, /不要规划步骤，不要委派 Worker/u);
  assert.deepEqual(spec.expectContains, ["{{nonce}}"]);
  assert.deepEqual(spec.featureAssertions, [
    { kind: "trace", type: "tool_call", where: { name: "task_create" }, count: 1 },
    {
      kind: "trace",
      type: "tool_result",
      where: { name: "task_create", isError: false },
      count: 1,
    },
  ]);
});

test("inspect and cancel bind only an independently observed Task UUID", () => {
  const inspect = taskFixtureStep("inspect", { nonce, taskId });
  const cancel = taskFixtureStep("cancel", { nonce, taskId });
  assert.deepEqual(inspect.leaseTools, [
    {
      name: "task_get",
      operations: [
        {
          action: "task:read",
          resourceId: `task-${taskId}`,
          inputConstraint: { taskId },
        },
      ],
    },
  ]);
  assert.deepEqual(cancel.leaseTools, [
    {
      name: "task_cancel",
      operations: [
        {
          action: "task:cancel",
          resourceId: `task-${taskId}`,
          inputConstraint: { taskId },
        },
      ],
    },
  ]);
  assert.equal(inspect.sideEffect, "none");
  assert.match(cancel.prompt, new RegExp(taskId, "u"));
});

test("invalid stage, nonce, or Task handle fail before a case can be built", () => {
  for (const invalidNonce of [undefined, "", "a".repeat(31), "A".repeat(32), `${nonce}\nextra`])
    assert.throws(() => taskFixtureStep("create", { nonce: invalidNonce }));

  for (const invalidTaskId of [undefined, "legacy-task", taskId.toUpperCase(), `${taskId}/other`]) {
    assert.throws(() => taskFixtureStep("inspect", { nonce, taskId: invalidTaskId }));
    assert.throws(() => taskFixtureStep("cancel", { nonce, taskId: invalidTaskId }));
  }
  assert.throws(() => taskFixtureStep("task_plan", { nonce }));
});
