import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskStep } from "@glassbox/contracts";
import { openDomainStore, type DomainStore } from "../persistence/index.js";
import { FakeHerdrBridge } from "./fake-herdr-bridge.js";
import { DurableWorkerObserver } from "./durable-worker-observer.js";
import { WorkerCandidateLimitError } from "./long-work-store.js";
import { OpsReconciler } from "./reconciler.js";

const system = { kind: "system", reason: "durable worker observer test" } as const;
const limits = {
  maxSteps: 8,
  maxDependenciesPerStep: 4,
  maxFanOut: 4,
  maxReadySteps: 4,
  maxParallelSteps: 2,
};
const stores: DomainStore[] = [];
const directories: string[] = [];

function workerStep(
  taskId: string,
  stepId: string,
  kind: TaskStep["kind"] = "herdr_worker",
): TaskStep {
  const now = new Date().toISOString();
  return {
    id: stepId,
    taskId,
    kind,
    title: "Run worker",
    status: "pending",
    dependencyIds: [],
    dependencyPolicy: { failed: "block", cancelled: "cancel", skipped: "skip" },
    maxAttempts: 1,
    requiredCapabilities: [],
    delegatedPermissionSet: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

async function fixture(agentKind = "codex", prompted = true, databasePath = ":memory:") {
  const store = await openDomainStore({ databasePath });
  stores.push(store);
  await store.identities.createPrincipal("owner", "owner");
  const task = await store.tasks.createTask({
    title: "Durable worker",
    creatorPrincipalId: "owner",
  });
  const stepId = `step-${randomUUID()}`;
  await store.longWork.createGraph(task.id, [workerStep(task.id, stepId)], stepId, limits, system);
  await store.longWork.transitionStep({
    taskId: task.id,
    stepId,
    expectedVersion: 1,
    from: "pending",
    to: "ready",
    origin: system,
  });
  await store.db.transaction(async (tx) => {
    await tx.execute({
      sql: "UPDATE task_steps SET status = 'running', version = 3 WHERE id = ?",
      args: [stepId],
    });
    // A durable Task reaches RUNNING when its first Step attempt starts; adopting a graph
    // instead leaves it NEW. The Worker binding guard reads that status, so a fixture that
    // skips it describes a Task no Worker could ever have been bound to.
    await tx.execute({
      sql: "UPDATE tasks SET status = 'RUNNING', updated_at = ? WHERE id = ?",
      args: [new Date().toISOString(), task.id],
    });
    await tx.execute({
      sql: "INSERT INTO task_attempts(id,task_id,step_id,attempt_number,status,started_at) VALUES ('attempt-1',?,?,1,'running',?)",
      args: [task.id, stepId, new Date().toISOString()],
    });
  });
  const bridge = new FakeHerdrBridge("session-1");
  const worker = await bridge.startAgent({ workspaceId: "workspace-1", agentKind });
  const binding = await store.tasks.bindWorker({
    taskAttemptId: "attempt-1",
    herdrSession: "session-1",
    workspaceId: "workspace-1",
    paneId: worker.paneId,
    agentName: worker.agentName,
    agentKind,
  });
  if (prompted) await store.tasks.markWorkerPromptDispatched("attempt-1", binding.id);
  const lease = await store.longWork.acquireLease({
    id: "lease-1",
    taskId: task.id,
    stepId,
    attemptId: "attempt-1",
    workerBindingId: binding.id,
    ownerInstanceId: "owner-instance",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    origin: system,
  });
  if (!lease) throw new Error("Expected exclusive Worker lease");
  const observer = new DurableWorkerObserver(store.db, store.longWork, store.tasks);
  const reconciler = new OpsReconciler(store.tasks, bridge, 1_000, observer);
  return { store, task, stepId, bridge, worker, binding, observer, reconciler };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("DurableWorkerObserver", () => {
  it("rejects an invalidated candidate when working and idle share the capture timestamp", async () => {
    const { store, task, stepId, worker } = await fixture("pi");
    const management = new DurableWorkerObserver(store.db, store.longWork, store.tasks, false);
    const event = {
      type: "agent.state" as const,
      sessionId: "session-1",
      workspaceId: "workspace-1",
      paneId: worker.paneId,
      agentName: worker.agentName,
      timestamp: new Date(Date.now() + 10).toISOString(),
    };
    await management.observeEvent({ ...event, state: "working" });
    let captured = false;
    const observer = new DurableWorkerObserver(
      store.db,
      store.longWork,
      store.tasks,
      true,
      async (claim, state, observedAt, observationSequence) => {
        const ref = await store.longWork.recordWorkerCandidate({
          ...claim,
          workerBindingId: claim.bindingId,
          output: "first output",
          expectedObservation: { state, observedAt, sequence: observationSequence },
        });
        if (!captured) {
          captured = true;
          await management.observeEvent({ ...event, state: "working" });
          await management.observeEvent({ ...event, state: "idle" });
        }
        return ref;
      },
    );
    await observer.observeEvent({ ...event, state: "idle" });
    expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("running");
    expect(
      await store.longWork.getWorkerCandidate(task.id, stepId, "attempt-1", {
        reviewableOnly: true,
      }),
    ).toBeNull();
    await observer.observeEvent({ ...event, state: "idle" });
    expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("blocked");
    expect((await store.longWork.listEvents(task.id)).at(-1)?.evidenceRef).toContain(
      "worker-output-stale-rework-required",
    );
    expect((await store.tasks.getTask(task.id))?.status).not.toBe("DONE");
  });

  it.each(["state", "timestamp", "same-timestamp cycle"] as const)(
    "checks candidate observation %s before the first insert",
    async (change) => {
      const { store, task, stepId, worker } = await fixture("pi");
      const management = new DurableWorkerObserver(store.db, store.longWork, store.tasks, false);
      const timestamp = Date.now() + 10;
      const event = {
        type: "agent.state" as const,
        sessionId: "session-1",
        workspaceId: "workspace-1",
        paneId: worker.paneId,
        agentName: worker.agentName,
      };
      await management.observeEvent({
        ...event,
        state: "working",
        timestamp: new Date(timestamp).toISOString(),
      });
      let racing = true;
      const observer = new DurableWorkerObserver(
        store.db,
        store.longWork,
        store.tasks,
        true,
        async (claim, state, observedAt, observationSequence) => {
          if (racing) {
            racing = false;
            await management.observeEvent({
              ...event,
              state: change === "timestamp" ? "idle" : "working",
              timestamp: new Date(timestamp + (change === "timestamp" ? 2 : 1)).toISOString(),
            });
            if (change === "same-timestamp cycle")
              await management.observeEvent({
                ...event,
                state: "idle",
                timestamp: new Date(timestamp + 1).toISOString(),
              });
          }
          return store.longWork.recordWorkerCandidate({
            ...claim,
            workerBindingId: claim.bindingId,
            output: "current output",
            expectedObservation: { state, observedAt, sequence: observationSequence },
          });
        },
      );
      await observer.observeEvent({
        ...event,
        state: "idle",
        timestamp: new Date(timestamp + 1).toISOString(),
      });
      expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("running");
      expect(await store.longWork.getWorkerCandidate(task.id, stepId, "attempt-1")).toBeNull();
      await observer.observeEvent({
        ...event,
        state: "idle",
        timestamp: new Date(timestamp + 3).toISOString(),
      });
      expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("review");
      expect(
        (
          await store.longWork.getWorkerCandidate(task.id, stepId, "attempt-1", {
            reviewableOnly: true,
          })
        )?.outputExcerpt,
      ).toBe("current output");
    },
  );

  it("keeps candidate invalidation after a database reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "glassbox-stale-candidate-"));
    directories.push(directory);
    const databasePath = join(directory, "state.db");
    const { store, task, stepId, worker, binding } = await fixture("pi", true, databasePath);
    const management = new DurableWorkerObserver(store.db, store.longWork, store.tasks, false);
    const timestamp = Date.now() + 10;
    const event = {
      type: "agent.state" as const,
      sessionId: "session-1",
      workspaceId: "workspace-1",
      paneId: worker.paneId,
      agentName: worker.agentName,
    };
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
    stores.splice(stores.indexOf(store), 1);
    const reopened = await openDomainStore({ databasePath });
    stores.push(reopened);
    const observer = new DurableWorkerObserver(
      reopened.db,
      reopened.longWork,
      reopened.tasks,
      true,
      (claim, state, observedAt, observationSequence) =>
        reopened.longWork.recordWorkerCandidate({
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
    expect((await reopened.longWork.listSteps(task.id))[0]?.status).toBe("blocked");
    expect(
      await reopened.longWork.getWorkerCandidate(task.id, stepId, "attempt-1", {
        reviewableOnly: true,
      }),
    ).toBeNull();
    expect(
      (await reopened.longWork.getWorkerCandidate(task.id, stepId, "attempt-1"))?.outputExcerpt,
    ).toBe("first output");
    expect((await reopened.longWork.listEvents(task.id)).at(-1)?.evidenceRef).toContain(
      "worker-output-stale-rework-required",
    );
  });

  it("quarantines an immutable candidate when its Worker resumes before a later completion", async () => {
    const { store, task, worker } = await fixture("pi");
    const management = new DurableWorkerObserver(store.db, store.longWork, store.tasks, false);
    const timestamp = Date.now() + 10;
    const event = {
      type: "agent.state" as const,
      sessionId: "session-1",
      workspaceId: "workspace-1",
      paneId: worker.paneId,
      agentName: worker.agentName,
    };
    await management.observeEvent({
      ...event,
      state: "working",
      timestamp: new Date(timestamp).toISOString(),
    });
    let captures = 0;
    const observer = new DurableWorkerObserver(
      store.db,
      store.longWork,
      store.tasks,
      true,
      async (claim) => {
        const ref = await store.longWork.recordWorkerCandidate({
          ...claim,
          workerBindingId: claim.bindingId,
          output: captures === 0 ? "first output" : "later output",
        });
        if (captures++ === 0)
          await management.observeEvent({
            ...event,
            state: "working",
            timestamp: new Date(timestamp + 2).toISOString(),
          });
        return ref;
      },
    );
    await observer.observeEvent({
      ...event,
      state: "idle",
      timestamp: new Date(timestamp + 1).toISOString(),
    });
    expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("running");
    await observer.observeEvent({
      ...event,
      state: "idle",
      timestamp: new Date(timestamp + 3).toISOString(),
    });
    expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("blocked");
    expect(
      (
        await store.longWork.getWorkerCandidate(
          task.id,
          (await store.longWork.listSteps(task.id))[0]!.id,
          "attempt-1",
        )
      )?.outputExcerpt,
    ).toBe("first output");
    expect(
      await store.longWork.getWorkerCandidate(
        task.id,
        (await store.longWork.listSteps(task.id))[0]!.id,
        "attempt-1",
        { reviewableOnly: true },
      ),
    ).toBeNull();
    expect(
      (
        await store.longWork.getQuarantinedLease(
          task.id,
          (await store.longWork.listSteps(task.id))[0]!.id,
        )
      )?.attemptId,
    ).toBe("attempt-1");
    expect((await store.tasks.getTask(task.id))?.status).not.toBe("DONE");
  });

  it("does not settle captured idle evidence after management sees resumed work in the same timestamp", async () => {
    const { store, task, worker } = await fixture("pi");
    const management = new DurableWorkerObserver(store.db, store.longWork, store.tasks, false);
    const timestamp = new Date(Date.now() + 10).toISOString();
    const event = {
      type: "agent.state" as const,
      sessionId: "session-1",
      workspaceId: "workspace-1",
      paneId: worker.paneId,
      agentName: worker.agentName,
      timestamp,
    };
    await management.observeEvent({ ...event, state: "working" });
    const observer = new DurableWorkerObserver(
      store.db,
      store.longWork,
      store.tasks,
      true,
      async () => {
        await management.observeEvent({ ...event, state: "working" });
        return "candidate-result";
      },
    );
    await observer.observeEvent({ ...event, state: "idle" });
    expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("running");
    expect((await store.tasks.getWorkerBinding("attempt-1"))?.lastObservedAgentState).toBe(
      "working",
    );
    expect(
      (await store.longWork.listEvents(task.id)).filter(
        (entry) => entry.type === "ATTEMPT_FINISHED",
      ),
    ).toHaveLength(0);
  });

  it.each([
    ["working", "unknown", "idle"],
    ["working", "idle", "unknown"],
    ["working", "idle", "idle"],
  ] as const)(
    "recovers durable Pi completion after observations %j and database reopen",
    async (...states) => {
      const directory = await mkdtemp(join(tmpdir(), "glassbox-worker-observation-"));
      directories.push(directory);
      const databasePath = join(directory, "state.db");
      const { store, task, worker } = await fixture("pi", true, databasePath);
      const management = new DurableWorkerObserver(store.db, store.longWork, store.tasks, false);
      const timestamp = Date.now() + 10;
      const event = {
        type: "agent.state" as const,
        sessionId: "session-1",
        workspaceId: "workspace-1",
        paneId: worker.paneId,
        agentName: worker.agentName,
      };
      for (const [index, state] of states.entries())
        await management.observeEvent({
          ...event,
          state,
          timestamp: new Date(timestamp + index).toISOString(),
        });
      expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("running");
      await store.close();
      stores.splice(stores.indexOf(store), 1);
      const reopened = await openDomainStore({ databasePath });
      stores.push(reopened);
      const observer = new DurableWorkerObserver(reopened.db, reopened.longWork, reopened.tasks);
      const idle = {
        ...event,
        state: "idle" as const,
        timestamp: new Date(timestamp + 10).toISOString(),
      };
      await observer.observeEvent(idle);
      await observer.observeEvent(idle);
      expect((await reopened.longWork.listSteps(task.id))[0]?.status).toBe("review");
      expect((await reopened.tasks.getTask(task.id))?.status).not.toBe("DONE");
      expect(
        (await reopened.longWork.listEvents(task.id)).filter(
          (entry) => entry.type === "ATTEMPT_FINISHED",
        ),
      ).toHaveLength(1);
    },
  );

  it("does not use an older idle after the management observer sees renewed work", async () => {
    const { store, task, worker, observer } = await fixture("pi");
    const management = new DurableWorkerObserver(store.db, store.longWork, store.tasks, false);
    const timestamp = Date.now() + 10;
    const event = {
      type: "agent.state" as const,
      sessionId: "session-1",
      workspaceId: "workspace-1",
      paneId: worker.paneId,
      agentName: worker.agentName,
    };
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
    await management.observeEvent({
      ...event,
      state: "working",
      timestamp: new Date(timestamp + 2).toISOString(),
    });
    await observer.observeEvent({
      ...event,
      state: "idle",
      timestamp: new Date(timestamp + 1).toISOString(),
    });
    expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("running");
    await observer.observeEvent({
      ...event,
      state: "idle",
      timestamp: new Date(timestamp + 3).toISOString(),
    });
    expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("review");
  });

  it("does not infer Pi completion through a blocked observation", async () => {
    const { store, task, worker, observer } = await fixture("pi");
    const management = new DurableWorkerObserver(store.db, store.longWork, store.tasks, false);
    const timestamp = Date.now() + 10;
    const event = {
      type: "agent.state" as const,
      sessionId: "session-1",
      workspaceId: "workspace-1",
      paneId: worker.paneId,
      agentName: worker.agentName,
    };
    for (const [index, state] of (["working", "blocked", "unknown", "idle"] as const).entries())
      await management.observeEvent({
        ...event,
        state,
        timestamp: new Date(timestamp + index).toISOString(),
      });
    await observer.observeEvent({
      ...event,
      state: "idle",
      timestamp: new Date(timestamp + 4).toISOString(),
    });
    expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("running");
  });

  it("retains Pi completion when management observes working and idle before Temporal", async () => {
    const { store, task, worker, observer } = await fixture("pi");
    const management = new DurableWorkerObserver(store.db, store.longWork, store.tasks, false);
    const timestamp = new Date(Date.now() + 10).toISOString();
    const event = {
      type: "agent.state" as const,
      sessionId: "session-1",
      workspaceId: "workspace-1",
      paneId: worker.paneId,
      agentName: worker.agentName,
      state: "working" as const,
      timestamp,
    };
    await management.observeEvent(event);
    const idle = { ...event, state: "idle" as const };
    await management.observeEvent(idle);
    expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("running");
    await observer.observeEvent(idle);
    await observer.observeEvent(idle);
    expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("review");
    expect((await store.tasks.getTask(task.id))?.status).not.toBe("DONE");
    expect(
      (await store.longWork.listEvents(task.id)).filter(
        (entry) => entry.type === "ATTEMPT_FINISHED",
      ),
    ).toHaveLength(1);
  });

  it("lets the management observer record done without settling the Temporal-owned Step", async () => {
    const { store, task, stepId, bridge, worker } = await fixture("pi");
    const managementObserver = new DurableWorkerObserver(
      store.db,
      store.longWork,
      store.tasks,
      false,
    );
    bridge.simulateAgentState(worker.paneId, "done");

    await managementObserver.observeSnapshot(await bridge.getSnapshot());

    expect(
      (await store.longWork.listSteps(task.id)).find((step) => step.id === stepId)?.status,
    ).toBe("running");
    expect((await store.tasks.getWorkerBinding("attempt-1"))?.lastObservedAgentState).toBe("done");
  });

  it("does not accept a Worker completion before its prompt acknowledgement", async () => {
    const { store, task, stepId, bridge, worker, reconciler } = await fixture("pi", false);
    bridge.simulateAgentState(worker.paneId, "done");

    await reconciler.reconcileSnapshot(await bridge.getSnapshot());

    expect(
      (await store.longWork.listSteps(task.id)).find((step) => step.id === stepId)?.status,
    ).toBe("running");
  });

  it("settles a trusted done observation into Step review without completing the Task", async () => {
    const { store, task, stepId, bridge, worker, reconciler } = await fixture();
    bridge.simulateAgentState(worker.paneId, "done");

    await reconciler.reconcileSnapshot(await bridge.getSnapshot());

    expect(
      (await store.longWork.listSteps(task.id)).find((step) => step.id === stepId)?.status,
    ).toBe("review");
    expect((await store.tasks.getAttempt("attempt-1"))?.status).toBe("review");
    expect((await store.tasks.getTask(task.id))?.status).not.toBe("DONE");
    const lease = await store.db.transaction(
      async (tx) =>
        (await tx.execute("SELECT state FROM task_step_leases WHERE id = 'lease-1'")).rows[0]
          ?.state,
    );
    expect(lease).toBe("released");
  });

  it("blocks a completed Worker when its candidate output exceeds the capture limit", async () => {
    const { store, task, stepId, bridge, worker } = await fixture("pi");
    const observer = new DurableWorkerObserver(
      store.db,
      store.longWork,
      store.tasks,
      true,
      async () => {
        throw new WorkerCandidateLimitError();
      },
    );
    bridge.simulateAgentState(worker.paneId, "done");

    await observer.observeSnapshot(await bridge.getSnapshot());

    expect((await store.longWork.listSteps(task.id))[0]?.status).toBe("blocked");
    expect(await store.longWork.getWorkerCandidate(task.id, stepId, "attempt-1")).toBeNull();
    expect((await store.longWork.listEvents(task.id)).at(-1)?.evidenceRef).toContain(
      "worker-output-limit",
    );
  });

  it("settles Pi working-to-idle and ignores duplicate completion events", async () => {
    const { store, task, stepId, worker, reconciler } = await fixture("pi");
    const timestamp = new Date().toISOString();
    const event = {
      type: "agent.state" as const,
      sessionId: "session-1",
      workspaceId: "workspace-1",
      paneId: worker.paneId,
      agentName: worker.agentName,
      state: "working" as const,
      timestamp,
    };
    await reconciler.handleEvent(event);
    const idle = { ...event, state: "idle" as const };
    await reconciler.handleEvent(idle);
    await reconciler.handleEvent(idle);

    expect(
      (await store.longWork.listSteps(task.id)).find((step) => step.id === stepId)?.status,
    ).toBe("review");
    const events = await store.longWork.listEvents(task.id);
    expect(events.filter((entry) => entry.type === "ATTEMPT_FINISHED")).toHaveLength(1);
  });

  it("does not treat the initial Pi idle observation as completed work", async () => {
    const { store, task, stepId, worker, reconciler } = await fixture("pi");
    await reconciler.handleEvent({
      type: "agent.state",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      paneId: worker.paneId,
      agentName: worker.agentName,
      state: "idle",
      timestamp: new Date().toISOString(),
    });

    expect((await store.tasks.getWorkerBinding("attempt-1"))?.lastObservedAgentState).toBe("idle");
    expect(
      (await store.longWork.listSteps(task.id)).find((step) => step.id === stepId)?.status,
    ).toBe("running");
  });

  it("creates one safe Attention and TASK_BLOCKED event for a blocked Worker", async () => {
    const { store, task, stepId, worker, reconciler } = await fixture();
    const event = {
      type: "agent.state" as const,
      sessionId: "session-1",
      workspaceId: "workspace-1",
      paneId: worker.paneId,
      agentName: worker.agentName,
      state: "blocked" as const,
      timestamp: new Date().toISOString(),
    };

    await reconciler.handleEvent(event);
    await reconciler.handleEvent(event);

    expect((await store.tasks.getTask(task.id))?.status).toBe("WAITING_INPUT");
    const attention = await store.db.transaction(async (tx) =>
      tx.execute({
        sql: "SELECT kind,summary,task_attempt_id FROM attention_items WHERE task_id = ? AND resolved_at IS NULL",
        args: [task.id],
      }),
    );
    expect(attention.rows).toEqual([
      expect.objectContaining({
        kind: "worker_blocked",
        summary: "Durable Worker is waiting for input",
        task_attempt_id: "attempt-1",
      }),
    ]);
    const events = await store.longWork.listEvents(task.id);
    expect(events.filter((entry) => entry.type === "TASK_BLOCKED")).toEqual([
      expect.objectContaining({
        stepId,
        attemptId: "attempt-1",
        evidenceRef: expect.stringContaining("event:"),
        metadata: expect.objectContaining({ reason: "worker_blocked" }),
      }),
    ]);
    expect(events.some((entry) => JSON.stringify(entry).includes("private worker output"))).toBe(
      false,
    );
  });

  it("resolves only the same Attempt's Worker Attention when work resumes", async () => {
    const { store, task, worker, reconciler } = await fixture();
    const blocked = {
      type: "agent.state" as const,
      sessionId: "session-1",
      workspaceId: "workspace-1",
      paneId: worker.paneId,
      agentName: worker.agentName,
      state: "blocked" as const,
      timestamp: new Date().toISOString(),
    };
    await reconciler.handleEvent(blocked);
    await reconciler.handleEvent({
      ...blocked,
      state: "working",
      timestamp: new Date(Date.now() + 1).toISOString(),
    });

    expect((await store.tasks.getTask(task.id))?.status).toBe("RUNNING");
    const attention = await store.db.transaction(async (tx) =>
      tx.execute({
        sql: "SELECT resolved_at FROM attention_items WHERE task_id = ? AND task_attempt_id = 'attempt-1' AND kind = 'worker_blocked'",
        args: [task.id],
      }),
    );
    expect(attention.rows).toHaveLength(1);
    expect(attention.rows[0]?.resolved_at).not.toBeNull();
  });

  it("ignores a delayed blocked event after a newer working observation", async () => {
    const { store, task, worker, reconciler } = await fixture();
    const blockedAt = new Date(Date.now() + 1).toISOString();
    const base = {
      type: "agent.state" as const,
      sessionId: "session-1",
      workspaceId: "workspace-1",
      paneId: worker.paneId,
      agentName: worker.agentName,
    };
    await reconciler.handleEvent({ ...base, state: "blocked", timestamp: blockedAt });
    await reconciler.handleEvent({
      ...base,
      state: "working",
      timestamp: new Date(Date.parse(blockedAt) + 10).toISOString(),
    });
    await reconciler.handleEvent({ ...base, state: "blocked", timestamp: blockedAt });

    expect((await store.tasks.getTask(task.id))?.status).toBe("RUNNING");
    const attention = await store.db.transaction(async (tx) =>
      tx.execute({
        sql: "SELECT resolved_at FROM attention_items WHERE task_id = ? AND task_attempt_id = 'attempt-1' AND kind = 'worker_blocked'",
        args: [task.id],
      }),
    );
    expect(attention.rows).toHaveLength(1);
    expect(attention.rows[0]?.resolved_at).not.toBeNull();
  });

  it("clears a blocked Worker Attention atomically when that Attempt reaches review", async () => {
    const { store, task, worker, reconciler } = await fixture();
    const timestamp = new Date().toISOString();
    await reconciler.handleEvent({
      type: "agent.state",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      paneId: worker.paneId,
      agentName: worker.agentName,
      state: "blocked",
      timestamp,
    });
    await reconciler.handleEvent({
      type: "agent.state",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      paneId: worker.paneId,
      agentName: worker.agentName,
      state: "done",
      timestamp: new Date(Date.now() + 1).toISOString(),
    });

    const attention = await store.db.transaction(async (tx) =>
      tx.execute({
        sql: "SELECT resolved_at FROM attention_items WHERE task_id = ? AND task_attempt_id = 'attempt-1' AND kind = 'worker_blocked'",
        args: [task.id],
      }),
    );
    expect(attention.rows[0]?.resolved_at).not.toBeNull();
    expect((await store.tasks.getTask(task.id))?.status).not.toBe("DONE");
  });

  it("quarantines the exact lease when a complete snapshot shows a replacement identity", async () => {
    const { store, task, stepId, bridge, worker, reconciler } = await fixture();
    bridge.simulateAgentState(worker.paneId, "done");
    const snapshot = await bridge.getSnapshot();
    snapshot.workspaces[0]!.panes[0]!.agentName = "replacement-agent";

    await reconciler.reconcileSnapshot(snapshot);

    expect(
      (await store.longWork.listSteps(task.id)).find((step) => step.id === stepId)?.status,
    ).toBe("blocked");
    expect((await store.tasks.getAttempt("attempt-1"))?.status).toBe("waiting_input");
    expect((await store.tasks.getWorkerBinding("attempt-1"))?.lastObservedAgentState).toBe(
      "unknown",
    );
    const lease = await store.db.transaction(
      async (tx) =>
        (await tx.execute("SELECT state FROM task_step_leases WHERE id = 'lease-1'")).rows[0]
          ?.state,
    );
    expect(lease).toBe("quarantined");
    expect((await store.tasks.getTask(task.id))?.status).not.toBe("DONE");
  });

  it("keeps disconnect and lost-event observations stale without releasing or quarantining the lease", async () => {
    const { store, task, stepId, bridge, worker, reconciler } = await fixture();
    await reconciler.reconcileSnapshot(await bridge.getSnapshot());
    vi.spyOn(bridge, "getSnapshot").mockRejectedValueOnce(new Error("snapshot unavailable"));

    await expect(
      reconciler.handleEvent({
        type: "events.lost",
        sessionId: "session-1",
        workspaceId: "",
        paneId: "",
        timestamp: new Date().toISOString(),
      }),
    ).rejects.toThrow("snapshot unavailable");

    expect(
      (await store.longWork.listSteps(task.id)).find((step) => step.id === stepId)?.status,
    ).toBe("running");
    expect((await store.tasks.getWorkerBinding("attempt-1"))?.lastObservedAgentState).toBe(
      "unknown",
    );
    const lease = await store.db.transaction(
      async (tx) =>
        (await tx.execute("SELECT state FROM task_step_leases WHERE id = 'lease-1'")).rows[0]
          ?.state,
    );
    expect(lease).toBe("active");
    expect(worker.paneId).toBeTruthy();
  });

  it("does not settle a durable binding when an event carries the wrong agent identity", async () => {
    const { store, task, stepId, worker, reconciler } = await fixture();

    await reconciler.handleEvent({
      type: "agent.state",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      paneId: worker.paneId,
      agentName: "replacement-agent",
      state: "done",
      timestamp: new Date().toISOString(),
    });

    expect(
      (await store.longWork.listSteps(task.id)).find((step) => step.id === stepId)?.status,
    ).toBe("running");
    expect((await store.tasks.getWorkerBinding("attempt-1"))?.lastObservedAgentState).toBe(
      "starting",
    );
  });

  it("ignores a delayed old worker event after the same pane is rebound to a new attempt", async () => {
    const { store, task, stepId, worker, reconciler } = await fixture();
    await store.db.transaction(async (tx) => {
      await tx.execute("UPDATE task_attempts SET status = 'review' WHERE id = 'attempt-1'");
      await tx.execute("UPDATE task_step_leases SET state = 'released' WHERE id = 'lease-1'");
      await tx.execute({
        sql: "UPDATE task_steps SET status = 'running', version = 4 WHERE id = ?",
        args: [stepId],
      });
      await tx.execute({
        sql: "INSERT INTO task_attempts(id,task_id,step_id,attempt_number,status,started_at) VALUES ('attempt-2',?,?,2,'running',?)",
        args: [task.id, stepId, new Date().toISOString()],
      });
    });
    const replacement = await store.tasks.bindWorker({
      taskAttemptId: "attempt-2",
      herdrSession: "session-1",
      workspaceId: "workspace-1",
      paneId: worker.paneId,
      agentName: "replacement-agent",
      agentKind: "codex",
      lastObservedAgentState: "working",
    });
    await store.longWork.acquireLease({
      id: "lease-2",
      taskId: task.id,
      stepId,
      attemptId: "attempt-2",
      workerBindingId: replacement.id,
      ownerInstanceId: "owner-instance-2",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      origin: system,
    });

    await reconciler.handleEvent({
      type: "agent.state",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      paneId: worker.paneId,
      agentName: worker.agentName,
      state: "done",
      timestamp: new Date().toISOString(),
    });

    expect(
      (await store.longWork.listSteps(task.id)).find((step) => step.id === stepId)?.status,
    ).toBe("running");
    expect((await store.tasks.getAttempt("attempt-2"))?.status).toBe("running");
    const lease = await store.db.transaction(
      async (tx) =>
        (await tx.execute("SELECT state FROM task_step_leases WHERE id = 'lease-2'")).rows[0]
          ?.state,
    );
    expect(lease).toBe("active");
  });

  it("does not mutate a replacement attempt when settlement loses its CAS race", async () => {
    const { store, task, stepId, worker, reconciler } = await fixture();
    const settle = store.longWork.settleClaimedStep.bind(store.longWork);
    vi.spyOn(store.longWork, "settleClaimedStep").mockImplementationOnce(async (input) => {
      await store.db.transaction(async (tx) => {
        await tx.execute("UPDATE task_attempts SET status = 'review' WHERE id = 'attempt-1'");
        await tx.execute("UPDATE task_step_leases SET state = 'released' WHERE id = 'lease-1'");
        await tx.execute({
          sql: "UPDATE task_steps SET version = version + 1 WHERE id = ?",
          args: [stepId],
        });
        await tx.execute({
          sql: "INSERT INTO task_attempts(id,task_id,step_id,attempt_number,status,started_at) VALUES ('attempt-2',?,?,2,'running',?)",
          args: [task.id, stepId, new Date().toISOString()],
        });
      });
      const replacement = await store.tasks.bindWorker({
        taskAttemptId: "attempt-2",
        herdrSession: "session-1",
        workspaceId: "workspace-1",
        paneId: worker.paneId,
        agentName: "replacement-agent",
        agentKind: "codex",
      });
      await store.longWork.acquireLease({
        id: "lease-2",
        taskId: task.id,
        stepId,
        attemptId: "attempt-2",
        workerBindingId: replacement.id,
        ownerInstanceId: "owner-instance-2",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        origin: system,
      });
      return settle(input);
    });

    await reconciler.handleEvent({
      type: "agent.state",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      paneId: worker.paneId,
      agentName: worker.agentName,
      state: "done",
      timestamp: new Date().toISOString(),
    });

    expect(
      (await store.longWork.listSteps(task.id)).find((step) => step.id === stepId),
    ).toMatchObject({
      status: "running",
      version: 4,
    });
    expect((await store.tasks.getAttempt("attempt-2"))?.status).toBe("running");
    const lease = await store.db.transaction(
      async (tx) =>
        (await tx.execute("SELECT state FROM task_step_leases WHERE id = 'lease-2'")).rows[0]
          ?.state,
    );
    expect(lease).toBe("active");
  });

  it("quarantines a missing pane from a complete snapshot and leaves repeated observations unchanged", async () => {
    const { store, task, stepId, reconciler } = await fixture();
    const missing = {
      sessionId: "session-1",
      workspaces: [],
      timestamp: new Date().toISOString(),
    };

    await reconciler.reconcileSnapshot(missing);
    await reconciler.reconcileSnapshot(missing);

    expect(
      (await store.longWork.listSteps(task.id)).find((step) => step.id === stepId)?.status,
    ).toBe("blocked");
    const events = await store.longWork.listEvents(task.id);
    expect(events.filter((entry) => entry.type === "WORKER_LOST")).toHaveLength(1);
  });
});
