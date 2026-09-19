import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { openDomainStore, type DomainStore } from "../persistence/index.js";
import { FakeHerdrBridge } from "./fake-herdr-bridge.js";
import { OpsReconciler } from "./reconciler.js";

const stores: DomainStore[] = [];
const directories: string[] = [];

async function storeAt(databasePath = ":memory:"): Promise<DomainStore> {
  const store = await openDomainStore({ databasePath });
  stores.push(store);
  await store.identities.createPrincipal("owner", "owner");
  return store;
}

async function taskWithWorker(store: DomainStore, bridge: FakeHerdrBridge, agentKind = "codex") {
  const task = await store.tasks.createTask({ title: "test", creatorPrincipalId: "owner" });
  const attempt = await store.tasks.createAttempt({ taskId: task.id });
  const worker = await bridge.startAgent({ workspaceId: "workspace-1", agentKind });
  await store.tasks.bindWorker({
    taskAttemptId: attempt.id,
    herdrSession: "session-1",
    workspaceId: "workspace-1",
    paneId: worker.paneId,
    agentKind,
  });
  return { task, attempt, worker };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0)) {
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows may retain the SQLite handle briefly after libsql closes it.
    }
  }
});

describe("OpsReconciler safety", () => {
  it("resolves a recovered session alert after snapshot reconciliation without hiding task failures", async () => {
    const store = await storeAt();
    const bridge = new FakeHerdrBridge("session-1");
    const reconciler = new OpsReconciler(store.tasks, bridge);
    const task = await store.tasks.createTask({
      title: "dispatch failure",
      creatorPrincipalId: "owner",
    });
    const global = await store.tasks.createAttentionItem({
      kind: "ops_connection_problem",
      summary: "Herdr session disconnected",
    });
    const taskScoped = await store.tasks.createAttentionItem({
      kind: "ops_connection_problem",
      summary: "Worker dispatch failed",
      taskId: task.id,
    });
    try {
      await reconciler.start();
      expect(await store.tasks.listAttentionItems()).toEqual([
        expect.objectContaining({ id: taskScoped.id, taskId: task.id }),
      ]);
      const all = await store.tasks.listAttentionItems(false);
      expect(all.find((item) => item.id === global.id)?.resolvedAt).not.toBeNull();
    } finally {
      await reconciler.stop();
    }
  });

  it("recovers Pi completion across disconnect only for the bound agent instance", async () => {
    const store = await storeAt();
    const bridge = new FakeHerdrBridge("session-1");
    const reconciler = new OpsReconciler(store.tasks, bridge);
    const task = await store.tasks.createTask({
      title: "Pi reconnect",
      creatorPrincipalId: "owner",
    });
    const attempt = await store.tasks.createAttempt({ taskId: task.id });
    const worker = await bridge.startAgent({ workspaceId: "workspace-1", agentKind: "pi" });
    await store.tasks.bindWorker({
      taskAttemptId: attempt.id,
      herdrSession: "session-1",
      workspaceId: "workspace-1",
      paneId: worker.paneId,
      agentName: worker.agentName,
      agentKind: "pi",
    });
    await reconciler.reconcileSnapshot(await bridge.getSnapshot());
    await reconciler.reconcileSnapshot({
      sessionId: "session-1",
      workspaces: [],
      timestamp: new Date().toISOString(),
    });
    const replaced = await bridge.getSnapshot();
    replaced.workspaces[0]!.panes[0]!.agentName = "replacement-pi";
    replaced.workspaces[0]!.panes[0]!.state = "done";
    await reconciler.reconcileSnapshot(replaced);
    expect((await store.tasks.getTask(task.id))?.status).toBe("RUNNING");
    expect((await store.tasks.getWorkerBinding(attempt.id))?.lastObservedAgentState).toBe(
      "unknown",
    );
    await reconciler.handleEvent({
      type: "agent.state",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      paneId: worker.paneId,
      agentName: "replacement-pi",
      state: "done",
      timestamp: new Date().toISOString(),
    });
    expect((await store.tasks.getTask(task.id))?.status).toBe("RUNNING");
    // A nameless stale done event cannot replace the current named worker's state.
    await reconciler.handleEvent({
      type: "agent.state",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      paneId: worker.paneId,
      state: "done",
      timestamp: new Date().toISOString(),
    });
    expect((await store.tasks.getTask(task.id))?.status).toBe("RUNNING");
    bridge.simulateAgentState(worker.paneId, "idle");
    await reconciler.reconcileSnapshot(await bridge.getSnapshot());
    expect((await store.tasks.getTask(task.id))?.status).toBe("REVIEW");
    expect((await store.tasks.getAttempt(attempt.id))?.status).toBe("review");
  });
  it("distinguishes startup idle from Pi's observed working-to-idle completion", async () => {
    const store = await storeAt();
    const bridge = new FakeHerdrBridge("session-1");
    const { task, worker } = await taskWithWorker(store, bridge, "pi");
    const scope = { herdrSession: "session-1", workspaceId: "workspace-1", paneId: worker.paneId };
    await store.tasks.observeWorker(scope, "idle");
    expect((await store.tasks.getTask(task.id))?.status).toBe("RUNNING");
    await store.tasks.observeWorker(scope, "working");
    await store.tasks.observeWorker(scope, "idle");
    expect((await store.tasks.getTask(task.id))?.status).toBe("REVIEW");
    expect((await store.tasks.listTraceEvents({ taskId: task.id })).at(-1)?.data).toMatchObject({
      state: "idle",
      status: "REVIEW",
    });
  });
  it("does not infer completion from an idle observation for other worker kinds", async () => {
    const store = await storeAt();
    const bridge = new FakeHerdrBridge("session-1");
    const { task, worker } = await taskWithWorker(store, bridge);
    const scope = { herdrSession: "session-1", workspaceId: "workspace-1", paneId: worker.paneId };
    await store.tasks.observeWorker(scope, "working");
    await store.tasks.observeWorker(scope, "idle");
    expect((await store.tasks.getTask(task.id))?.status).toBe("RUNNING");
  });
  it("retries a failed connection and reconciles missed completion into REVIEW", async () => {
    const store = await storeAt();
    const bridge = new FakeHerdrBridge("session-1");
    const reconciler = new OpsReconciler(store.tasks, bridge, 5);
    const { task, attempt, worker } = await taskWithWorker(store, bridge);
    await reconciler.start();
    const originalSubscription = reconciler.getSubscriptionId();
    let releaseConnection!: () => void;
    const connected = new Promise<void>((resolve) => {
      releaseConnection = resolve;
    });
    const connect = vi
      .spyOn(bridge, "connect")
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockImplementation(async () => {
        await connected;
        await FakeHerdrBridge.prototype.connect.call(bridge);
      });
    try {
      await bridge.disconnect();
      await expect
        .poll(async () => (await store.tasks.getWorkerBinding(attempt.id))?.lastObservedAgentState)
        .toBe("unknown");
      bridge.simulateAgentState(worker.paneId, "done");
      expect((await store.tasks.getTask(task.id))?.status).toBe("RUNNING");
      releaseConnection();
      await expect.poll(async () => (await store.tasks.getTask(task.id))?.status).toBe("REVIEW");
      expect(reconciler.getSubscriptionId()).not.toBe(originalSubscription);
      expect(connect).toHaveBeenCalledTimes(2);
    } finally {
      releaseConnection();
      await reconciler.stop();
    }
  });

  it("does not resubscribe if stopped during a pending reconnect", async () => {
    const store = await storeAt();
    const bridge = new FakeHerdrBridge("session-1");
    const reconciler = new OpsReconciler(store.tasks, bridge, 1);
    await reconciler.start();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connect = vi.spyOn(bridge, "connect").mockImplementation(() => pending);
    const subscribe = vi.spyOn(bridge, "subscribe");
    await bridge.disconnect();
    await expect.poll(() => connect.mock.calls.length).toBe(1);
    const stopped = reconciler.stop();
    release();
    await stopped;
    expect(subscribe).not.toHaveBeenCalled();
    expect(reconciler.getSubscriptionId()).toBeNull();
  });

  it("marks missing workers unknown and restores observed state without accepting the task", async () => {
    const store = await storeAt();
    const bridge = new FakeHerdrBridge("session-1");
    const reconciler = new OpsReconciler(store.tasks, bridge);
    const { task, attempt } = await taskWithWorker(store, bridge);
    await reconciler.reconcileSnapshot({
      sessionId: "session-1",
      workspaces: [],
      timestamp: new Date().toISOString(),
    });
    expect((await store.tasks.getWorkerBinding(attempt.id))?.lastObservedAgentState).toBe(
      "unknown",
    );
    expect((await store.tasks.getTask(task.id))?.status).toBe("RUNNING");
    await reconciler.reconcileSnapshot(await bridge.getSnapshot());
    expect((await store.tasks.getWorkerBinding(attempt.id))?.lastObservedAgentState).not.toBe(
      "unknown",
    );
    expect((await store.tasks.getTask(task.id))?.status).not.toBe("DONE");
  });
  it("ignores an event from a different Herdr session even when pane ids match", async () => {
    const store = await storeAt();
    const bridge = new FakeHerdrBridge("session-1");
    const reconciler = new OpsReconciler(store.tasks, bridge);
    const { task, worker } = await taskWithWorker(store, bridge);

    await reconciler.handleEvent({
      type: "agent.state",
      sessionId: "other-session",
      workspaceId: "workspace-1",
      paneId: worker.paneId,
      state: "done",
      timestamp: new Date().toISOString(),
    });

    expect((await store.tasks.getTask(task.id))?.status).toBe("RUNNING");
  });

  it("does not let an old attempt event overwrite the active rework attempt", async () => {
    const store = await storeAt();
    const bridge = new FakeHerdrBridge("session-1");
    const reconciler = new OpsReconciler(store.tasks, bridge);
    const { task, attempt, worker } = await taskWithWorker(store, bridge);

    await reconciler.handleEvent({
      type: "agent.state",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      paneId: worker.paneId,
      state: "done",
      timestamp: new Date().toISOString(),
    });
    const reworked = await store.tasks.reworkTask(task.id, "fix it");

    await reconciler.handleEvent({
      type: "agent.state",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      paneId: worker.paneId,
      state: "blocked",
      timestamp: new Date().toISOString(),
    });

    const current = await store.tasks.getTask(task.id);
    expect(current?.activeAttemptId).toBe(reworked.newAttempt.id);
    expect(current?.status).toBe("RUNNING");
    expect((await store.tasks.getAttempt(attempt.id))?.status).toBe("review");
  });

  it("unsubscribes on stop so later events have no product side effects", async () => {
    const store = await storeAt();
    const bridge = new FakeHerdrBridge("session-1");
    const reconciler = new OpsReconciler(store.tasks, bridge);
    await reconciler.start();
    const { task, worker } = await taskWithWorker(store, bridge);
    await reconciler.stop();

    bridge.simulateAgentState(worker.paneId, "done");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(reconciler.getSubscriptionId()).toBeNull();
    expect((await store.tasks.getTask(task.id))?.status).toBe("RUNNING");
  });

  it("serializes competing accept and rework actions", async () => {
    const store = await storeAt();
    const bridge = new FakeHerdrBridge("session-1");
    const reconciler = new OpsReconciler(store.tasks, bridge);
    const { task, worker } = await taskWithWorker(store, bridge);
    await reconciler.handleEvent({
      type: "agent.state",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      paneId: worker.paneId,
      state: "done",
      timestamp: new Date().toISOString(),
    });

    const outcomes = await Promise.allSettled([
      store.tasks.acceptTask(task.id, "owner"),
      store.tasks.reworkTask(task.id, "more tests", "owner"),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
  });

  it("keeps task trace after the database is reopened", async () => {
    const directory = await mkdtemp(join(tmpdir(), "glassbox-ops-trace-"));
    directories.push(directory);
    const databasePath = join(directory, "glassbox.db");
    const first = await storeAt(databasePath);
    const task = await first.tasks.createTask({ title: "durable", creatorPrincipalId: "owner" });
    await first.close();
    stores.splice(stores.indexOf(first), 1);

    const reopened = await openDomainStore({ databasePath });
    stores.push(reopened);
    const events = await reopened.tasks.listTraceEvents({ taskId: task.id });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "task.created", taskId: task.id });
  });
});
