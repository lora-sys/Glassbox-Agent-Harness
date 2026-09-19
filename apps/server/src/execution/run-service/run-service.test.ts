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
  type ExecutionInput,
  type ExecutionResult,
  type RunExecutionAdapter,
  type RunServiceEvent,
  type RunTransport,
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
    deliveryTimeoutMs?: number;
    prepareDelivery?: ConstructorParameters<typeof RunService>[0]["prepareDelivery"];
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
