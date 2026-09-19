import { mkdtemp, rm, cp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "typebox";
import { expect, it } from "vite-plus/test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { openDomainStore } from "../../persistence/index.js";
import { PiSdkRuntimeAdapter } from "./adapter.js";
import { createProtectedTool } from "./protected-tools.js";
import { createOpsTools } from "./ops-tools.js";
import { FakeHerdrBridge } from "../../ops/fake-herdr-bridge.js";
import { OpsReconciler } from "../../ops/reconciler.js";
import { AuthorizedOpsService } from "../../ops/service.js";
import { grantOpsPermissions } from "../../management/ops-grants.js";

it("runs delegate, review, rework and accept through actual Pi SDK Ops tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-sdk-ops-"));
  const store = await openDomainStore({ databasePath: ":memory:" });
  const caller = {
    principalId: "owner",
    scope: {
      connectionId: "qq",
      botId: "bot",
      chatType: "private" as const,
      chatId: "owner",
      senderId: "owner",
    },
  };
  const bridge = new FakeHerdrBridge("sdk-ops");
  const reconciler = new OpsReconciler(store.tasks, bridge);
  const service = new AuthorizedOpsService(store, bridge);
  const prompt = bridge.promptAgent.bind(bridge);
  bridge.promptAgent = async (input) => {
    await prompt(input);
    await reconciler.reconcileSnapshot(await bridge.getSnapshot());
    bridge.simulateAgentState(input.paneId, "idle", "Worker result for review");
    await reconciler.reconcileSnapshot(await bridge.getSnapshot());
  };
  const models = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(directory, "models-cache"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  let calls = 0;
  let taskId = "";
  models.registerProvider("local-ops", {
    api: "openai-completions",
    apiKey: "fixture",
    baseUrl: "http://127.0.0.1:1",
    models: [
      {
        id: "local",
        name: "Local",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 16384,
        maxTokens: 512,
      },
    ],
    streamSimple(model, context) {
      calls++;
      const results = context.messages.filter((message) => message.role === "toolResult");
      const last = results.at(-1);
      if (calls > 1) {
        expect(last?.isError).not.toBe(true);
        if (calls === 2 || calls === 3) {
          const value = JSON.parse(
            last!.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join(""),
          );
          expect(value.status).toBe("REVIEW");
          if (calls === 2) taskId = value.id;
          else expect(value.id).toBe(taskId);
        }
      }
      const actions = [
        {
          name: "task_delegate",
          arguments: { title: "SDK Ops fixture", prompt: "Prepare a result" },
        },
        {
          name: "task_rework",
          arguments: { taskId, reason: "Add a check", prompt: "Revise the result" },
        },
        { name: "worker_read", arguments: { taskId } },
        { name: "task_accept", arguments: { taskId } },
      ];
      const action = actions[calls - 1];
      const message: AssistantMessage = {
        role: "assistant",
        content: action
          ? [{ type: "toolCall", id: `ops-${calls}`, ...action }]
          : [{ type: "text", text: "Accepted after rework" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: action ? "toolUse" : "stop",
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: action ? "toolUse" : "stop", message });
      stream.end(message);
      return stream;
    },
  });
  const kitPath = join(directory, "kit");
  await cp(fileURLToPath(new URL("./fixtures/lora-pi-kit", import.meta.url)), kitPath, {
    recursive: true,
  });
  const profilePath = join(kitPath, "profiles/main-agent.json");
  const profile = JSON.parse(await readFile(profilePath, "utf8"));
  profile.enabledExtensions = ["mcp/tool-adapter"];
  await writeFile(profilePath, JSON.stringify(profile));
  await mkdir(join(kitPath, "extensions/mcp"), { recursive: true });
  await writeFile(
    join(kitPath, "extensions/mcp/tool-adapter.ts"),
    'throw new Error("Unselected MCP adapter executed");',
  );
  const adapter = new PiSdkRuntimeAdapter({
    kitPath,
    runtimeBaseDir: directory,
    cwd: directory,
    modelRuntime: models,
    model: models.getModel("local-ops", "local")!,
    createTools: (getContext) =>
      createOpsTools({
        store,
        service,
        getContext,
        workerTarget: { workspaceId: "test", agentKind: "pi", worktreePath: directory },
      }),
  });
  try {
    await store.identities.bindOwner("owner", caller.scope);
    await store.conversations.createAgent("personal");
    for (const action of ["run:create", "trace:write"])
      await store.authorization.grant({
        principalId: "owner",
        resourceId: "agent:personal",
        action,
        scope: caller.scope,
        effect: "allow",
      });
    const accepted = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: caller.scope,
      messageId: "fixture",
      text: "Delegate and review",
      executionRef: "pi:fixture",
    });
    await grantOpsPermissions(store, undefined, {
      runId: accepted.run.id,
      actions: ["task:delegate", "task:rework", "worker:prompt", "worker:read", "task:accept"],
    });
    await adapter.initialize();
    const binding = await adapter.createOrRestoreSession(
      {
        id: accepted.conversation.id,
        agentId: "personal",
        principalId: "owner",
        resourceId: "conversation-resource",
        scope: {
          channel: "qq",
          scopeType: "direct",
          scopeKey: "private",
          chatId: "owner",
          connectionId: "qq",
        },
        createdAt: new Date().toISOString(),
      },
      "main-agent",
    );
    const result = await adapter.run(
      binding,
      { ...accepted.run, principalId: "owner" },
      "Delegate, review, rework and accept",
      { caller, runId: accepted.run.id, conversationId: accepted.conversation.id },
    );
    expect(result).toMatchObject({ status: "completed", text: "Accepted after rework" });
    expect(calls).toBe(5);
    expect((await store.tasks.getTask(taskId))?.status).toBe("DONE");
    const attempts = await store.tasks.listAttempts(taskId);
    expect(attempts).toHaveLength(2);
    const bindings = await Promise.all(
      attempts.map((attempt) => store.tasks.getWorkerBinding(attempt.id)),
    );
    expect(new Set(bindings.map((entry) => entry?.paneId)).size).toBe(2);
    expect(bindings.every((entry) => entry?.agentKind === "pi")).toBe(true);
    const trace = await store.tasks.listTraceEvents({ taskId });
    expect(
      trace.filter(
        (entry) => entry.type === "worker.state_observed" && entry.data.status === "REVIEW",
      ),
    ).toHaveLength(2);
    expect(trace.some((entry) => entry.type === "task.accepted")).toBe(true);
    expect(
      (
        await store.authorization.check({
          caller,
          resourceId: `task-${taskId}`,
          action: "delivery:send",
        })
      ).decision,
    ).toBe("DENY");
  } finally {
    await adapter.cleanup();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

it.each(
  [
    { discovered: true, granted: true },
    { discovered: true, granted: false },
    { discovered: false, granted: true },
  ].flatMap((permissions) =>
    (process.env.GLASSBOX_TEST_KIT_PATH ? ["local", "mcp"] : ["local"]).map((transport) => ({
      ...permissions,
      transport,
    })),
  ),
)(
  "enforces discovered=$discovered granted=$granted through an actual Pi SDK $transport tool call",
  async ({ discovered, granted, transport }) => {
    const directory = await mkdtemp(join(tmpdir(), "glassbox-sdk-tool-"));
    const store = await openDomainStore({ databasePath: ":memory:" });
    const caller = {
      principalId: "owner",
      scope: {
        connectionId: "qq",
        botId: "bot",
        chatType: "private" as const,
        chatId: "owner",
        senderId: "owner",
      },
    };
    const models = await ModelRuntime.create({
      authPath: join(directory, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(directory, "models-cache"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    let calls = 0;
    let executions = 0;
    let mcp:
      | {
          callTool(
            name: string,
            params: Record<string, unknown>,
          ): Promise<{ content: Array<{ text?: string }> }>;
          stop(): Promise<void>;
        }
      | undefined;
    if (transport === "mcp") {
      const kit = process.env.GLASSBOX_TEST_KIT_PATH!;
      const { StdioMcpClient } = await import(
        pathToFileURL(join(kit, "dist/extensions/mcp/client.js")).href
      );
      mcp = new StdioMcpClient(
        process.execPath,
        [join(kit, "tests/fixtures/test-mcp-server.js")],
        {},
        directory,
      );
    }
    models.registerProvider("bounded-tools", {
      api: "openai-completions",
      apiKey: "fixture",
      baseUrl: "http://127.0.0.1:1",
      models: [
        {
          id: "local",
          name: "Local",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 256,
        },
      ],
      streamSimple(model, context) {
        calls++;
        expect(context.tools?.map((tool) => tool.name) ?? []).toEqual(
          discovered ? ["protected_read"] : [],
        );
        if (calls > 1) {
          const result = context.messages.find((message) => message.role === "toolResult");
          expect(result).toBeDefined();
          expect(JSON.stringify(result).includes("PRIVATE_CANARY_7F92A1")).toBe(granted);
          expect(JSON.stringify(result).includes("no_grant")).toBe(!granted);
        }
        const message: AssistantMessage = {
          role: "assistant",
          content: !discovered
            ? [{ type: "text", text: "No authorized tool" }]
            : calls === 1
              ? [{ type: "toolCall", id: "read-1", name: "protected_read", arguments: {} }]
              : [{ type: "text", text: "Checked" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: discovered && calls === 1 ? "toolUse" : "stop",
          timestamp: Date.now(),
        };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
        stream.end(message);
        return stream;
      },
    });
    const adapter = new PiSdkRuntimeAdapter({
      kitPath:
        process.env.GLASSBOX_TEST_KIT_PATH ??
        fileURLToPath(new URL("./fixtures/lora-pi-kit", import.meta.url)),
      runtimeBaseDir: directory,
      cwd: directory,
      modelRuntime: models,
      model: models.getModel("bounded-tools", "local")!,
      createTools: (context) => [
        createProtectedTool({
          name: "protected_read",
          description: "Read protected fixture",
          parameters: Type.Object({}),
          action: "read",
          resourceId: "canary",
          authService: store.authorization,
          getContext: () => {
            const current = context();
            return current?.caller && current.runId && current.conversationId
              ? {
                  caller: current.caller,
                  runId: current.runId,
                  conversationId: current.conversationId,
                }
              : undefined;
          },
          execute: async () => {
            executions++;
            if (mcp) {
              const response = await mcp.callTool("test_echo", {
                message: "PRIVATE_CANARY_7F92A1",
              });
              return response.content.map((part) => part.text ?? "").join("");
            }
            return "PRIVATE_CANARY_7F92A1";
          },
        }),
      ],
      resolveToolNames: async () => (discovered ? ["protected_read"] : []),
    });
    try {
      await store.identities.bindOwner("owner", caller.scope);
      await store.conversations.createAgent("personal");
      await store.authorization.grant({
        principalId: "owner",
        resourceId: "agent:personal",
        action: "run:create",
        scope: caller.scope,
        effect: "allow",
      });
      await store.authorization.registerResource({
        id: "canary",
        kind: "fixture",
        visibility: "private",
        ownerId: "owner",
      });
      if (granted)
        await store.authorization.grant({
          principalId: "owner",
          resourceId: "canary",
          action: "read",
          scope: caller.scope,
          effect: "allow",
        });
      const accepted = await store.conversations.acceptIncoming({
        agentId: "personal",
        scope: caller.scope,
        messageId: "fixture",
        text: "Read",
        executionRef: "pi:fixture",
      });
      await adapter.initialize();
      const binding = await adapter.createOrRestoreSession(
        {
          id: accepted.conversation.id,
          agentId: "personal",
          principalId: "owner",
          resourceId: "conversation-resource",
          scope: {
            channel: "qq",
            scopeType: "direct",
            scopeKey: "private",
            chatId: "owner",
            connectionId: "qq",
          },
          createdAt: new Date().toISOString(),
        },
        "main-agent",
        { caller, runId: accepted.run.id, conversationId: accepted.conversation.id },
      );
      const result = await adapter.run(
        binding,
        { ...accepted.run, principalId: "owner" },
        "Read fixture",
        { caller, runId: accepted.run.id, conversationId: accepted.conversation.id },
      );
      expect(result).toMatchObject({
        status: "completed",
        text: discovered ? "Checked" : "No authorized tool",
      });
      expect(calls).toBe(discovered ? 2 : 1);
      expect(executions).toBe(discovered && granted ? 1 : 0);
    } finally {
      await adapter.cleanup();
      await mcp?.stop();
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  20_000,
);
