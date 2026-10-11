import assert from "node:assert/strict";
import test from "node:test";
import { taskWorkerFamilyPlan, taskWorkerFixtureStep } from "../lib/task-worker-scenario.mjs";

const nonce = "a".repeat(32);
const taskId = "12345678-1234-4234-9234-123456789abc";

test("Task Worker scenario fixes private create, delegate, inspect, and accept steps", () => {
  const plan = taskWorkerFamilyPlan();
  assert.deepEqual(
    plan.stages.map(({ stage }) => stage),
    ["create", "delegate", "inspect", "accept"],
  );
  const [create] = plan.stages.map(({ spec }) => spec);
  const delegate = taskWorkerFixtureStep("delegate", { fixtureNonce: nonce, taskId });
  const inspect = taskWorkerFixtureStep("inspect", { fixtureNonce: nonce, taskId });
  const accept = taskWorkerFixtureStep("accept", { fixtureNonce: nonce, taskId });
  assert.equal(create.chat, "private");
  assert.equal(create.leaseTools[0].name, "task_create");
  assert.equal(
    create.leaseTools[0].operations[0].inputConstraint.title,
    `qqtest-worker-${"0".repeat(32)}`,
  );
  assert.equal(delegate.leaseTools[0].name, "task_delegate");
  assert.equal(delegate.leaseTools[0].operations[0].inputConstraint.taskId, taskId);
  assert.match(delegate.prompt, /fixed server-selected workspace/u);
  assert.doesNotMatch(
    delegate.leaseTools[0].operations[0].inputConstraint.prompt,
    /workspaceId|workspace path/u,
  );
  assert.deepEqual(
    inspect.leaseTools.map(({ name }) => name),
    ["task_get", "worker_read"],
  );
  assert.equal(inspect.sideEffect, "none");
  assert.equal(accept.leaseTools[0].name, "task_accept");
});

test("Task Worker scenario rejects malformed stage, nonce, and task identity", () => {
  assert.throws(() => taskWorkerFixtureStep("create", { fixtureNonce: [] }));
  assert.throws(() => taskWorkerFixtureStep("other", { fixtureNonce: nonce }));
  assert.throws(() =>
    taskWorkerFixtureStep("delegate", { fixtureNonce: nonce, taskId: "not-a-task" }),
  );
});
