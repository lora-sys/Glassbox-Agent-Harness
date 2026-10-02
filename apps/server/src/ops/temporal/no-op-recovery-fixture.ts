import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import type { TaskStep } from "@glassbox/contracts";
import type { CallerContext } from "../../identity/scope.js";
import { openDomainStore } from "../../application/domain-store.js";
import { DEFAULT_TASK_GRAPH_LIMITS } from "../task-graph.js";
import { createAdvanceLongWorkActivity } from "./activity.js";

export const noOpRecoveryFixtureScript = new URL(import.meta.url);

async function runFixture() {
  const caller: CallerContext = {
    principalId: "owner",
    scope: {
      connectionId: "test",
      botId: "bot",
      chatType: "private",
      chatId: "owner",
      senderId: "owner",
    },
  };
  const origin = { kind: "system", reason: "No-op crash recovery test" } as const;
  const [databasePath, kind, cancelValue] = process.argv.slice(2);
  assert.ok(databasePath);
  assert.ok(kind === "join" || kind === "timer_wait");
  assert.ok(cancelValue === "false" || cancelValue === "true");
  const cancel = cancelValue === "true";
  let store = await openDomainStore({ databasePath });
  try {
    await store.identities.bindOwner("owner", caller.scope);
    const task = await store.tasks.createTask({
      title: "Crash recovery",
      creatorPrincipalId: "owner",
      authorizationScope: caller.scope,
    });
    const now = new Date().toISOString();
    const step: TaskStep = {
      id: "crash-step",
      taskId: task.id,
      kind,
      title: "Pure step",
      status: "pending",
      dependencyIds: [],
      dependencyPolicy: { failed: "block", cancelled: "cancel", skipped: "skip" },
      maxAttempts: 1,
      requiredCapabilities: [],
      delegatedPermissionSet: [],
      version: 1,
      createdAt: now,
      updatedAt: now,
      ...(kind === "timer_wait"
        ? {
            waitPolicy: {
              version: 1 as const,
              kind: "until" as const,
              dueAt: "2020-01-01T00:00:00.000Z",
              overdue: "resume" as const,
            },
          }
        : {}),
    };
    const downstream: TaskStep = {
      ...step,
      id: "downstream",
      kind: "join",
      waitPolicy: undefined,
      dependencyIds: [step.id],
    };
    await store.longWork.createGraph(
      task.id,
      [step, downstream],
      downstream.id,
      DEFAULT_TASK_GRAPH_LIMITS,
      origin,
    );
    const transition = store.longWork.transitionStep.bind(store.longWork);
    store.longWork.transitionStep = async (input) => {
      const result = await transition(input);
      if (input.stepId === step.id && input.to === "running")
        throw new Error("injected crash after start commit");
      return result;
    };
    const input = { taskId: task.id, policyRevision: 1 };
    await assert.rejects(createAdvanceLongWorkActivity(store)(input), {
      message: "injected crash after start commit",
    });
    assert.strictEqual(
      (await store.longWork.listSteps(task.id)).find((item) => item.id === step.id)?.status,
      "running",
    );
    await store.close();
    store = await openDomainStore({ databasePath });
    const advance = createAdvanceLongWorkActivity(store);
    if (cancel) {
      await store.authorization.grant({
        principalId: "owner",
        resourceId: `task-${task.id}`,
        action: "task:cancel",
        scope: caller.scope,
        effect: "allow",
      });
      const decision = await store.authorization.check({
        caller,
        resourceId: `task-${task.id}`,
        action: "task:cancel",
      });
      assert.strictEqual(decision.decision, "ALLOW");
      await store.longWork.requestDurableCancellation(task.id, {
        kind: "decision",
        actorPrincipalId: "owner",
        decisionId: decision.id,
      });
      await advance(input);
      assert.deepStrictEqual(await advance(input), { kind: "complete" });
      assert.deepStrictEqual(await advance(input), { kind: "complete" });
      assert.strictEqual((await store.tasks.getTask(task.id))?.status, "CANCELED");
      assert.deepStrictEqual(
        (await store.longWork.listSteps(task.id)).map((item) => item.status),
        ["cancelled", "cancelled"],
      );
      const events = await store.longWork.listEvents(task.id);
      assert.strictEqual(
        events.filter((event) => event.stepId === step.id && event.type === "STEP_CANCELLED")
          .length,
        1,
      );
      assert.strictEqual(
        events.filter((event) => event.stepId === step.id && event.type === "STEP_SUCCEEDED")
          .length,
        0,
      );
    } else {
      await advance(input);
      await advance(input);
      assert.deepStrictEqual(
        (await store.longWork.listSteps(task.id)).map((item) => item.status),
        ["succeeded", "succeeded"],
      );
      assert.deepStrictEqual(await advance(input), { kind: "complete" });
      assert.strictEqual((await store.tasks.getTask(task.id))?.status, "REVIEW");
      const events = await store.longWork.listEvents(task.id);
      assert.strictEqual(
        events.filter((event) => event.stepId === step.id && event.type === "STEP_STARTED").length,
        1,
      );
      assert.strictEqual(
        events.filter((event) => event.stepId === step.id && event.type === "STEP_SUCCEEDED")
          .length,
        1,
      );
    }
  } finally {
    await store.close();
  }
  console.log(JSON.stringify({ completed: "no-op-recovery" }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await runFixture();
