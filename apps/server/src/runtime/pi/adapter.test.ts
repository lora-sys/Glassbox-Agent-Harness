import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { AgentRun, Conversation } from "@glassbox/contracts";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { PiSdkRuntimeAdapter } from "./adapter.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
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
        listener?.({ type: "turn_end", message: {} as never, toolResults: [] });
        listener?.({ type: "agent_end", messages: [], willRetry: false });
      },
      async abort() {},
      dispose() {},
    };

    const adapter = new PiSdkRuntimeAdapter({
      kitPath: fileURLToPath(new URL("./fixtures/lora-pi-kit", import.meta.url)),
      runtimeBaseDir,
      onEvent: (event) => {
        events.push(event.type);
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
    const binding = await adapter.createOrRestoreSession(conversation, "test");
    const result = await adapter.run(binding, run, "say hello");

    expect(binding.conversationId).toBe(conversation.id);
    expect(binding.runtimeSessionId).not.toBe(conversation.id);
    expect(result).toMatchObject({ status: "completed", text: "hello from pi" });
    expect(events).toEqual([
      "session_start",
      "turn_start",
      "message_chunk",
      "turn_end",
      "session_end",
    ]);
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
});
