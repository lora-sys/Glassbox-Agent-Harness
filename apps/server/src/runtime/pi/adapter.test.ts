import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentRun, Conversation } from "@glassbox/contracts";
import type {
  AgentSessionEvent,
  ModelRuntime,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { glassboxSystemPrompt, PiSdkRuntimeAdapter } from "./adapter.js";

it("does not treat a context-hidden tool as an unimplemented product capability", () => {
  const prompt = glassboxSystemPrompt("Base prompt");
  expect(prompt).toContain("A tool missing from the current Run does not mean");
  expect(prompt).toContain("unavailable in the current context");
  expect(prompt).toContain("Never invent an unimplemented status");
  expect(prompt).toContain("Follow the response shape and fields the user explicitly requested");
  expect(prompt).toContain("do not narrate Tool names");
  expect(prompt).toContain("do not add unrequested diagnostic sections");
});
import type { PiRunContext } from "./types.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it("fails initialization when the Kit adds a profile without a selection decision", async () => {
  const kitPath = fileURLToPath(new URL("./fixtures/lora-pi-kit", import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), "glassbox-kit-profile-drift-"));
  directories.push(directory);
  const { cp, mkdir, writeFile } = await import("node:fs/promises");
  await cp(kitPath, directory, { recursive: true });
  await mkdir(join(directory, "profiles"), { recursive: true });
  await writeFile(
    join(directory, "profiles/brand-new.json"),
    JSON.stringify({ name: "brand-new" }),
  );

  const adapter = new PiSdkRuntimeAdapter({ kitPath: directory });
  await expect(adapter.initialize()).rejects.toThrow(/brand-new/u);
});

const conversation: Conversation = {
  id: "conversation-1",
  agentId: "personal",
  principalId: "owner",
  scope: {
    channel: "qq",
    scopeType: "direct",
    scopeKey: "qq-private-owner",
    chatId: "owner",
    connectionId: "qq",
  },
  resourceId: "conversation-resource-1",
  createdAt: new Date(0).toISOString(),
};

const run: AgentRun = {
  id: "run-1",
  conversationId: conversation.id,
  messageId: "message-1",
  principalId: "owner",
  executionRef: "pi",
  status: "running",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

describe("PiSdkRuntimeAdapter", () => {
  it("runs through the Pi session boundary and emits normalized events with an isolated Kit profile", async () => {
    const runtimeBaseDir = await mkdtemp(join(tmpdir(), "glassbox-pi-runtime-"));
    directories.push(runtimeBaseDir);
    const events: string[] = [];
    let authorizedTools: unknown;
    let authorizedSkills: unknown;
    let modelVisibleSkills: unknown;
    let skillPolicy: unknown;
    let safeToolCall: unknown;
    let safeToolResult: unknown;
    let listener: ((event: AgentSessionEvent) => void) | undefined;
    const fakeSession = {
      sessionId: "pi-session-1",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "hello from pi" }],
          stopReason: "stop",
        },
      ],
      subscribe(callback: (event: AgentSessionEvent) => void) {
        listener = callback;
        return () => {
          listener = undefined;
        };
      },
      async prompt() {
        listener?.({ type: "agent_start" });
        listener?.({ type: "turn_start" });
        listener?.({
          type: "message_update",
          message: {} as never,
          assistantMessageEvent: { type: "text_delta", delta: "hello from pi" } as never,
        });
        listener?.({
          type: "tool_execution_start",
          toolCallId: "admin-1",
          toolName: "owner_group_admin",
          args: {
            action: "set_capability",
            groupId: "1126022432",
            category: "group.settings",
            sourceClass: "history",
            enabled: true,
            ignored: "must-not-enter-trace",
          },
        } as never);
        listener?.({
          type: "tool_execution_end",
          toolCallId: "admin-1",
          toolName: "owner_group_admin",
          result: { content: [{ type: "text", text: "Schema validation failed" }] },
          isError: true,
        } as never);
        listener?.({ type: "turn_end", message: {} as never, toolResults: [] });
        listener?.({ type: "agent_end", messages: [], willRetry: false });
      },
      async abort() {},
      dispose() {},
    };

    const adapter = new PiSdkRuntimeAdapter({
      kitPath: fileURLToPath(new URL("./fixtures/lora-pi-kit", import.meta.url)),
      runtimeBaseDir,
      resolveToolNames: async () => ["owner_group_admin", "skill_read"],
      resolveSkillNames: async () => ({
        names: [],
        policy: { source: "group-profile", configVersion: 3 },
      }),
      onEvent: (event) => {
        events.push(event.type);
        if (event.type === "session_start") {
          authorizedTools = event.data.authorizedTools;
          authorizedSkills = event.data.authorizedSkills;
          modelVisibleSkills = event.data.modelVisibleSkills;
          skillPolicy = event.data.skillPolicy;
        }
        if (event.type === "tool_call") safeToolCall = event.data;
        if (event.type === "tool_result") safeToolResult = event.data;
      },
      createSession: async ({ profile, agentDir }) => {
        expect(profile.name).toBe("test");
        expect(profile.enabledSkills).toEqual([]);
        expect(profile.enabledMcpServers).toEqual([]);
        expect(agentDir.startsWith(runtimeBaseDir)).toBe(true);
        return fakeSession as never;
      },
    });

    await adapter.initialize();
    const context: PiRunContext = {
      runId: run.id,
      conversationId: conversation.id,
      caller: {
        principalId: "owner",
        scope: {
          connectionId: "qq",
          botId: "bot",
          chatType: "private" as const,
          chatId: "owner",
          senderId: "owner",
        },
      },
    };
    const binding = await adapter.createOrRestoreSession(conversation, "test", context);
    const result = await adapter.run(binding, run, "say hello", context);

    expect(binding.conversationId).toBe(conversation.id);
    expect(binding.runtimeSessionId).not.toBe(conversation.id);
    expect(result).toMatchObject({ status: "completed", text: "hello from pi" });
    expect(authorizedTools).toEqual(["owner_group_admin", "skill_read"]);
    // The resolved surface is handed back on the Run context too: the execution adapter binds
    // a required Tool only when this Run could really call it.
    expect(context.authorizedToolNames).toEqual(["owner_group_admin", "skill_read"]);
    expect(authorizedSkills).toEqual([]);
    expect(modelVisibleSkills).toEqual([]);
    expect(skillPolicy).toEqual({ source: "group-profile", configVersion: 3 });
    expect(safeToolCall).toMatchObject({
      name: "owner_group_admin",
      input: {
        action: "set_capability",
        groupId: "1126022432",
        category: "group.settings",
        sourceClass: "history",
        enabled: true,
      },
    });
    expect(JSON.stringify(safeToolCall)).not.toContain("must-not-enter-trace");
    expect(safeToolResult).toMatchObject({
      name: "owner_group_admin",
      isError: true,
      failureCode: "input_validation_failed",
    });
    expect(events).toEqual([
      "session_start",
      "turn_start",
      "message_chunk",
      "tool_call",
      "tool_result",
      "turn_end",
      "session_end",
    ]);
    await adapter.cleanup();
  });

  it("records the classified Tool surface as Run evidence so a Run can explain its own Tools", async () => {
    const runtimeBaseDir = await mkdtemp(join(tmpdir(), "glassbox-pi-runtime-"));
    directories.push(runtimeBaseDir);
    let surface: unknown;
    const fakeSession = {
      sessionId: "pi-session-surface",
      messages: [
        { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
      ],
      subscribe(callback: (event: AgentSessionEvent) => void) {
        listener = callback;
        return () => {
          listener = undefined;
        };
      },
      async prompt() {
        listener?.({ type: "agent_start" });
        listener?.({ type: "agent_end", messages: [], willRetry: false });
      },
      async abort() {},
      dispose() {},
    };
    let listener: ((event: AgentSessionEvent) => void) | undefined;
    let activeTools: unknown;

    const adapter = new PiSdkRuntimeAdapter({
      kitPath: fileURLToPath(new URL("./fixtures/lora-pi-kit", import.meta.url)),
      runtimeBaseDir,
      // The classified discovery path. `resolveToolNames` is deliberately absent, so a surface
      // that only existed for fakes would leave this undefined and fail here.
      resolveToolCandidates: async () => [
        { name: "qq_group_history", exclusion: null },
        { name: "group_history_search", exclusion: null },
        { name: "owner_group_admin", exclusion: "scope_not_permitted" },
        { name: "read", exclusion: "disabled_by_host" },
      ],
      resolveSkillNames: async () => ({ names: [] }),
      onEvent: (event) => {
        if (event.type === "session_start") surface = event.data.toolSurface;
      },
      createSession: async ({ profile }) => {
        expect(profile.activeTools).toEqual([]);
        activeTools = profile.activeTools;
        return fakeSession as never;
      },
    });

    await adapter.initialize();
    const context: PiRunContext = {
      runId: run.id,
      conversationId: conversation.id,
      caller: {
        principalId: "owner",
        scope: {
          connectionId: "qq",
          botId: "bot",
          chatType: "private" as const,
          chatId: "owner",
          senderId: "owner",
        },
      },
    };
    const binding = await adapter.createOrRestoreSession(conversation, "test", context);
    await adapter.run(binding, run, "say hello", context);

    expect(activeTools).toEqual([]);
    expect(context.authorizedToolNames).toEqual(["qq_group_history", "group_history_search"]);
    expect(surface).toMatchObject({
      profileName: "test",
      profileTools: [],
      selected: [
        // The provider's own answer about a group's history.
        {
          name: "qq_group_history",
          origin: "glassbox_domain",
          grounding: "direct_observation",
        },
        // Glassbox's own search over that history. Same subject, different evidence class:
        // this one supports a claim about what the search covered, not about the group.
        {
          name: "group_history_search",
          origin: "glassbox_domain",
          grounding: "derived_retrieval",
        },
      ],
      excluded: [
        { name: "owner_group_admin", reason: "scope_not_permitted" },
        { name: "read", reason: "disabled_by_host" },
      ],
      disabledByHost: [],
    });
    // The profile digest is real, so the recorded surface can be read against the exact
    // profile declaration it ran under rather than against whatever the Kit holds today.
    const version = (surface as { profileVersion: string }).profileVersion;
    expect(version).toMatch(/^[a-f0-9]{64}$/u);
    await adapter.cleanup();
  });

  it("sends exactly the selected Effective Tool Surface schemas to the Pi model context", async () => {
    const runtimeBaseDir = await mkdtemp(join(tmpdir(), "glassbox-pi-runtime-provider-context-"));
    directories.push(runtimeBaseDir);
    let capturedContext: { tools?: readonly { name: string }[] } | undefined;
    let surface:
      | {
          selected: readonly { name: string }[];
          excluded: readonly { name: string; reason: string }[];
        }
      | undefined;

    const model = {
      id: "fixture-model",
      name: "Fixture model",
      api: "openai-completions",
      provider: "fixture-provider",
      baseUrl: "http://fixture.invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_192,
      maxTokens: 256,
    } as never;

    const modelRuntime = {
      hasConfiguredAuth: () => true,
      checkAuth: async () => undefined,
      isUsingOAuth: () => false,
      streamSimple: (_model: unknown, context: { tools?: readonly { name: string }[] }) => {
        capturedContext = context;
        const stream = createAssistantMessageEventStream();
        const message = {
          role: "assistant",
          content: [{ type: "text", text: "fixture response" }],
          api: "openai-completions",
          provider: "fixture-provider",
          model: "fixture-model",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          stopReason: "stop",
          timestamp: Date.now(),
        } as never;
        queueMicrotask(() => {
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: "stop", message });
        });
        return stream;
      },
    } as unknown as ModelRuntime;

    const tool = (name: string): ToolDefinition => ({
      name,
      label: name,
      description: `Fixture ${name}`,
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
    });

    const adapter = new PiSdkRuntimeAdapter({
      kitPath: fileURLToPath(new URL("./fixtures/lora-pi-kit", import.meta.url)),
      runtimeBaseDir,
      model,
      modelRuntime,
      customTools: [tool("qq_group_history"), tool("owner_group_admin"), tool("read")],
      resolveToolCandidates: async () => [
        { name: "qq_group_history", exclusion: null },
        { name: "owner_group_admin", exclusion: "scope_not_permitted" },
        { name: "read", exclusion: "disabled_by_host" },
      ],
      resolveSkillNames: async () => ({ names: [] }),
      onEvent: (event) => {
        if (event.type === "session_start") surface = event.data.toolSurface as typeof surface;
      },
    });

    await adapter.initialize();
    const context: PiRunContext = {
      runId: run.id,
      conversationId: conversation.id,
      caller: {
        principalId: "owner",
        scope: {
          connectionId: "qq",
          botId: "bot",
          chatType: "private" as const,
          chatId: "owner",
          senderId: "owner",
        },
      },
    };
    const binding = await adapter.createOrRestoreSession(conversation, "test", context);
    await adapter.run(binding, run, "say hello", context);

    expect(surface).toBeDefined();
    expect(capturedContext?.tools?.map((entry) => entry.name)).toEqual(
      surface?.selected.map((entry) => entry.name),
    );
    expect(capturedContext?.tools?.map((entry) => entry.name)).not.toContain("owner_group_admin");
    expect(capturedContext?.tools?.map((entry) => entry.name)).not.toContain("read");
    expect(surface?.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "owner_group_admin", reason: "scope_not_permitted" }),
        expect.objectContaining({ name: "read", reason: "disabled_by_host" }),
      ]),
    );

    await adapter.cleanup();
  });

  it("enforces isolated Pi sessions across Owner and Visitor in the same Conversation, creating fresh sessions without caching", async () => {
    const runtimeBaseDir = await mkdtemp(join(tmpdir(), "glassbox-pi-runtime-"));
    directories.push(runtimeBaseDir);
    let sessionCount = 0;
    const disposedSessions: string[] = [];

    const adapter = new PiSdkRuntimeAdapter({
      kitPath: fileURLToPath(new URL("./fixtures/lora-pi-kit", import.meta.url)),
      runtimeBaseDir,
      createSession: async () => {
        sessionCount++;
        const sId = `pi-session-${sessionCount}`;
        return {
          sessionId: sId,
          messages: [],
          subscribe: () => () => {},
          async prompt() {},
          async abort() {},
          dispose: () => {
            disposedSessions.push(sId);
          },
        } as never;
      },
    });

    await adapter.initialize();

    // Owner creates session
    const ownerBinding = await adapter.createOrRestoreSession(
      { ...conversation, id: "shared-conv-1" },
      "test",
    );
    expect(ownerBinding.runtimeSessionId).toBe("pi-session-1");

    // Visitor creates session in the SAME Conversation
    const visitorBinding = await adapter.createOrRestoreSession(
      { ...conversation, id: "shared-conv-1" },
      "test",
    );
    expect(visitorBinding.runtimeSessionId).toBe("pi-session-2");
    // Sessions must NEVER be cached or shared by conversationId
    expect(visitorBinding.runtimeSessionId).not.toBe(ownerBinding.runtimeSessionId);

    // Dispose owner session
    await adapter.disposeSession(ownerBinding.runtimeSessionId);
    expect(disposedSessions).toContain("pi-session-1");

    // Owner run on disposed session fails
    await expect(adapter.run(ownerBinding, run, "hello")).rejects.toThrow(
      "Pi session binding is not active for this Conversation",
    );

    // Visitor session remains active and can be disposed independently
    await adapter.disposeSession(visitorBinding.runtimeSessionId);
    expect(disposedSessions).toContain("pi-session-2");

    await adapter.cleanup();
  });

  it("PiRunExecutionAdapter disposes sessions per run and reconstructs prompt from authorized Glassbox context, preventing cross-actor and post-revoke context leaks", async () => {
    const runtimeBaseDir = await mkdtemp(join(tmpdir(), "glassbox-pi-runtime-"));
    directories.push(runtimeBaseDir);
    let sessionCount = 0;
    const receivedPrompts: Array<{ sessionId: string; prompt: string }> = [];
    const disposedSessions: string[] = [];

    const adapter = new PiSdkRuntimeAdapter({
      kitPath: fileURLToPath(new URL("./fixtures/lora-pi-kit", import.meta.url)),
      runtimeBaseDir,
      createSession: async () => {
        sessionCount++;
        const sId = `pi-session-${sessionCount}`;
        let listener: ((event: AgentSessionEvent) => void) | undefined;
        return {
          sessionId: sId,
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: `reply from ${sId}` }],
              stopReason: "stop",
            },
          ],
          subscribe: (callback: (event: AgentSessionEvent) => void) => {
            listener = callback;
            return () => {
              listener = undefined;
            };
          },
          async prompt(p: string) {
            receivedPrompts.push({ sessionId: sId, prompt: p });
            listener?.({ type: "agent_start" });
            listener?.({ type: "turn_end", message: {} as never, toolResults: [] });
            listener?.({ type: "agent_end", messages: [], willRetry: false });
          },
          async abort() {},
          dispose: () => {
            disposedSessions.push(sId);
          },
        } as never;
      },
    });

    await adapter.initialize();
    const { PiRunExecutionAdapter } = await import("./run-adapter.js");
    const executor = new PiRunExecutionAdapter(adapter);

    const sharedConv = {
      id: "shared-conv-1",
      agentId: "personal",
      principalId: "owner",
      scope: {
        connectionId: "qq",
        botId: "bot-1",
        chatType: "group" as const,
        chatId: "group-1",
        senderId: "owner",
      },
      resourceId: "conversation:shared-conv-1",
      providerKind: null,
      providerSessionId: null,
      providerSessionPrincipalId: null,
      createdAt: new Date(0).toISOString(),
    };

    // 1. Owner executes Turn 1 with secret data
    const ownerRun1 = {
      id: "run-owner-1",
      sequence: 1,
      conversationId: sharedConv.id,
      messageId: "msg-owner-1",
      principalId: "owner",
      scope: sharedConv.scope,
      executionRef: "pi",
      status: "running" as const,
      resultText: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };

    const ownerInput1 = {
      caller: { principalId: "owner", scope: sharedConv.scope },
      conversation: sharedConv,
      run: ownerRun1,
      text: "tell me secret credentials",
      history: [],
      providerSessionId: null,
      signal: new AbortController().signal,
    };

    const res1 = await executor.execute(ownerInput1);
    expect(res1.status).toBe("succeeded");
    expect(receivedPrompts[0]).toEqual({
      sessionId: "pi-session-1",
      prompt: "tell me secret credentials",
    });
    // Session was disposed in finally
    expect(disposedSessions).toContain("pi-session-1");

    // 2. Visitor executes Turn 2 in the same shared group conversation
    // Glassbox did NOT include Owner's confidential result in Visitor's history
    const visitorScope = { ...sharedConv.scope, senderId: "visitor" };
    const visitorRun2 = {
      id: "run-visitor-2",
      sequence: 2,
      conversationId: sharedConv.id,
      messageId: "msg-visitor-2",
      principalId: "visitor",
      scope: visitorScope,
      executionRef: "pi",
      status: "running" as const,
      resultText: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };

    const visitorInput2 = {
      caller: { principalId: "visitor", scope: visitorScope },
      conversation: sharedConv,
      run: visitorRun2,
      text: "hello from visitor",
      history: [], // Authorized history does not contain Owner's secret
      providerSessionId: null,
      signal: new AbortController().signal,
    };

    const res2 = await executor.execute(visitorInput2);
    expect(res2.status).toBe("succeeded");
    // Visitor ran on a completely fresh session pi-session-2
    expect(receivedPrompts[1]).toEqual({
      sessionId: "pi-session-2",
      prompt: "hello from visitor",
    });
    // Prompt passed to Pi did NOT contain Owner's secret
    expect(receivedPrompts[1]?.prompt).not.toContain("secret");
    expect(disposedSessions).toContain("pi-session-2");

    // 3. Owner executes Turn 3 after a grant was revoked
    // Glassbox excluded the revoked prior turn from history
    const ownerRun3 = {
      id: "run-owner-3",
      sequence: 3,
      conversationId: sharedConv.id,
      messageId: "msg-owner-3",
      principalId: "owner",
      scope: sharedConv.scope,
      executionRef: "pi",
      status: "running" as const,
      resultText: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };

    const ownerInput3 = {
      caller: { principalId: "owner", scope: sharedConv.scope },
      conversation: sharedConv,
      run: ownerRun3,
      text: "owner follow-up",
      history: [], // Revoked grant caused prior turn to be omitted
      providerSessionId: null,
      signal: new AbortController().signal,
    };

    const res3 = await executor.execute(ownerInput3);
    expect(res3.status).toBe("succeeded");
    // Owner ran on a fresh session pi-session-3
    expect(receivedPrompts[2]).toEqual({
      sessionId: "pi-session-3",
      prompt: "owner follow-up",
    });
    expect(receivedPrompts[2]?.prompt).not.toContain("secret credentials");
    expect(disposedSessions).toContain("pi-session-3");

    await adapter.cleanup();
  });

  it("separates authorizedSkills from modelVisibleSkills across main-agent and qq-group profiles", async () => {
    const runtimeBaseDir = await mkdtemp(join(tmpdir(), "glassbox-pi-runtime-"));
    directories.push(runtimeBaseDir);
    const sessionStartEvents: Array<Record<string, unknown>> = [];
    const passedModelVisible: Array<readonly string[] | undefined> = [];

    const adapter = new PiSdkRuntimeAdapter({
      kitPath: fileURLToPath(new URL("./fixtures/lora-pi-kit", import.meta.url)),
      runtimeBaseDir,
      onEvent: (event) => {
        if (event.type === "session_start") {
          sessionStartEvents.push(event.data);
        }
      },
      createSession: async ({ modelVisibleSkillNames }) => {
        passedModelVisible.push(modelVisibleSkillNames);
        return {
          sessionId: `session-${passedModelVisible.length}`,
          messages: [],
          subscribe: (cb: (e: AgentSessionEvent) => void) => {
            cb({ type: "agent_start" });
            cb({ type: "turn_end", message: {} as never, toolResults: [] });
            cb({ type: "agent_end", messages: [], willRetry: false });
            return () => {};
          },
          async prompt() {},
          async abort() {},
          dispose() {},
        } as never;
      },
    });

    await adapter.initialize();

    // 1. main-agent
    const mainContext = {
      runId: "run-main",
      conversationId: "conv-main",
      caller: {
        principalId: "owner",
        scope: {
          connectionId: "qq",
          botId: "bot",
          chatType: "private" as const,
          chatId: "owner",
          senderId: "owner",
        },
      },
    };
    const mainBinding = await adapter.createOrRestoreSession(
      { ...conversation, id: "conv-main" },
      "main-agent",
      mainContext,
    );
    await adapter.run(
      mainBinding,
      { ...run, id: "run-main", conversationId: "conv-main" },
      "hello",
      mainContext,
    );

    expect(passedModelVisible[0]).toEqual([]);
    expect(sessionStartEvents[0]?.modelVisibleSkills).toEqual([]);

    // 2. qq-group with group whitelist
    const groupContext = {
      runId: "run-group",
      conversationId: "conv-group",
      caller: {
        principalId: "visitor",
        scope: {
          connectionId: "qq",
          botId: "bot",
          chatType: "group" as const,
          chatId: "group-1",
          senderId: "visitor",
        },
      },
    };
    const groupBinding = await adapter.createOrRestoreSession(
      { ...conversation, id: "conv-group", principalId: "visitor" },
      "qq-group",
      groupContext,
    );
    await adapter.run(
      groupBinding,
      { ...run, id: "run-group", conversationId: "conv-group", principalId: "visitor" },
      "hello",
      groupContext,
    );

    expect(passedModelVisible[1]).toEqual(["unslop"]);
    expect(sessionStartEvents[1]?.authorizedSkills).toEqual(["unslop"]);
    expect(sessionStartEvents[1]?.modelVisibleSkills).toEqual(["unslop"]);

    await adapter.cleanup();
  });
});

describe("PiSdkRuntimeAdapter provider outcomes", () => {
  /**
   * A Run whose session emits the tool calls it is given, so the recorded Run result is the
   * only thing under test.
   */
  async function runWithCalls(
    calls: Array<{
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      result: unknown;
      isError: boolean;
    }>,
  ) {
    const runtimeBaseDir = await mkdtemp(join(tmpdir(), "glassbox-pi-runtime-"));
    directories.push(runtimeBaseDir);
    // The adapter reads calls from its own event stream, so the fake session subscribes the
    // listener the adapter installs and replays the calls through it.
    const adapter = new PiSdkRuntimeAdapter({
      kitPath: fileURLToPath(new URL("./fixtures/lora-pi-kit", import.meta.url)),
      runtimeBaseDir,
      resolveToolNames: async () => [...new Set(calls.map((call) => call.toolName))],
      resolveSkillNames: async () => ({ names: [] }),
      createSession: async () =>
        ({
          sessionId: "pi-session-outcomes",
          messages: [
            { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
          ],
          subscribe(callback: (event: AgentSessionEvent) => void) {
            for (const call of calls)
              callback({
                type: "tool_execution_start",
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                args: call.args,
              } as never);
            for (const call of calls)
              callback({
                type: "tool_execution_end",
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                result: call.result,
                isError: call.isError,
              } as never);
            return () => {};
          },
          async prompt() {},
          async abort() {},
          dispose() {},
        }) as never,
    });

    await adapter.initialize();
    const context: PiRunContext = { runId: run.id, conversationId: conversation.id };
    const binding = await adapter.createOrRestoreSession(conversation, "test", context);
    const result = await adapter.run(binding, run, "hello", context);
    await adapter.cleanup();
    return result;
  }

  it("records a successful call with its id and outcome", async () => {
    const result = await runWithCalls([
      {
        toolCallId: "call-1",
        toolName: "qq_group_members",
        args: { operation: "get_group_member_list" },
        result: { content: [{ type: "text", text: '{"members":[]}' }] },
        isError: false,
      },
    ]);
    expect(result.toolCalls).toEqual([
      {
        name: "qq_group_members",
        input: { operation: "get_group_member_list" },
        toolCallId: "call-1",
        result: { content: [{ type: "text", text: '{"members":[]}' }] },
        failed: false,
        outcome: "success",
      },
    ]);
  });

  it("records a provider failure as the failure it is, not as a broken Tool", async () => {
    // The bridge being down is a fact about the world. Collapsing it into the generic failure
    // would erase the distinction a Run has to report.
    const result = await runWithCalls([
      {
        toolCallId: "call-1",
        toolName: "qq_group_members",
        args: { operation: "get_group_member_list" },
        result: { content: [{ type: "text", text: "provider_unavailable" }] },
        isError: true,
      },
    ]);
    expect(result.toolCalls[0]).toMatchObject({
      failed: true,
      outcome: "provider_unavailable",
    });
  });

  it("classifies a provider refusal as denied", async () => {
    const result = await runWithCalls([
      {
        toolCallId: "call-1",
        toolName: "qq_groups",
        args: { operation: "get_group_info" },
        result: { content: [{ type: "text", text: "provider_denied" }] },
        isError: true,
      },
    ]);
    expect(result.toolCalls[0]).toMatchObject({ failed: true, outcome: "denied" });
  });

  it("attaches each result to the call that produced it", async () => {
    // One Run may call the same Tool twice, and a result credited to the wrong call would
    // count as evidence for a call that never produced it.
    const result = await runWithCalls([
      {
        toolCallId: "call-1",
        toolName: "qq_group_members",
        args: { operation: "get_group_member_list", params: { group_id: "1" } },
        result: { content: [{ type: "text", text: "provider_failed" }] },
        isError: true,
      },
      {
        toolCallId: "call-2",
        toolName: "qq_group_members",
        args: { operation: "get_group_member_list", params: { group_id: "2" } },
        result: { content: [{ type: "text", text: "[]" }] },
        isError: false,
      },
    ]);
    expect(result.toolCalls).toMatchObject([
      { toolCallId: "call-1", failed: true, outcome: "provider_failed" },
      { toolCallId: "call-2", failed: false, outcome: "success" },
    ]);
  });
});
