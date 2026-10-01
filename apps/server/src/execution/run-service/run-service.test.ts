import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  agentResourceId,
  openDomainStore,
  scopeKey,
  type CallerContext,
  type DomainStore,
  type TrustedChannelScope,
} from "../../persistence/index.js";
import {
  RunService,
  type ExecutionFailureCode,
  type ExecutionInput,
  type ExecutionResult,
  type RunExecutionAdapter,
  type RunServiceEvent,
  type RunTransport,
  type SendOutcome,
} from "./index.js";

const group: TrustedChannelScope = {
  connectionId: "test-connection",
  botId: "test-bot",
  chatType: "group",
  chatId: "test-group",
  senderId: "test-owner",
};
const privateScope: TrustedChannelScope = { ...group, chatType: "private", chatId: "test-owner" };
const otherGroup: TrustedChannelScope = { ...group, chatId: "other-test-group" };
const owner = (scope = group): CallerContext => ({ principalId: "owner", scope });
const services: RunService[] = [];
const stores: DomainStore[] = [];
const directories: string[] = [];

it("executes the exact approved Run once and still honors revocation", async () => {
  const { store, grants } = await fixture();
  await store.authorization.revoke(grants.get(scopeKey(group) + "run:create")!);
  const grantId = await store.authorization.grant({
    principalId: "owner",
    resourceId: agentResourceId("personal"),
    action: "run:create",
    scope: group,
    effect: "approval",
  });
  const approvalId = await store.authorization.approve({
    grantId,
    approverId: "owner",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const execute = vi.fn(async () => ({ status: "succeeded" as const, text: "approved result" }));
  const { instance } = service(store, { supportsGroup: true, execute });
  await instance.start();
  const accepted = await instance.receive({ ...input("approved-run"), approvalId });
  expect((await instance.waitForRun(owner(), accepted.run.id)).status).toBe("succeeded");
  expect(execute).toHaveBeenCalledTimes(1);
  await expect(instance.receive({ ...input("replayed-approval"), approvalId })).rejects.toThrow();
  await store.authorization.revoke(grantId);
  expect(
    (
      await store.authorization.check({
        caller: owner(),
        resourceId: agentResourceId("personal"),
        action: "run:create",
        runId: accepted.run.id,
      })
    ).decision,
  ).toBe("DENY");
});

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function fixture(databasePath = ":memory:") {
  const store = await openDomainStore({ databasePath });
  stores.push(store);
  await store.conversations.createAgent("personal");
  await store.identities.bindOwner("owner", group);
  const grants = new Map<string, string>();
  for (const scope of [group, privateScope, otherGroup]) {
    for (const action of ["run:create", "run:control", "delivery:send", "conversation:read"]) {
      const id = await store.authorization.grant({
        principalId: "owner",
        resourceId: agentResourceId("personal"),
        action,
        scope,
        effect: "allow",
      });
      grants.set(scopeKey(scope) + action, id);
    }
  }
  return { store, grants };
}

function input(messageId: string, text = messageId, scope = group, executionRef = "fake") {
  return { agentId: "personal", scope, messageId, text, executionRef };
}

function service(
  store: DomainStore,
  adapter: RunExecutionAdapter,
  transport: RunTransport = { send: async () => ({ status: "sent" }) },
  options: {
    concurrency?: number;
    queuedPollMs?: number;
    deliveryTimeoutMs?: number;
    prepareDelivery?: ConstructorParameters<typeof RunService>[0]["prepareDelivery"];
    captureLearning?: ConstructorParameters<typeof RunService>[0]["captureLearning"];
  } = {},
) {
  const events: RunServiceEvent[] = [];
  const errors: unknown[] = [];
  const instance = new RunService({
    store,
    resolveExecution: () => adapter,
    transport,
    ...options,
    onEvent: (event) => {
      events.push(event);
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  services.push(instance);
  return { instance, events, errors };
}

it("publishes a durable Task review notice through the exact origin audience", async () => {
  const { store } = await fixture();
  const accepted = await store.conversations.acceptIncoming(input("notice-source"));
  await store.tasks.createTask({
    id: "notice-task",
    title: "Private title",
    creatorPrincipalId: "owner",
    conversationId: accepted.conversation.id,
    runId: accepted.run.id,
    authorizationScope: group,
  });
  await store.authorization.grant({
    principalId: "owner",
    resourceId: "task-notice-task",
    action: "task:read",
    scope: group,
    effect: "allow",
  });
  const noticeId = await store.db.transaction(async (tx) => {
    await tx.execute(
      "UPDATE tasks SET status = 'REVIEW', orchestration_mode = 'durable' WHERE id = 'notice-task'",
    );
    const inserted = await tx.execute({
      sql: "INSERT INTO task_events(id,task_id,type,metadata_json,created_at) VALUES ('notice-event','notice-task','TASK_REVIEW','{}',?) RETURNING sequence",
      args: [new Date().toISOString()],
    });
    const notice = await store.taskNotifications.enqueueTx(tx, Number(inserted.rows[0]!.sequence));
    return notice!.id;
  });
  const send = vi.fn(async (_request: Parameters<RunTransport["send"]>[0]) => ({
    status: "sent" as const,
    externalId: "qq-notice",
  }));
  const { instance } = service(
    store,
    { supportsGroup: true, execute: async () => ({ status: "succeeded" }) },
    { send },
  );
  await instance.start();
  await instance.drain();
  const noticeCalls = send.mock.calls.filter(([request]) => request.delivery.id === noticeId);
  expect(noticeCalls).toHaveLength(1);
  expect(noticeCalls[0]![0].destination).toEqual(group);
  expect(noticeCalls[0]![0].delivery.payloadText).not.toContain("Private title");
  const row = await store.db.transaction((tx) =>
    tx.execute({
      sql: "SELECT status,external_id FROM task_notifications WHERE id = ?",
      args: [noticeId],
    }),
  );
  expect(row.rows[0]).toMatchObject({ status: "sent", external_id: "qq-notice" });
});

it("suppresses a Task notification when Task read is revoked before delivery", async () => {
  const { store } = await fixture();
  const accepted = await store.conversations.acceptIncoming(input("revoked-notice-source"));
  await store.tasks.createTask({
    id: "revoked-notice-task",
    title: "Private title",
    creatorPrincipalId: "owner",
    conversationId: accepted.conversation.id,
    runId: accepted.run.id,
    authorizationScope: group,
  });
  const taskGrant = await store.authorization.grant({
    principalId: "owner",
    resourceId: "task-revoked-notice-task",
    action: "task:read",
    scope: group,
    effect: "allow",
  });
  const noticeId = await store.db.transaction(async (tx) => {
    await tx.execute(
      "UPDATE tasks SET status = 'REVIEW', orchestration_mode = 'durable' WHERE id = 'revoked-notice-task'",
    );
    const inserted = await tx.execute({
      sql: "INSERT INTO task_events(id,task_id,type,metadata_json,created_at) VALUES ('revoked-notice-event','revoked-notice-task','TASK_REVIEW','{}',?) RETURNING sequence",
      args: [new Date().toISOString()],
    });
    const notice = await store.taskNotifications.enqueueTx(tx, Number(inserted.rows[0]!.sequence));
    return notice!.id;
  });
  await store.authorization.revoke(taskGrant);
  const send = vi.fn(async (_request: Parameters<RunTransport["send"]>[0]) => ({
    status: "sent" as const,
  }));
  const { instance } = service(
    store,
    { supportsGroup: true, execute: async () => ({ status: "succeeded" }) },
    { send },
  );
  await instance.start();
  await instance.drain();
  expect(send.mock.calls.some(([request]) => request.delivery.id === noticeId)).toBe(false);
  const row = await store.db.transaction((tx) =>
    tx.execute({ sql: "SELECT status FROM task_notifications WHERE id = ?", args: [noticeId] }),
  );
  expect(row.rows[0]?.status).toBe("suppressed");
});

it("never executes a Tool Step adapter from external ingress", async () => {
  const { store } = await fixture();
  const execute = vi.fn(async () => ({ status: "succeeded" as const, text: "protected" }));
  const { instance } = service(store, { supportsGroup: true, supportsTaskStepTool: true, execute });
  await instance.start();
  const accepted = await instance.receive(
    input("external-tool", "external-tool", group, "tool:task_get:task-1"),
  );
  expect((await instance.waitForRun(owner(), accepted.run.id)).status).toBe("failed");
  expect(execute).not.toHaveBeenCalled();
});

it("executes a persisted Model Step Run without QQ ingress history or automatic delivery", async () => {
  const { store } = await fixture();
  const execute = vi.fn(async (request: ExecutionInput) => ({
    status: "succeeded" as const,
    text: request.executionMode === "task_step_model" ? "step result" : "source result",
  }));
  const send = vi.fn(async () => ({ status: "sent" as const }));
  const { instance } = service(
    store,
    { supportsGroup: true, supportsTaskStepModel: true, execute },
    { send },
    { queuedPollMs: 500 },
  );
  await instance.start();
  const accepted = await instance.receive(input("model-step-source"));
  await instance.waitForRun(owner(), accepted.run.id);
  await instance.drain();
  const deliveredBefore = send.mock.calls.length;

  await store.tasks.createTask({
    id: "model-task",
    title: "Model task",
    creatorPrincipalId: "owner",
    conversationId: accepted.conversation.id,
    authorizationScope: group,
  });
  for (const action of ["task:read", "task:continue"])
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "task-model-task",
      action,
      scope: group,
      effect: "allow",
    });
  const now = new Date().toISOString();
  await store.db.transaction(async (tx) => {
    await tx.execute({
      sql: "UPDATE tasks SET status = 'RUNNING', orchestration_mode = 'durable' WHERE id = 'model-task'",
      args: [],
    });
    await tx.execute({
      sql: "INSERT INTO task_steps(id,task_id,kind,title,instructions,status,dependency_policy_json,max_attempts,required_capabilities_json,delegated_permissions_json,version,created_at,updated_at) VALUES ('model-step','model-task','model','Model','Write a result','running','{}',1,'[]','[]',1,?,?)",
      args: [now, now],
    });
    await tx.execute({
      sql: "INSERT INTO task_attempts(id,task_id,step_id,attempt_number,status,started_at) VALUES ('model-attempt','model-task','model-step',1,'running',?)",
      args: [now],
    });
    await tx.execute({
      sql: "INSERT INTO task_step_leases(id,task_id,step_id,attempt_id,owner_instance_id,state,version,acquired_at,heartbeat_at,expires_at) VALUES ('model-lease','model-task','model-step','model-attempt','temporal-model','active',1,?,?,?)",
      args: [now, now, new Date(Date.now() + 60_000).toISOString()],
    });
  });
  const internal = await store.conversations.createInternalStepRun({
    caller: owner(),
    taskId: "model-task",
    stepId: "model-step",
    attemptId: "model-attempt",
    executionRef: "model:fixture",
  });
  const finished = await instance.waitForRun(owner(), internal.id);
  expect(finished).toMatchObject({
    source: "task_step",
    status: "succeeded",
    resultText: "step result",
  });
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({
      executionMode: "task_step_model",
      text: "Write a result",
      history: [],
    }),
  );
  await instance.drain();
  expect(send).toHaveBeenCalledTimes(deliveredBefore);
  expect((await store.lifecycle.listDeliveries(owner(), internal.id)).items).toEqual([]);
  expect(
    (await store.conversations.listRuns(owner(), accepted.conversation.id)).items.map(
      (run) => run.id,
    ),
  ).not.toContain(internal.id);

  await instance.stop({ wait: true });
  const restored = service(
    store,
    { supportsGroup: true, supportsTaskStepModel: true, execute },
    { send },
  ).instance;
  await restored.start();
  await restored.drain();
  expect(send).toHaveBeenCalledTimes(deliveredBefore);
});

it("rechecks Task read authority after loading internal Run context", async () => {
  const { store } = await fixture();
  const bootstrap = service(store, {
    supportsGroup: true,
    execute: async () => ({ status: "succeeded", text: "source" }),
  }).instance;
  await bootstrap.start();
  const source = await bootstrap.receive(input("read-revocation-source"));
  await bootstrap.waitForRun(owner(), source.run.id);
  await bootstrap.drain();
  await bootstrap.stop();

  const internal = await createInternalModelStepRun(store, source.conversation.id);
  const load = store.conversations.loadRunInput.bind(store.conversations);
  vi.spyOn(store.conversations, "loadRunInput").mockImplementation(async (caller, runId) => {
    const loaded = await load(caller, runId);
    if (runId === internal.runId)
      await store.db.transaction((tx) =>
        tx.execute({
          sql: "UPDATE grants SET revoked_at = ? WHERE resource_id = ? AND action = 'task:read'",
          args: [new Date().toISOString(), `task-${internal.taskId}`],
        }),
      );
    return loaded;
  });
  const execute = vi.fn(async () => ({ status: "succeeded" as const, text: "leaked" }));
  const resumed = service(store, {
    supportsGroup: true,
    supportsTaskStepModel: true,
    execute,
  }).instance;
  await resumed.start();
  await resumed.drain();
  const storedRun = await store.db.transaction((tx) =>
    tx.execute({ sql: "SELECT status FROM runs WHERE id = ?", args: [internal.runId] }),
  );
  expect(storedRun.rows[0]?.status).toBe("failed");
  expect(execute).not.toHaveBeenCalled();
});

it("cancels a queued internal Run when its owning Task requests cancellation", async () => {
  const { store } = await fixture();
  const execute = vi.fn(async (): Promise<ExecutionResult> => ({
    status: "succeeded",
    text: "done",
  }));
  const first = service(store, {
    supportsGroup: true,
    supportsTaskStepModel: true,
    execute,
  }).instance;
  await first.start();
  const source = await first.receive(input("queued-task-cancel-source"));
  await first.waitForRun(owner(), source.run.id);
  await first.drain();
  await first.stop();

  const internal = await createInternalModelStepRun(store, source.conversation.id);
  await store.db.transaction((tx) =>
    tx.execute({
      sql: "UPDATE tasks SET cancellation_state = 'requested' WHERE id = ?",
      args: [internal.taskId],
    }),
  );
  const resumed = service(store, {
    supportsGroup: true,
    supportsTaskStepModel: true,
    execute,
  }).instance;
  await resumed.start();
  expect((await resumed.waitForRun(owner(), internal.runId)).status).toBe("cancelled");
  await resumed.drain();
  expect(execute).toHaveBeenCalledTimes(1);
  expect((await store.lifecycle.listDeliveries(owner(), internal.runId)).items).toEqual([]);
});

it("aborts an active internal Run when its owning Task requests cancellation", async () => {
  const { store } = await fixture();
  const control = controlledAdapter();
  const execute = vi.fn(async (request: ExecutionInput): Promise<ExecutionResult> =>
    request.executionMode === "task_step_model"
      ? control.adapter.execute(request)
      : { status: "succeeded", text: "source complete" },
  );
  const { instance } = service(
    store,
    { ...control.adapter, supportsTaskStepModel: true, execute },
    { send: async () => ({ status: "sent" }) },
    { queuedPollMs: 500 },
  );
  await instance.start();
  const source = await instance.receive(input("active-task-cancel-source"));
  await instance.waitForRun(owner(), source.run.id);
  await instance.drain();
  const internal = await createInternalModelStepRun(store, source.conversation.id);
  await instance.enqueueInternalStepRun(owner(), internal.runId);
  const execution = await control.started("Write a result");

  await store.db.transaction((tx) =>
    tx.execute({
      sql: "UPDATE tasks SET cancellation_state = 'requested' WHERE id = ?",
      args: [internal.taskId],
    }),
  );
  await vi.waitFor(async () => {
    expect((await instance.getRun(owner(), internal.runId)).status).toBe("cancelling");
  });
  expect(execution.signal.aborted).toBe(true);
  control.finish("Write a result", { status: "cancelled" });
  await instance.drain();
  expect((await instance.getRun(owner(), internal.runId)).status).toBe("cancelled");
  expect((await store.lifecycle.listDeliveries(owner(), internal.runId)).items).toEqual([]);
});

async function createInternalModelStepRun(store: DomainStore, conversationId: string) {
  const taskId = `cancel-task-${Math.random().toString(36).slice(2)}`;
  await store.tasks.createTask({
    id: taskId,
    title: "Cancellation test",
    creatorPrincipalId: "owner",
    conversationId,
    authorizationScope: group,
  });
  for (const action of ["task:read", "task:continue"])
    await store.authorization.grant({
      principalId: "owner",
      resourceId: `task-${taskId}`,
      action,
      scope: group,
      effect: "allow",
    });
  const now = new Date().toISOString();
  await store.db.transaction(async (tx) => {
    await tx.execute({
      sql: "UPDATE tasks SET status = 'RUNNING', orchestration_mode = 'durable' WHERE id = ?",
      args: [taskId],
    });
    await tx.execute({
      sql: "INSERT INTO task_steps(id,task_id,kind,title,instructions,status,dependency_policy_json,max_attempts,required_capabilities_json,delegated_permissions_json,version,created_at,updated_at) VALUES (?,?,'model','Model','Write a result','running','{}',1,'[]','[]',1,?,?)",
      args: [`${taskId}-step`, taskId, now, now],
    });
    await tx.execute({
      sql: "INSERT INTO task_attempts(id,task_id,step_id,attempt_number,status,started_at) VALUES (?,?,?,1,'running',?)",
      args: [`${taskId}-attempt`, taskId, `${taskId}-step`, now],
    });
    await tx.execute({
      sql: "INSERT INTO task_step_leases(id,task_id,step_id,attempt_id,owner_instance_id,state,version,acquired_at,heartbeat_at,expires_at) VALUES (?,?,?,?,'test-model','active',1,?,?,?)",
      args: [
        `${taskId}-lease`,
        taskId,
        `${taskId}-step`,
        `${taskId}-attempt`,
        now,
        now,
        new Date(Date.now() + 60_000).toISOString(),
      ],
    });
  });
  const run = await store.conversations.createInternalStepRun({
    caller: owner(),
    taskId,
    stepId: `${taskId}-step`,
    attemptId: `${taskId}-attempt`,
    executionRef: "model:fixture",
  });
  return { taskId, runId: run.id };
}

function controlledAdapter() {
  const starts = new Map<string, ReturnType<typeof deferred<ExecutionInput>>>();
  const finishes = new Map<string, ReturnType<typeof deferred<ExecutionResult>>>();
  const calls: ExecutionInput[] = [];
  let running = 0;
  let maxRunning = 0;
  function startSignal(text: string) {
    let signal = starts.get(text);
    if (!signal) {
      signal = deferred<ExecutionInput>();
      starts.set(text, signal);
    }
    return signal;
  }
  const adapter: RunExecutionAdapter = {
    supportsGroup: true,
    execute: async (request) => {
      calls.push(request);
      running++;
      maxRunning = Math.max(maxRunning, running);
      const completion = deferred<ExecutionResult>();
      finishes.set(request.text, completion);
      startSignal(request.text).resolve(request);
      try {
        return await completion.promise;
      } finally {
        running--;
      }
    },
  };
  return {
    adapter,
    calls,
    started: (text: string) => startSignal(text).promise,
    finish(
      text: string,
      result: ExecutionResult = { status: "succeeded", text: `answer:${text}` },
    ) {
      const pending = finishes.get(text);
      if (!pending) throw new Error("Execution has not started");
      pending.resolve(result);
    },
    maxRunning: () => maxRunning,
    finishAll() {
      for (const pending of finishes.values()) pending.resolve({ status: "interrupted" });
    },
  };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const instance of services.splice(0)) await instance.stop();
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0)) {
    const resolved = resolve(directory);
    if (dirname(resolved) !== resolve(tmpdir()) || !resolved.includes("glassbox-run-service-"))
      throw new Error("Invalid disposable fixture path");
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

describe("durable Run scheduling", () => {
  it("retries a transient claim failure and executes the queued Run once", async () => {
    const { store } = await fixture();
    const claim = store.lifecycle.claimQueuedRun.bind(store.lifecycle);
    let attempts = 0;
    vi.spyOn(store.lifecycle, "claimQueuedRun").mockImplementation(async (...args) => {
      if (++attempts < 3) throw new Error("temporary database failure");
      return claim(...args);
    });
    const execute = vi.fn(async () => ({ status: "succeeded" as const, text: "recovered" }));
    const { instance } = service(store, { supportsGroup: true, execute });
    await instance.start();
    const accepted = await instance.receive(input("transient-claim"));
    await expect(instance.waitForRun(owner(), accepted.run.id)).resolves.toMatchObject({
      status: "succeeded",
      resultText: "recovered",
    });
    expect(attempts).toBe(3);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("ends an exhausted queued Run and records Owner attention atomically", async () => {
    const { store } = await fixture();
    const claim = vi
      .spyOn(store.lifecycle, "claimQueuedRun")
      .mockRejectedValue(new Error("temporary database failure"));
    const execute = vi.fn(async () => ({ status: "succeeded" as const, text: "unexpected" }));
    const { instance } = service(store, { supportsGroup: true, execute });
    await instance.start();
    const accepted = await instance.receive(input("exhausted-claim"));
    await expect(instance.waitForRun(owner(), accepted.run.id)).resolves.toMatchObject({
      status: "failed",
      resultText: expect.stringContaining("未能启动"),
    });
    expect(claim).toHaveBeenCalledTimes(4);
    expect(execute).not.toHaveBeenCalled();
    const attention = await store.db.transaction((tx) =>
      tx.execute({
        sql: "SELECT kind, principal_id, conversation_id FROM attention_items WHERE conversation_id = ?",
        args: [accepted.conversation.id],
      }),
    );
    expect(attention.rows).toEqual([
      expect.objectContaining({
        kind: "unanswered_message",
        principal_id: null,
        conversation_id: accepted.conversation.id,
      }),
    ]);
  });

  it("settles a claim whose database transition committed before its reply was lost", async () => {
    const { store } = await fixture();
    const claim = store.lifecycle.claimQueuedRun.bind(store.lifecycle);
    vi.spyOn(store.lifecycle, "claimQueuedRun").mockImplementation(async (...args) => {
      await claim(...args);
      throw new Error("claim reply lost");
    });
    const execute = vi.fn(async () => ({ status: "succeeded" as const, text: "unexpected" }));
    const { instance } = service(store, { supportsGroup: true, execute });
    await instance.start();
    const accepted = await instance.receive(input("lost-claim-reply"));
    await expect(instance.waitForRun(owner(), accepted.run.id)).resolves.toMatchObject({
      status: "failed",
      resultText: expect.stringContaining("未能启动"),
    });
    expect(execute).not.toHaveBeenCalled();
    const attention = await store.db.transaction((tx) =>
      tx.execute({
        sql: "SELECT id FROM attention_items WHERE conversation_id = ? AND kind = 'unanswered_message'",
        args: [accepted.conversation.id],
      }),
    );
    expect(attention.rows).toHaveLength(1);
  });

  it("keeps later Runs in one conversation behind a retrying head", async () => {
    const { store } = await fixture();
    const first = await store.conversations.acceptIncoming(input("retry-head"));
    const second = await store.conversations.acceptIncoming(input("retry-following"));
    const claim = store.lifecycle.claimQueuedRun.bind(store.lifecycle);
    let attempts = 0;
    vi.spyOn(store.lifecycle, "claimQueuedRun").mockImplementation(async (...args) => {
      if (args[1] === first.run.id && ++attempts === 1)
        throw new Error("temporary database failure");
      return claim(...args);
    });
    const executed: string[] = [];
    const { instance } = service(store, {
      supportsGroup: true,
      execute: async (run) => {
        executed.push(run.run.id);
        return { status: "succeeded", text: "done" };
      },
    });
    await instance.start();
    await expect(instance.waitForRun(owner(), second.run.id)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(executed).toEqual([first.run.id, second.run.id]);
  });

  it("lets cancellation win while an unclaimed Run waits for database settlement", async () => {
    const { store } = await fixture();
    const claim = store.lifecycle.claimQueuedRun.bind(store.lifecycle);
    vi.spyOn(store.lifecycle, "claimQueuedRun").mockImplementation(async (...args) => {
      await claim(...args);
      throw new Error("claim reply lost");
    });
    const settle = store.lifecycle.failQueuedDispatch.bind(store.lifecycle);
    const firstSettlement = deferred<void>();
    let settlementCalls = 0;
    vi.spyOn(store.lifecycle, "failQueuedDispatch").mockImplementation(async (...args) => {
      if (++settlementCalls === 1) {
        firstSettlement.resolve();
        throw new Error("temporary database failure");
      }
      return settle(...args);
    });
    const execute = vi.fn(async () => ({ status: "succeeded" as const, text: "unexpected" }));
    const { instance } = service(store, { supportsGroup: true, execute });
    await instance.start();
    const accepted = await instance.receive(input("cancel-unclaimed"));
    await firstSettlement.promise;
    await expect(instance.cancel(owner(), accepted.run.id)).resolves.toMatchObject({
      status: "cancelling",
    });
    await expect(instance.waitForRun(owner(), accepted.run.id)).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(execute).not.toHaveBeenCalled();
    const attention = await store.db.transaction((tx) =>
      tx.execute({
        sql: "SELECT id FROM attention_items WHERE conversation_id = ? AND kind = 'unanswered_message'",
        args: [accepted.conversation.id],
      }),
    );
    expect(attention.rows).toHaveLength(0);
  });

  it("does not publish an unclaimed Run after the service has stopped", async () => {
    const { store } = await fixture();
    const claim = store.lifecycle.claimQueuedRun.bind(store.lifecycle);
    vi.spyOn(store.lifecycle, "claimQueuedRun").mockImplementation(async (...args) => {
      await claim(...args);
      throw new Error("claim reply lost");
    });
    const settle = store.lifecycle.failQueuedDispatch.bind(store.lifecycle);
    const entered = deferred<void>();
    const release = deferred<void>();
    vi.spyOn(store.lifecycle, "failQueuedDispatch").mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return settle(...args);
    });
    const send = vi.fn(async () => ({ status: "sent" as const }));
    const { instance } = service(
      store,
      { supportsGroup: true, execute: async () => ({ status: "succeeded", text: "unexpected" }) },
      { send },
    );
    await instance.start();
    const accepted = await instance.receive(input("stop-during-settlement"));
    await entered.promise;
    await instance.stop();
    release.resolve();
    await instance.drain();
    expect((await store.conversations.getRun(owner(), accepted.run.id)).status).toBe("failed");
    expect(send).not.toHaveBeenCalled();
  });

  it("captures learning only after Run authorization and records candidate identity without payload", async () => {
    const { store } = await fixture();
    const order: string[] = [];
    let captured: ExecutionInput | undefined;
    const execute = vi.fn(async () => {
      order.push("execute");
      return { status: "succeeded" as const, text: "answer" };
    });
    const adapter: RunExecutionAdapter = {
      supportsGroup: true,
      execute,
    };
    const { instance, events } = service(store, adapter, undefined, {
      captureLearning: async (value) => {
        order.push("capture");
        captured = value;
        return "candidate_safe_id";
      },
    });
    await instance.start();
    const accepted = await instance.receive(input("learned", "请记住本群周三开会"));
    await instance.waitForRun(owner(), accepted.run.id);

    expect(captured).toMatchObject({
      text: "请记住本群周三开会",
      caller: owner(),
      run: { id: accepted.run.id },
    });
    expect(order).toEqual(["capture", "execute"]);
    expect(events).toContainEqual({
      type: "learning_candidate_created",
      runId: accepted.run.id,
      conversationId: accepted.conversation.id,
      candidateId: "candidate_safe_id",
      scopeType: "group",
    });
    expect(JSON.stringify(events)).not.toContain("周三开会");
  });

  it("serializes each Conversation, bounds global concurrency, and isolates prior context", async () => {
    const { store } = await fixture();
    const control = controlledAdapter();
    const { instance } = service(store, control.adapter);
    await instance.start();
    try {
      const first = await instance.receive(input("group-first"));
      await control.started("group-first");
      await instance.receive(input("group-second"));
      await instance.receive(input("private-first", "PRIVATE-FIXTURE-671", privateScope));
      const privateInput = await control.started("PRIVATE-FIXTURE-671");
      await instance.receive(input("other-group", "other-group", otherGroup));
      expect(control.calls.map((call) => call.text)).toEqual([
        "group-first",
        "PRIVATE-FIXTURE-671",
      ]);
      expect(control.calls[0]!.history).toEqual([]);
      expect(privateInput.conversation.id).not.toBe(first.conversation.id);
      control.finish("group-first", {
        status: "succeeded",
        text: "group answer",
        providerSessionId: "group-session",
      });
      const second = await control.started("group-second");
      expect(second.history).toEqual([
        { role: "user", text: "group-first" },
        { role: "assistant", text: "group answer" },
      ]);
      expect(second.providerSessionId).toBe("group-session");
      expect(JSON.stringify(second)).not.toContain("PRIVATE-FIXTURE-671");
      expect(privateInput.providerSessionId).toBeNull();
      control.finish("PRIVATE-FIXTURE-671");
      await control.started("other-group");
      control.finish("group-second");
      control.finish("other-group");
      await instance.drain();
      expect(control.maxRunning()).toBe(2);
    } finally {
      await instance.stop();
      control.finishAll();
      await instance.drain();
    }
  });

  it("deduplicates simultaneous incoming messages and sends only the immutable result", async () => {
    const { store } = await fixture();
    const execute = vi.fn(async (): Promise<ExecutionResult> => ({
      status: "succeeded",
      text: "done",
    }));
    const send = vi.fn(async (): Promise<{ status: "sent" }> => ({ status: "sent" }));
    const { instance } = service(store, { supportsGroup: true, execute }, { send });
    await instance.start();
    const accepted = await Promise.all(
      Array.from({ length: 12 }, () => instance.receive(input("duplicate"))),
    );
    await instance.drain();
    expect(new Set(accepted.map((entry) => entry.run.id)).size).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await store.lifecycle.listDeliveries(owner(), accepted[0]!.run.id)).items).toEqual([
      expect.objectContaining({ payloadKind: "result", payloadText: "done", status: "sent" }),
    ]);
  });

  it("opens the trace with the causing message and keeps its body out of the event", async () => {
    const { store } = await fixture();
    const execute = vi.fn(async (): Promise<ExecutionResult> => ({
      status: "succeeded",
      text: "done",
    }));
    const { instance, events } = service(store, { supportsGroup: true, execute });
    await instance.start();
    const accepted = await instance.receive(input("msg-1", "protected body text"));
    await instance.drain();

    const first = events[0];
    expect(first).toMatchObject({
      type: "message_received",
      runId: accepted.run.id,
      conversationId: accepted.conversation.id,
      externalId: "msg-1",
      messageId: accepted.run.messageId,
      connectionId: "test-connection",
      botId: "test-bot",
      chatType: "group",
      chatId: "test-group",
      senderId: "test-owner",
      textBytes: Buffer.byteLength("protected body text", "utf8"),
    });
    // The digest must match the body it summarizes, and no event may carry the body itself.
    expect(first).toMatchObject({
      textSha256: createHash("sha256").update("protected body text", "utf8").digest("hex"),
    });
    for (const event of events) {
      expect(JSON.stringify(event)).not.toContain("protected body text");
    }
    // Ordering: the causing message precedes run_queued and everything after it.
    expect(events[1]).toMatchObject({ type: "run_queued" });

    // A deduplicated message reuses its Run, so it must not re-record the message.
    const before = events.length;
    await instance.receive(input("msg-1", "protected body text"));
    await instance.drain();
    expect(events.filter((event) => event.type === "message_received")).toHaveLength(1);
    expect(events.length).toBe(before);
  });

  it("records a private-chat message with its own scope", async () => {
    const { store } = await fixture();
    const execute = vi.fn(async (): Promise<ExecutionResult> => ({
      status: "succeeded",
      text: "done",
    }));
    const { instance, events } = service(store, { supportsGroup: true, execute });
    await instance.start();
    await instance.receive(input("dm-1", "hello", privateScope));
    await instance.drain();
    expect(events[0]).toMatchObject({
      type: "message_received",
      externalId: "dm-1",
      chatType: "private",
      chatId: "test-owner",
    });
    // Absent rather than undefined: the event omits optional scope fields the message did not carry.
    expect(events[0]).not.toHaveProperty("threadId");
  });

  it("rechecks queued authorization and requires explicit refresh after a policy change", async () => {
    const { store, grants } = await fixture();
    const accepted = await store.conversations.acceptIncoming(input("revoked-queued"));
    await store.authorization.revoke(grants.get(scopeKey(group) + "run:create")!);
    const execute = vi.fn(async (): Promise<ExecutionResult> => ({
      status: "succeeded",
      text: "after grant",
    }));
    const { instance } = service(store, { supportsGroup: true, execute });
    await instance.start();
    await instance.drain();
    expect(execute).not.toHaveBeenCalled();
    expect((await instance.getRun(owner(), accepted.run.id)).status).toBe("queued");
    await store.authorization.grant({
      principalId: "owner",
      resourceId: agentResourceId("personal"),
      action: "run:create",
      scope: group,
      effect: "allow",
    });
    instance.refresh();
    await instance.drain();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("records completion after revocation without saving or publishing the protected result", async () => {
    const { store, grants } = await fixture();
    const control = controlledAdapter();
    const send = vi.fn(async (): Promise<{ status: "sent" }> => ({ status: "sent" }));
    const { instance, events } = service(store, control.adapter, { send });
    await instance.start();
    const accepted = await instance.receive(input("revoke-active"));
    await control.started("revoke-active");
    await store.authorization.revoke(grants.get(scopeKey(group) + "run:create")!);
    await store.authorization.revoke(grants.get(scopeKey(group) + "run:control")!);
    control.finish("revoke-active", {
      status: "succeeded",
      text: "WITHHELD-FIXTURE-98",
      providerSessionId: "withheld-session",
    });
    await instance.drain();
    expect(await instance.getRun(owner(), accepted.run.id)).toMatchObject({
      status: "succeeded",
      resultText: null,
    });
    expect(send).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toContain("WITHHELD-FIXTURE-98");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "run_finished", outputWithheld: true }),
    );
    expect(
      (await store.conversations.getConversation(owner(), accepted.conversation.id))
        .providerSessionId,
    ).toBeNull();
  });

  it("blocks an unsafe candidate, records only its digest, and excludes it from later context", async () => {
    const { store } = await fixture();
    const send = vi.fn(async (): Promise<{ status: "sent" }> => ({ status: "sent" }));
    const execute = vi
      .fn<RunExecutionAdapter["execute"]>()
      .mockResolvedValueOnce({ status: "succeeded", text: "C:\\Users\\owner\\secret" })
      .mockResolvedValueOnce({ status: "succeeded", text: "safe" });
    const { instance, events } = service(
      store,
      { supportsGroup: true, execute },
      { send },
      {
        prepareDelivery: async (candidate) =>
          candidate === "safe"
            ? { allowed: true, text: candidate, reasons: [], candidateSha256: "safe-digest" }
            : {
                allowed: false,
                reasons: ["windows-absolute-path"],
                candidateSha256: "blocked-digest",
              },
      },
    );
    await instance.start();
    const blocked = await instance.receive(input("blocked-output"));
    await instance.drain();
    expect(send).not.toHaveBeenCalled();
    expect((await store.lifecycle.listDeliveries(owner(), blocked.run.id)).items).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "delivery_blocked",
        reasons: ["windows-absolute-path"],
        candidateSha256: "blocked-digest",
      }),
    );
    expect(JSON.stringify(events)).not.toContain("C:\\Users\\owner\\secret");
    const duplicate = await instance.receive(input("blocked-output"));
    await instance.drain();
    expect(duplicate.duplicate).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === "delivery_blocked")).toHaveLength(1);

    const next = await instance.receive(input("after-block"));
    await instance.drain();
    expect(execute.mock.calls[1]?.[0].history).toEqual([]);
    expect((await instance.getRun(owner(), next.run.id)).status).toBe("succeeded");
  });

  it("keeps cancelling until the executor confirms its outcome", async () => {
    const { store } = await fixture();
    const control = controlledAdapter();
    const { instance } = service(store, control.adapter);
    await instance.start();
    const accepted = await instance.receive(input("cancel-active"));
    const execution = await control.started("cancel-active");
    expect((await instance.cancel(owner(), accepted.run.id)).status).toBe("cancelling");
    expect(execution.signal.aborted).toBe(true);
    expect((await instance.getRun(owner(), accepted.run.id)).status).toBe("cancelling");
    expect(
      (await store.lifecycle.listDeliveries(owner(), accepted.run.id)).items.some(
        (delivery) => delivery.payloadKind === "result",
      ),
    ).toBe(false);
    control.finish("cancel-active", { status: "cancelled" });
    await instance.drain();
    expect((await instance.getRun(owner(), accepted.run.id)).status).toBe("cancelled");
  });

  it("cancels queued work without invoking the executor", async () => {
    const { store } = await fixture();
    const control = controlledAdapter();
    const { instance } = service(store, control.adapter);
    await instance.start();
    await instance.receive(input("first-running"));
    await control.started("first-running");
    const queued = await instance.receive(input("cancel-queued"));
    expect((await instance.cancel(owner(), queued.run.id)).status).toBe("cancelled");
    control.finish("first-running");
    await instance.drain();
    expect(control.calls.map((call) => call.text)).toEqual(["first-running"]);
  });

  it("does not pass a saved Provider Session to another execution configuration", async () => {
    const { store } = await fixture();
    const calls: ExecutionInput[] = [];
    const { instance } = service(store, {
      supportsGroup: true,
      execute: async (request) => {
        calls.push(request);
        return {
          status: "succeeded",
          text: "done",
          providerSessionId: `session-${request.run.executionRef}`,
        };
      },
    });
    await instance.start();
    await instance.receive(input("first-provider", "first-provider", group, "provider-a"));
    await instance.drain();
    await instance.receive(input("second-provider", "second-provider", group, "provider-b"));
    await instance.drain();
    expect(calls[1]!.providerSessionId).toBeNull();
    expect(calls[1]!.conversation.providerSessionId).toBeNull();
    expect(calls[1]!.history).toContainEqual({ role: "assistant", text: "done" });
  });

  it("rejects a group-unsafe adapter before it receives any context", async () => {
    const { store } = await fixture();
    const execute = vi.fn(async (): Promise<ExecutionResult> => ({ status: "succeeded" }));
    const { instance } = service(store, { supportsGroup: false, execute });
    await instance.start();
    const accepted = await instance.receive(input("unsafe-group"));
    await instance.drain();
    expect(execute).not.toHaveBeenCalled();
    expect((await instance.getRun(owner(), accepted.run.id)).status).toBe("failed");
  });

  it("records ambiguous adapter rejection as unknown without leaking provider diagnostics", async () => {
    const { store } = await fixture();
    const { instance, events, errors } = service(store, {
      supportsGroup: true,
      execute: async () => {
        throw new Error("SECRET-DIAGNOSTIC-42");
      },
    });
    await instance.start();
    const accepted = await instance.receive(input("throws"));
    await instance.drain();
    expect(await instance.getRun(owner(), accepted.run.id)).toMatchObject({
      status: "unknown",
      resultText: null,
    });
    expect(
      JSON.stringify({
        events,
        errors,
        deliveries: await store.lifecycle.listDeliveries(owner(), accepted.run.id),
      }),
    ).not.toContain("SECRET-DIAGNOSTIC-42");
  });

  it("names the cause a thrown executor recorded instead of repeating the terminal status", async () => {
    const { store } = await fixture();
    const send = vi.fn(async (): Promise<{ status: "sent" }> => ({ status: "sent" }));
    const { instance } = service(
      store,
      {
        supportsGroup: true,
        execute: async () => {
          throw new Error("SECRET-DIAGNOSTIC-42");
        },
      },
      { send },
    );
    await instance.start();
    const accepted = await instance.receive(input("threw"));
    await instance.drain();
    expect(await instance.getRun(owner(), accepted.run.id)).toMatchObject({
      status: "unknown",
      failureCode: "execution_threw",
    });
    const delivered = (await store.lifecycle.listDeliveries(owner(), accepted.run.id)).items;
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.payloadText).toBe(
      "执行这次请求的进程中途出错了，没有产出结果。请稍后重试。",
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("delivers the line the recorded cause selects, and never an empty message", async () => {
    const { store } = await fixture();
    const send = vi.fn(async (): Promise<{ status: "sent" }> => ({ status: "sent" }));
    const execute = vi
      .fn<RunExecutionAdapter["execute"]>()
      .mockResolvedValueOnce({
        status: "failed",
        failureCode: "required_evidence_missing",
        text: "未能从 QQ 获取该信息，因此无法确认。",
      })
      .mockResolvedValueOnce({ status: "failed", failureCode: "execution_threw" })
      .mockResolvedValueOnce({ status: "unknown", text: "" });
    const { instance } = service(store, { supportsGroup: true, execute }, { send });
    await instance.start();

    const carried = await instance.receive(input("carried-cause"));
    await instance.drain();
    expect(
      (await store.lifecycle.listDeliveries(owner(), carried.run.id)).items[0]?.payloadText,
    ).toBe("未能从 QQ 获取该信息，因此无法确认。");

    // A cause recorded with no text still produces a sentence: the reader learns what went wrong
    // rather than being told the status code.
    const silent = await instance.receive(input("silent-cause"));
    await instance.drain();
    expect(
      (await store.lifecycle.listDeliveries(owner(), silent.run.id)).items[0]?.payloadText,
    ).toBe("执行这次请求的进程中途出错了，没有产出结果。请稍后重试。");

    // Blank text is not an answer. It falls through to the status line rather than being sent.
    const blank = await instance.receive(input("blank-text"));
    await instance.drain();
    expect(
      (await store.lifecycle.listDeliveries(owner(), blank.run.id)).items[0]?.payloadText,
    ).toBe("任务处理未完成，状态为 unknown。");
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("keeps the recorded cause when a result is forced to unknown", async () => {
    const { store } = await fixture();
    const execute = vi.fn<RunExecutionAdapter["execute"]>().mockResolvedValue({
      status: "failed",
      failureCode: "model_capacity_unknown",
      // Not a string: the result cannot stand as delivered text, but its cause still can.
      text: 42 as unknown as string,
    });
    const { instance } = service(store, { supportsGroup: true, execute });
    await instance.start();
    const accepted = await instance.receive(input("bad-text"));
    await instance.drain();
    expect(await instance.getRun(owner(), accepted.run.id)).toMatchObject({
      status: "unknown",
      resultText: null,
      failureCode: "model_capacity_unknown",
    });
    expect(
      (await store.lifecycle.listDeliveries(owner(), accepted.run.id)).items[0]?.payloadText,
    ).toBe("没能确认当前模型的上下文容量，因此没有发送给模型。请稍后重试。");
  });

  it("gives a reader a sentence for a stop that reported nothing", async () => {
    const { store } = await fixture();
    const { instance } = service(store, {
      supportsGroup: true,
      execute: async () => ({ status: "cancelled" }),
    });
    await instance.start();
    const accepted = await instance.receive(input("cancelled-silent"));
    await instance.drain();
    // Nobody asked for this stop, so the Run is an interruption rather than a cancellation, and
    // the reader is told it was interrupted rather than that they stopped it.
    expect(await instance.getRun(owner(), accepted.run.id)).toMatchObject({
      status: "interrupted",
    });
    expect(
      (await store.lifecycle.listDeliveries(owner(), accepted.run.id)).items[0]?.payloadText,
    ).toBe("这次执行被中断，没有给出结果。请稍后重试。");
  });

  it("explains every cause a failed Run can record, and only those", async () => {
    // The record is exhaustive by type, so a cause added to the union without a line for it fails
    // to compile rather than reaching a reader as "任务处理未完成，状态为 failed。" — a sentence
    // that says the Run produced nothing without saying why. The keys below are what makes that
    // true, and each one is then checked against the line the reader actually receives.
    const causes: Record<ExecutionFailureCode, true> = {
      pre_provider_context_overflow: true,
      model_capacity_unknown: true,
      model_capability_missing: true,
      model_credential_missing: true,
      gate_refused: true,
      execution_unavailable: true,
      required_action_not_completed: true,
      claimed_change_not_performed: true,
      required_evidence_missing: true,
      runtime_run_errored: true,
      execution_threw: true,
    };
    for (const [index, cause] of Object.keys(causes).entries()) {
      const { store } = await fixture();
      const execute = vi
        .fn<RunExecutionAdapter["execute"]>()
        .mockResolvedValue({ status: "failed", failureCode: cause as ExecutionFailureCode });
      const { instance } = service(store, { supportsGroup: true, execute });
      await instance.start();
      const accepted = await instance.receive(input(`cause-${index}`, `cause-${index}`));
      await instance.drain();
      const delivered = (await store.lifecycle.listDeliveries(owner(), accepted.run.id)).items;
      expect(delivered, cause).toHaveLength(1);
      // A real explanation names what went wrong; the generic line is the one it must not be.
      expect(delivered[0]!.payloadText, cause).not.toContain("任务处理未完成");
      expect(delivered[0]!.payloadText.length, cause).toBeGreaterThan(8);
    }
  });

  it("checks dispatch authority again after context loading", async () => {
    const { store, grants } = await fixture();
    const originalLoad = store.conversations.loadRunInput.bind(store.conversations);
    vi.spyOn(store.conversations, "loadRunInput").mockImplementation(async (...args) => {
      const loaded = await originalLoad(...args);
      await store.authorization.revoke(grants.get(scopeKey(group) + "run:create")!);
      return loaded;
    });
    const execute = vi.fn(async (): Promise<ExecutionResult> => ({ status: "succeeded" }));
    const { instance } = service(store, { supportsGroup: true, execute });
    await instance.start();
    const accepted = await instance.receive(input("revoke-before-dispatch"));
    await instance.drain();
    expect(execute).not.toHaveBeenCalled();
    expect(await instance.getRun(owner(), accepted.run.id)).toMatchObject({
      status: "failed",
      resultText: null,
    });
  });

  it("preserves explicit executor failure and rejects control from another channel scope", async () => {
    const { store } = await fixture();
    const { instance } = service(store, {
      supportsGroup: true,
      execute: async () => ({
        status: "failed",
        failureCode: "gate_refused",
        text: "Task failed without provider diagnostics.",
      }),
    });
    await instance.start();
    const accepted = await instance.receive(input("explicit-failure"));
    await expect(instance.cancel(owner(privateScope), accepted.run.id)).rejects.toMatchObject({
      decision: { decision: "DENY" },
    });
    await instance.drain();
    expect(await instance.getRun(owner(), accepted.run.id)).toMatchObject({
      status: "failed",
      resultText: "Task failed without provider diagnostics.",
    });
  });

  it("waits on terminal signals and immediately resolves already completed Runs", async () => {
    const { store } = await fixture();
    const control = controlledAdapter();
    const { instance } = service(store, control.adapter);
    await instance.start();
    const accepted = await instance.receive(input("wait-terminal"));
    await control.started("wait-terminal");
    const waiting = instance.waitForRun(owner(), accepted.run.id);
    control.finish("wait-terminal");
    expect(await waiting).toMatchObject({
      id: accepted.run.id,
      status: "succeeded",
      resultText: "answer:wait-terminal",
    });
    expect(await instance.waitForRun(owner(), accepted.run.id)).toMatchObject({
      status: "succeeded",
    });
    await instance.drain();
  });

  it("aborts only the waiting observer and cleans up before execution finishes", async () => {
    const { store } = await fixture();
    const control = controlledAdapter();
    const { instance } = service(store, control.adapter);
    await instance.start();
    const accepted = await instance.receive(input("abort-wait"));
    const execution = await control.started("abort-wait");
    const observer = new AbortController();
    const waiting = instance.waitForRun(owner(), accepted.run.id, { signal: observer.signal });
    const rejection = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    observer.abort();
    await rejection;
    expect(execution.signal.aborted).toBe(false);
    control.finish("abort-wait");
    await instance.drain();
    expect((await instance.getRun(owner(), accepted.run.id)).status).toBe("succeeded");
  });

  it("rejects waiting observers on shutdown and rechecks their channel scope", async () => {
    const { store } = await fixture();
    const control = controlledAdapter();
    const { instance } = service(store, control.adapter);
    await instance.start();
    const accepted = await instance.receive(input("stop-wait"));
    await control.started("stop-wait");
    await expect(instance.waitForRun(owner(privateScope), accepted.run.id)).rejects.toMatchObject({
      decision: { decision: "DENY" },
    });
    const waiting = instance.waitForRun(owner(), accepted.run.id);
    const rejection = expect(waiting).rejects.toThrow("Run service stopped");
    await instance.stop();
    await rejection;
    control.finish("stop-wait");
    await instance.drain();
  });
});

describe("durable result delivery and recovery", () => {
  it("publishes a cancellation control reply while the executor is still stopping", async () => {
    const { store } = await fixture();
    const control = controlledAdapter();
    const destinations: TrustedChannelScope[] = [];
    const texts: string[] = [];
    const { instance } = service(store, control.adapter, {
      send: async ({ destination, delivery }) => {
        if (delivery.payloadKind === "text") {
          destinations.push(destination);
          texts.push(delivery.payloadText);
        }
        return { status: "sent" };
      },
    });
    await instance.start();
    const accepted = await instance.receive(input("control-active"));
    await control.started("control-active");
    try {
      expect((await instance.cancel(owner(), accepted.run.id)).status).toBe("cancelling");
      const command = {
        messageId: "cancel-command",
        text: "任务正在取消。",
        destination: privateScope,
      };
      await instance.publishControlReply(owner(), accepted.run.id, command);
      expect((await instance.getRun(owner(), accepted.run.id)).status).toBe("cancelling");
      expect(control.calls).toHaveLength(1);
      expect(texts).toEqual(["任务正在取消。"]);
      expect(destinations).toEqual([group]);
      expect(
        (await store.conversations.listMessages(owner(), accepted.conversation.id)).items,
      ).toHaveLength(1);
      expect(
        await store.lifecycle.findDelivery(owner(), accepted.run.id, "control:cancel-command"),
      ).toMatchObject({
        status: "sent",
        destinationScopeKey: scopeKey(group),
        payloadKind: "text",
      });
    } finally {
      control.finish("control-active", { status: "cancelled" });
      await instance.drain();
    }
  });

  it.each(["sent", "unknown", "failed"] as const)(
    "does not automatically resend a %s control reply or replace its persisted text",
    async (status) => {
      const { store } = await fixture();
      let controls = 0;
      const { instance } = service(
        store,
        { supportsGroup: true, execute: async () => ({ status: "succeeded", text: "done" }) },
        {
          send: async ({ delivery }) => {
            if (delivery.payloadKind !== "text") return { status: "sent" };
            controls++;
            return { status };
          },
        },
      );
      await instance.start();
      const accepted = await instance.receive(input("control-dedup"));
      await instance.drain();
      await Promise.all(
        Array.from({ length: 4 }, () =>
          instance.publishControlReply(owner(), accepted.run.id, {
            messageId: "status-command",
            text: "固定状态回执。",
          }),
        ),
      );
      await instance.publishControlReply(owner(), accepted.run.id, {
        messageId: "status-command",
        text: "重放时改变的状态。",
      });
      expect(controls).toBe(1);
      expect(
        await store.lifecycle.findDelivery(owner(), accepted.run.id, "control:status-command"),
      ).toMatchObject({ status, payloadText: "固定状态回执。" });
      expect(
        (await store.conversations.listRuns(owner(), accepted.conversation.id)).items,
      ).toHaveLength(1);
    },
  );

  it("enforces scope and current authorization before persisting a control reply", async () => {
    const { store, grants } = await fixture();
    let controls = 0;
    const { instance } = service(
      store,
      { supportsGroup: true, execute: async () => ({ status: "succeeded" }) },
      {
        send: async ({ delivery }) => {
          if (delivery.payloadKind === "text") controls++;
          return { status: "sent" };
        },
      },
    );
    await instance.start();
    const accepted = await instance.receive(input("control-denied"));
    await instance.drain();
    const reply = { messageId: "denied-command", text: "固定状态。" };
    await expect(
      instance.publishControlReply(owner(privateScope), accepted.run.id, reply),
    ).rejects.toMatchObject({ decision: { decision: "DENY" } });
    await store.authorization.revoke(grants.get(scopeKey(group) + "run:control")!);
    await expect(
      instance.publishControlReply(owner(), accepted.run.id, reply),
    ).rejects.toMatchObject({ decision: { decision: "DENY" } });
    expect(controls).toBe(0);
    expect(
      await store.lifecycle.findDelivery(owner(), accepted.run.id, "control:denied-command"),
    ).toBeNull();
  });

  it("retries only an explicit failed send using its original persisted payload", async () => {
    const { store } = await fixture();
    let resultSends = 0;
    const payloads: string[] = [];
    const { instance } = service(
      store,
      {
        supportsGroup: true,
        execute: async () => ({ status: "succeeded", text: "immutable-result" }),
      },
      {
        send: async ({ delivery }) => {
          if (delivery.payloadKind === "ack") return { status: "sent" };
          payloads.push(delivery.payloadText);
          return ++resultSends === 1
            ? { status: "failed" }
            : { status: "sent", externalId: "confirmed" };
        },
      },
    );
    await instance.start();
    const accepted = await instance.receive(input("retry-send"));
    await instance.drain();
    await instance.enqueueAccepted({ ...accepted, duplicate: true });
    await instance.drain();
    expect(resultSends).toBe(1);
    const delivery = (await store.lifecycle.listDeliveries(owner(), accepted.run.id)).items.find(
      (item) => item.payloadKind === "result",
    )!;
    expect(delivery.status).toBe("failed");
    await instance.retryDelivery(owner(), accepted.run.id, delivery.id);
    expect(payloads).toEqual(["immutable-result", "immutable-result"]);
    expect(
      (await store.lifecycle.listDeliveries(owner(), accepted.run.id)).items.find(
        (item) => item.id === delivery.id,
      ),
    ).toMatchObject({ status: "sent", externalId: "confirmed" });
    await expect(instance.retryDelivery(owner(), accepted.run.id, delivery.id)).rejects.toThrow();
  });

  it("does not retry unknown sends across a real process and database restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "glassbox-run-service-"));
    directories.push(directory);
    const databasePath = join(directory, "state.db");
    const fixturePath = fileURLToPath(new URL("./recovery-fixture.ts", import.meta.url));
    const child = promisify(execFile);
    const written = await child(
      process.execPath,
      ["--import", "tsx", fixturePath, "write", databasePath],
      { timeout: 15_000 },
    );
    const record: unknown = JSON.parse(written.stdout);
    if (
      typeof record !== "object" ||
      record === null ||
      !("runId" in record) ||
      !("deliveryId" in record) ||
      typeof record.runId !== "string" ||
      typeof record.deliveryId !== "string"
    )
      throw new Error("Invalid recovery fixture result");
    await child(
      process.execPath,
      ["--import", "tsx", fixturePath, "reopen", databasePath, record.runId, record.deliveryId],
      { timeout: 15_000 },
    );
  }, 30_000);

  it("persists a confirmed delivery outcome even when authority is revoked during the send", async () => {
    const { store, grants } = await fixture();
    const sendStarted = deferred<void>();
    const sendFinished = deferred<{ status: "sent"; externalId: string }>();
    const { instance } = service(
      store,
      { supportsGroup: true, execute: async () => ({ status: "succeeded", text: "result" }) },
      {
        send: async ({ delivery }) => {
          if (delivery.payloadKind === "ack") return { status: "sent" };
          sendStarted.resolve();
          return sendFinished.promise;
        },
      },
    );
    await instance.start();
    const accepted = await instance.receive(input("revoke-send"));
    await sendStarted.promise;
    await store.authorization.revoke(grants.get(scopeKey(group) + "run:control")!);
    sendFinished.resolve({ status: "sent", externalId: "observed-send" });
    await instance.drain();
    expect(
      (await store.lifecycle.listDeliveries(owner(), accepted.run.id)).items.find(
        (item) => item.payloadKind === "result",
      ),
    ).toMatchObject({ status: "sent", externalId: "observed-send" });
  });

  it("times out a send to unknown without assuming that abort prevented delivery", async () => {
    const { store } = await fixture();
    vi.useFakeTimers();
    const sendStarted = deferred<AbortSignal>();
    const { instance } = service(
      store,
      { supportsGroup: true, execute: async () => ({ status: "succeeded", text: "result" }) },
      {
        send: async ({ delivery, signal }) => {
          if (delivery.payloadKind === "ack") return { status: "sent" };
          sendStarted.resolve(signal);
          return new Promise(() => {});
        },
      },
      { deliveryTimeoutMs: 50 },
    );
    await instance.start();
    const accepted = await instance.receive(input("timeout-send"));
    const signal = await sendStarted.promise;
    await vi.advanceTimersByTimeAsync(50);
    await instance.drain();
    expect(signal.aborted).toBe(true);
    expect(
      (await store.lifecycle.listDeliveries(owner(), accepted.run.id)).items.find(
        (item) => item.payloadKind === "result",
      )?.status,
    ).toBe("unknown");
  });

  it("recovers execution facts and queued work without replaying active or uncertain work", async () => {
    const { store } = await fixture();
    const prior = await store.conversations.acceptIncoming(input("old-running"));
    await store.lifecycle.transitionRun(owner(), prior.run.id, "queued", "running");
    const cancelling = await store.conversations.acceptIncoming(
      input("old-cancelling", "old-cancelling", privateScope),
    );
    await store.lifecycle.transitionRun(
      owner(privateScope),
      cancelling.run.id,
      "queued",
      "running",
    );
    await store.lifecycle.transitionRun(
      owner(privateScope),
      cancelling.run.id,
      "running",
      "cancelling",
    );
    const oldSend = await store.lifecycle.createDelivery(owner(), {
      runId: prior.run.id,
      dedupKey: "ack",
      destination: group,
      payloadText: `已接收任务 ${prior.run.id}`,
      payloadKind: "ack",
    });
    await store.lifecycle.transitionDelivery(owner(), prior.run.id, oldSend, "pending", "sending");
    const queued = await store.conversations.acceptIncoming(input("surviving-queue"));
    const calls: string[] = [];
    const { instance, events } = service(store, {
      supportsGroup: true,
      execute: async (request) => {
        calls.push(request.text);
        return { status: "succeeded", text: "recovered queue result" };
      },
    });
    await instance.start({ recover: true });
    await instance.drain();
    expect(calls).toEqual(["surviving-queue"]);
    expect((await instance.getRun(owner(), prior.run.id)).status).toBe("interrupted");
    expect((await instance.getRun(owner(privateScope), cancelling.run.id)).status).toBe("unknown");
    expect((await instance.getRun(owner(), queued.run.id)).status).toBe("succeeded");
    expect(
      (await store.lifecycle.listDeliveries(owner(), prior.run.id)).items.find(
        (item) => item.id === oldSend,
      )?.status,
    ).toBe("unknown");
    expect(events).toContainEqual({
      type: "recovered",
      interruptedRunIds: [prior.run.id],
      unknownRunIds: [cancelling.run.id],
      unknownDeliveryIds: [oldSend],
    });
    await expect(instance.recover()).rejects.toThrow("Cannot recover active execution");
  });

  it("does not reuse a persisted native admin role when starting with queued work", async () => {
    const { store } = await fixture();
    const observedAdminScope: TrustedChannelScope = {
      ...group,
      nativeGroupRole: {
        role: "qq_group_admin",
        source: "onebot_message_sender",
        observedAt: "2026-09-23T01:02:03.000Z",
      },
    };
    const recovered = await store.conversations.acceptIncoming(
      input("queued-admin-before-restart", "queued admin request", observedAdminScope),
    );

    const executionScopes: Array<TrustedChannelScope["nativeGroupRole"]> = [];
    const { instance } = service(store, {
      supportsGroup: true,
      execute: async (request) => {
        executionScopes.push(request.caller.scope.nativeGroupRole);
        return { status: "succeeded", text: "resumed" };
      },
    });

    await instance.start();
    await instance.drain();

    expect(executionScopes).toEqual([undefined]);
    const persistedRoute = await store.lifecycle.listRunRoutes(["succeeded"]);
    expect(
      persistedRoute.find((route) => route.runId === recovered.run.id)?.caller.scope
        .nativeGroupRole,
    ).toEqual(observedAdminScope.nativeGroupRole);

    const currentMemberScope: TrustedChannelScope = {
      ...group,
      nativeGroupRole: {
        role: "qq_group_member",
        source: "onebot_message_sender",
        observedAt: "2026-09-23T01:03:03.000Z",
      },
    };
    await instance.receive(
      input("fresh-member-after-restart", "member request", currentMemberScope),
    );
    await instance.drain();

    expect(executionScopes).toEqual([undefined, currentMemberScope.nativeGroupRole]);
    await instance.stop({ wait: true });
  });

  it("publishes an already persisted pending result without rebuilding its payload", async () => {
    const { store } = await fixture();
    const accepted = await store.conversations.acceptIncoming(input("pending-original"));
    await store.lifecycle.transitionRun(owner(), accepted.run.id, "queued", "running");
    await store.lifecycle.transitionRun(
      owner(),
      accepted.run.id,
      "running",
      "succeeded",
      "original full result",
    );
    const deliveryId = await store.lifecycle.createDelivery(owner(), {
      runId: accepted.run.id,
      dedupKey: "result",
      destination: group,
      payloadText: "persisted transport projection",
      payloadKind: "result",
    });
    const send = vi.fn(async (): Promise<{ status: "sent" }> => ({ status: "sent" }));
    const execute = vi.fn(async (): Promise<ExecutionResult> => ({ status: "succeeded" }));
    const { instance } = service(store, { supportsGroup: true, execute }, { send });
    await instance.start({ recover: true });
    await instance.drain();
    expect(execute).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery: expect.objectContaining({
          id: deliveryId,
          payloadText: "persisted transport projection",
        }),
      }),
    );
    expect((await store.lifecycle.findDelivery(owner(), accepted.run.id, "result"))?.status).toBe(
      "sent",
    );
  });

  it("allows each execution and delivery lease to record its terminal fact once", async () => {
    const { store } = await fixture();
    const accepted = await store.conversations.acceptIncoming(input("lease-replay"));
    const runLease = await store.lifecycle.claimQueuedRun(owner(), accepted.run.id);
    await runLease.settle("succeeded", "done");
    await expect(runLease.settle("failed")).rejects.toThrow("already settled");
    const deliveryId = await store.lifecycle.createDelivery(owner(), {
      runId: accepted.run.id,
      dedupKey: "result",
      destination: group,
      payloadText: "done",
      payloadKind: "result",
    });
    const sendLease = await store.lifecycle.claimDelivery(owner(), accepted.run.id, deliveryId);
    expect(sendLease).not.toBeNull();
    await sendLease!.settle("sent", "one-send");
    await expect(sendLease!.settle("unknown")).rejects.toThrow("already settled");
    expect(await store.lifecycle.claimDelivery(owner(), accepted.run.id, deliveryId)).toBeNull();
  });
});

describe("restart publication window", () => {
  /** A Run still marked running, as a process that died mid-flight would have left it. */
  async function runLeftRunning(text: string) {
    const { store } = await fixture();
    const accepted = await store.conversations.acceptIncoming(input(text));
    await store.lifecycle.transitionRun(owner(), accepted.run.id, "queued", "running");
    return { store, runId: accepted.run.id };
  }

  /** Settles the Run at a fixed moment so the test controls how stale it is at restart. */
  async function settleAt(store: DomainStore, runId: string, at: string, answer: string) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(at));
    await store.lifecycle.transitionRun(owner(), runId, "running", "succeeded", answer);
  }

  it("publishes a Run that finished shortly before the restart", async () => {
    const { store, runId } = await runLeftRunning("recent-finish");
    await settleAt(store, runId, "2026-09-29T10:00:00.000Z", "answer nobody sent yet");
    const send = vi.fn(async (): Promise<SendOutcome> => ({ status: "sent" }));
    const { instance } = service(
      store,
      {
        supportsGroup: true,
        execute: async (): Promise<ExecutionResult> => ({ status: "succeeded" }),
      },
      { send },
    );
    // The process died between settling the Run and creating its delivery. That gap is the
    // whole reason a restart republishes at all.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await instance.start({ recover: true });
    await instance.drain();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery: expect.objectContaining({ payloadText: "answer nobody sent yet" }),
      }),
    );
    expect((await store.lifecycle.findDelivery(owner(), runId, "result"))?.status).toBe("sent");
  });

  it("leaves a Run that finished long before the restart unpublished", async () => {
    const { store, runId } = await runLeftRunning("stale-finish");
    await settleAt(store, runId, "2026-09-29T10:00:00.000Z", "an answer from last week");
    const send = vi.fn(async (): Promise<SendOutcome> => ({ status: "sent" }));
    const { instance } = service(
      store,
      {
        supportsGroup: true,
        execute: async (): Promise<ExecutionResult> => ({ status: "succeeded" }),
      },
      { send },
    );
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    await instance.start({ recover: true });
    await instance.drain();
    // Nobody has waited three hours for this. The process was alive when it settled and
    // recorded its outcome, so a restart is not a second chance to send it.
    expect(send).not.toHaveBeenCalled();
    expect(await store.lifecycle.findDelivery(owner(), runId, "result")).toBeNull();
    expect(
      await store.lifecycle.listRestorableRunRoutes(["succeeded"], 0, {
        windowMs: 2 * 60 * 60 * 1000,
        now: new Date("2026-09-29T13:00:00.000Z"),
      }),
    ).toEqual([]);
  });

  it("finishes a delivery left in flight however long ago the Run finished", async () => {
    const { store, runId } = await runLeftRunning("stranded-delivery");
    await settleAt(store, runId, "2026-09-29T10:00:00.000Z", "answer still in flight");
    await store.lifecycle.createDelivery(owner(), {
      runId,
      dedupKey: "result",
      destination: group,
      payloadText: "answer still in flight",
      payloadKind: "result",
    });
    const send = vi.fn(async (): Promise<SendOutcome> => ({ status: "sent" }));
    const { instance } = service(
      store,
      {
        supportsGroup: true,
        execute: async (): Promise<ExecutionResult> => ({ status: "succeeded" }),
      },
      { send },
    );
    // A send that never settled is unfinished work, not an old answer: the transport went
    // away underneath it and the restart owes the reader the outcome.
    await vi.advanceTimersByTimeAsync(30 * 60 * 60 * 1000);
    await instance.start({ recover: true });
    await instance.drain();
    expect(send).toHaveBeenCalledTimes(1);
    expect((await store.lifecycle.findDelivery(owner(), runId, "result"))?.status).toBe("sent");
  });

  it("rejects a restore window that is not a usable duration", async () => {
    const { store } = await fixture();
    for (const restoreWindowMs of [-1, 1.5, Number.NaN, 8 * 24 * 60 * 60 * 1000]) {
      expect(
        () =>
          new RunService({
            store,
            resolveExecution: () => undefined,
            transport: { send: async () => ({ status: "sent" }) },
            restoreWindowMs,
          }),
      ).toThrow("Invalid restore window");
    }
  });
});
