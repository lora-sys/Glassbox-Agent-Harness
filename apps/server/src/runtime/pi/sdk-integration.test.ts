import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vite-plus/test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { PiSdkRuntimeAdapter } from "./adapter.js";
import type { PiRunContext } from "./types.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it.each(
  process.env.GLASSBOX_TEST_KIT_PATH
    ? (["test", "main-agent", "qq-group"] as const)
    : (["test"] as const),
)(
  "executes the actual Pi SDK profile %s with a local provider and awaits normalized evidence",
  async (profile) => {
    const directory = await mkdtemp(join(tmpdir(), "glassbox-real-pi-"));
    directories.push(directory);
    const models = await ModelRuntime.create({
      authPath: join(directory, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(directory, "models-cache"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    let calls = 0;
    let currentContext: (() => PiRunContext | undefined) | undefined;
    models.registerProvider("glassbox-test", {
      api: "openai-completions",
      apiKey: "test-only",
      baseUrl: "http://127.0.0.1:1",
      models: [
        {
          id: "deterministic",
          name: "Deterministic",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 256,
        },
      ],
      streamSimple(model, context) {
        calls++;
        expect(currentContext?.()).toMatchObject({
          runId: "run",
          conversationId: "conversation",
          caller: { principalId: "owner" },
        });
        expect(context.tools ?? []).toHaveLength(0);
        expect(context.systemPrompt).not.toContain("Current working directory:");
        expect(context.systemPrompt).not.toContain(directory);
        expect(context.systemPrompt).not.toContain(directory.replace(/\\/gu, "/"));
        expect(context.systemPrompt).not.toContain("<location>");
        if (process.env.GLASSBOX_TEST_KIT_PATH)
          expect(context.systemPrompt).toContain("Selected Skill: unslop");
        expect(context.systemPrompt).toContain(
          process.env.GLASSBOX_TEST_KIT_PATH
            ? "You are Lora's Personal Agent."
            : "You are the durable Glassbox Personal Agent.",
        );
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: "SDK_RESPONSE" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 5,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 7,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        };
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
        return stream;
      },
    });
    const evidence: string[] = [];
    let runtimeEvidence: unknown;
    let turnEvidence: unknown;
    const adapter = new PiSdkRuntimeAdapter({
      kitPath:
        process.env.GLASSBOX_TEST_KIT_PATH ??
        fileURLToPath(new URL("./fixtures/lora-pi-kit", import.meta.url)),
      runtimeBaseDir: directory,
      cwd: directory,
      modelRuntime: models,
      model: models.getModel("glassbox-test", "deterministic")!,
      createTools: (getContext) => {
        currentContext = getContext;
        return [];
      },
      onEvent: async (event) => {
        await Promise.resolve();
        evidence.push(event.type);
        if (event.type === "session_start") runtimeEvidence = event.data.runtime;
        if (event.type === "turn_end") turnEvidence = event.data;
      },
    });
    try {
      await adapter.initialize();
      const binding = await adapter.createOrRestoreSession(
        {
          id: "conversation",
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
          createdAt: new Date(0).toISOString(),
        },
        profile,
      );
      const result = await adapter.run(
        binding,
        {
          id: "run",
          conversationId: "conversation",
          principalId: "owner",
          messageId: "message",
          executionRef: "pi",
          status: "running",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
        "Reply with SDK_RESPONSE",
        {
          runId: "run",
          conversationId: "conversation",
          caller: {
            principalId: "owner",
            scope: {
              connectionId: "qq",
              botId: "bot",
              chatType: "private",
              chatId: "owner",
              senderId: "owner",
            },
          },
        },
      );
      expect(calls).toBe(1);
      expect(result).toMatchObject({
        status: "completed",
        text: "SDK_RESPONSE",
        usage: { inputTokens: 5, outputTokens: 2 },
      });
      expect(evidence[0]).toBe("session_start");
      expect(runtimeEvidence).toMatchObject({
        profileName: profile,
        piVersion: "0.85.1",
        fingerprints: {
          [`profiles/${profile}.json`]: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      });
      expect(evidence.at(-1)).toBe("session_end");
      expect(turnEvidence).toMatchObject({
        provider: "glassbox-test",
        model: "deterministic",
        usage: {
          inputTokens: 5,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 7,
        },
      });
      expect(currentContext?.()).toBeUndefined();
    } finally {
      await adapter.cleanup();
    }
  },
  20_000,
);
