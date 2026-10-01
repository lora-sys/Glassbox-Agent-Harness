import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { openDomainStore } from "../application/domain-store.js";
import { DurableWorkerObserver } from "./durable-worker-observer.js";
import { durableWorkerFixture } from "./durable-worker-test-fixture.js";

export const durableWorkerReopenFixtureScript = new URL(import.meta.url);

async function runFixture() {
  const [databasePath, scenario, ...states] = process.argv.slice(2);
  assert.ok(databasePath);
  assert.ok(scenario === "candidate" || scenario === "observations");
  let store = await openDomainStore({ databasePath });
  try {
    const { task, stepId, worker, binding } = await durableWorkerFixture(store, "pi", true);
    const management = new DurableWorkerObserver(store.db, store.longWork, store.tasks, false);
    const timestamp = Date.now() + 10;
    const event = {
      type: "agent.state" as const,
      sessionId: "session-1",
      workspaceId: "workspace-1",
      paneId: worker.paneId,
      agentName: worker.agentName,
    };
    if (scenario === "candidate") {
      await management.observeEvent({
        ...event,
        state: "working",
        timestamp: new Date(timestamp).toISOString(),
      });
      await management.observeEvent({
        ...event,
        state: "idle",
        timestamp: new Date(timestamp + 1).toISOString(),
      });
      await store.longWork.recordWorkerCandidate({
        taskId: task.id,
        stepId,
        attemptId: "attempt-1",
        leaseId: "lease-1",
        ownerInstanceId: "owner-instance",
        workerBindingId: binding.id,
        expectedStepVersion: 3,
        expectedLeaseVersion: 1,
        output: "first output",
        expectedObservation: { state: "idle", observedAt: new Date(timestamp + 1).toISOString() },
      });
      await management.observeEvent({
        ...event,
        state: "working",
        timestamp: new Date(timestamp + 2).toISOString(),
      });
      await store.close();
      store = await openDomainStore({ databasePath });
      const observer = new DurableWorkerObserver(
        store.db,
        store.longWork,
        store.tasks,
        true,
        (claim, state, observedAt, observationSequence) =>
          store.longWork.recordWorkerCandidate({
            ...claim,
            workerBindingId: claim.bindingId,
            output: "later output",
            expectedObservation: { state, observedAt, sequence: observationSequence },
          }),
      );
      await observer.observeEvent({
        ...event,
        state: "idle",
        timestamp: new Date(timestamp + 3).toISOString(),
      });
      assert.strictEqual((await store.longWork.listSteps(task.id))[0]?.status, "blocked");
      assert.strictEqual(
        await store.longWork.getWorkerCandidate(task.id, stepId, "attempt-1", {
          reviewableOnly: true,
        }),
        null,
      );
      assert.strictEqual(
        (await store.longWork.getWorkerCandidate(task.id, stepId, "attempt-1"))?.outputExcerpt,
        "first output",
      );
      assert.ok(
        (await store.longWork.listEvents(task.id))
          .at(-1)
          ?.evidenceRef?.includes("worker-output-stale-rework-required"),
      );
    } else {
      assert.strictEqual(states.length, 3);
      for (const [index, state] of states.entries()) {
        assert.ok(state === "working" || state === "unknown" || state === "idle");
        await management.observeEvent({
          ...event,
          state,
          timestamp: new Date(timestamp + index).toISOString(),
        });
      }
      assert.strictEqual((await store.longWork.listSteps(task.id))[0]?.status, "running");
      await store.close();
      store = await openDomainStore({ databasePath });
      const observer = new DurableWorkerObserver(store.db, store.longWork, store.tasks);
      const idle = {
        ...event,
        state: "idle" as const,
        timestamp: new Date(timestamp + 10).toISOString(),
      };
      await observer.observeEvent(idle);
      await observer.observeEvent(idle);
      assert.strictEqual((await store.longWork.listSteps(task.id))[0]?.status, "review");
      assert.notStrictEqual((await store.tasks.getTask(task.id))?.status, "DONE");
      assert.strictEqual(
        (await store.longWork.listEvents(task.id)).filter(
          (entry) => entry.type === "ATTEMPT_FINISHED",
        ).length,
        1,
      );
    }
  } finally {
    await store.close();
  }
  console.log(JSON.stringify({ completed: scenario }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await runFixture();
