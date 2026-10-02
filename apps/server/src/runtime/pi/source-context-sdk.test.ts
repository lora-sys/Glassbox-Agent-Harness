import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { PiNormalizedEvent } from "./types.js";
import { runtimeHealthOf } from "../../management/runtime-health.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PiSdkRuntimeAdapter } from "./adapter.js";
import { PiRunExecutionAdapter } from "./run-adapter.js";
import { AuthorizedQQSourceReader } from "../../retrieval/qq-source-reader.js";
import { sourcePolicyFixture } from "../../learning/source-policy-test-fixture.js";

it.each(["Memory", "new Tool"])(
  "stops an SDK-internal continuation when a %s source revokes during a Tool",
  async (mode) => {
    const f = await sourcePolicyFixture();
    const directory = await mkdtemp(join(tmpdir(), "glassbox-source-sdk-"));
    let adapter: PiSdkRuntimeAdapter | undefined;
    try {
      if (mode === "Memory")
        await f.store.learning.promoteCandidate({ caller: f.caller }, await f.importSource());
      const origin = await f.store.lifecycle.claimQueuedRun(f.caller, f.accepted.run.id);
      await origin.settle("succeeded", "Imported fixture");
      const accepted = await f.store.conversations.acceptIncoming({
        agentId: "personal",
        scope: f.scope,
        messageId: "sdk",
        text: "Summarize orchard",
        executionRef: "fake",
      });
      const model = {
        id: "source-model",
        name: "Source model",
        api: "openai-completions",
        provider: "fixture-provider",
        baseUrl: "http://fixture.invalid",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 128,
      } as never;
      let providerCalls = 0;
      let toolExecutions = 0;
      let firstPrompt = "";
      const events: PiNormalizedEvent[] = [];
      const modelRuntime = {
        hasConfiguredAuth: () => true,
        checkAuth: async () => undefined,
        isUsingOAuth: () => false,
        streamSimple: (_model: unknown, context: unknown) => {
          providerCalls++;
          if (providerCalls === 1) firstPrompt = JSON.stringify(context);
          const stopReason = providerCalls === 1 ? "toolUse" : "stop";
          const message = {
            role: "assistant",
            content:
              providerCalls === 1
                ? [{ type: "toolCall", id: "revoke-1", name: "fixture_revoke", arguments: {} }]
                : [{ type: "text", text: "Protected continuation answer" }],
            api: "openai-completions",
            provider: "fixture-provider",
            model: "source-model",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
            stopReason,
            timestamp: Date.now(),
          } as never;
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => {
            stream.push({ type: "start", partial: message });
            stream.push({ type: "done", reason: stopReason, message });
          });
          return stream;
        },
      } as unknown as ModelRuntime;
      adapter = new PiSdkRuntimeAdapter({
        kitPath: fileURLToPath(new URL("./fixtures/lora-pi-kit", import.meta.url)),
        runtimeBaseDir: directory,
        onEvent: (event) => {
          events.push(event);
        },
        model,
        modelRuntime,
        customTools: [
          {
            name: "fixture_revoke",
            label: "Fixture",
            description: "Fixture source change",
            parameters: Type.Object({}),
            execute: async () => {
              toolExecutions++;
              let text = "Fixture source disabled";
              if (mode === "new Tool") {
                const source = await new AuthorizedQQSourceReader({
                  store: f.store,
                  caller: f.caller,
                }).readAuthorizedCandidates({
                  connectionId: "qq",
                  groupId: "100",
                  sourceClass: "history",
                  runId: accepted.run.id,
                  conversationId: accepted.conversation.id,
                });
                expect(source.items[0]?.text).toBe("Protected orchard history fact.");
                text = source.items[0]!.text;
              }
              await f.policy(false);
              return { content: [{ type: "text", text }], details: {} };
            },
          },
        ],
        resolveToolNames: async () => ["fixture_revoke"],
        resolveSkillNames: async () => ({ names: [] }),
      });
      const executor = new PiRunExecutionAdapter(adapter, {
        learningStore: f.store.learning,
        isOwner: async () => true,
        resolveProfileName: async () => "test",
      });
      const lease = await f.store.lifecycle.claimQueuedRun(f.caller, accepted.run.id);
      const result = await executor.execute({
        caller: f.caller,
        conversation: accepted.conversation,
        run: lease.run,
        text: "Summarize orchard",
        history: [],
        providerSessionId: null,
        signal: new AbortController().signal,
      });
      if (mode === "Memory") expect(firstPrompt).toContain("Protected orchard history fact.");
      else expect(firstPrompt).not.toContain("Protected orchard history fact.");
      expect(toolExecutions).toBe(1);
      expect(providerCalls).toBe(1);
      expect(result).toMatchObject({ status: "failed", failureCode: "gate_refused" });
      expect(result.text).not.toContain("Protected continuation answer");
      expect(result.text).toContain("来源授权已变化");
      const failure = events.find(
        (event) => event.type === "turn_end" && event.data.stopReason === "error",
      );
      expect(failure?.data.failure).toEqual({
        origin: "glassbox",
        category: "source_authorization",
      });
      expect(JSON.stringify(failure)).not.toContain("Protected orchard history fact.");
      expect(runtimeHealthOf(result)).toEqual({ state: "degraded", reasonCode: "gate_refused" });
    } finally {
      await adapter?.cleanup();
      await f.store.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
