import type { ModelProfileStore } from "../config/model-profiles.js";
import { createModelProvider } from "../model/provider.js";
import type { Message } from "../model/vendor/pi/types.js";
import { runModelAgent, type ModelAgentEvent } from "./model-agent/index.js";
import type { RunExecutionAdapter } from "./run-service/types.js";
import { estimateUnicodeTokens, projectContextBudget } from "../efficiency/index.js";

const SYSTEM_PROMPT =
  "You are the Glassbox personal assistant. Use the supplied conversation context. Report unavailable tools accurately.";
const IMAGE_READ_FAILURE_REPLY = "图片读取失败，暂时无法识别，请重新发送图片。";

/** The copied Pi runtime receives only the context already authorized by RunService. */
export function configuredModelAdapter(options: {
  profiles: ModelProfileStore;
  profileId: string;
  onEvent?: (runId: string, event: ModelAgentEvent) => void | Promise<void>;
}): RunExecutionAdapter {
  return {
    supportsGroup: true,
    supportsTaskStepModel: true,
    async execute(input) {
      if (input.imageFailureCode)
        return { status: "succeeded" as const, text: IMAGE_READ_FAILURE_REPLY };
      const resolved = options.profiles.resolve(options.profileId);
      const contextWindowTokens = resolved.profile.contextWindowTokens;
      const maxOutputTokens = resolved.profile.maxOutputTokens;
      if (
        contextWindowTokens === undefined ||
        maxOutputTokens === undefined ||
        maxOutputTokens >= contextWindowTokens
      ) {
        await options.onEvent?.(input.run.id, {
          type: "model_capacity",
          state: "unknown",
          reasonCode: "capacity_unknown",
        });
        return { status: "failed" as const, failureCode: "model_capacity_unknown" as const };
      }
      const provider = createModelProvider(resolved);
      if (input.images?.length && !provider.model.input.includes("image"))
        return {
          status: "succeeded" as const,
          text: "当前配置的模型不支持识别图片，因此没有发送图片。请切换到支持视觉输入的模型后重试。",
        };
      const exchanges = [];
      for (let index = 0; index < input.history.length; index += 2) {
        const first = input.history[index];
        const second = input.history[index + 1];
        if (!first || first.role !== "user" || (second && second.role !== "assistant"))
          // The history Glassbox handed over does not alternate, so this is a fault in what was
          // passed in rather than in the runtime that would have received it.
          return { status: "failed" as const, failureCode: "gate_refused" as const };
        exchanges.push({
          id: String(index),
          userTokens: estimateUnicodeTokens(first.text) + 8,
          assistantTokens: second ? estimateUnicodeTokens(second.text) + 8 : 0,
        });
      }
      const projection = projectContextBudget(
        {
          estimatedMaterialTokens:
            estimateUnicodeTokens(SYSTEM_PROMPT) +
            estimateUnicodeTokens(input.text) +
            exchanges.reduce(
              (sum, exchange) => sum + exchange.userTokens + exchange.assistantTokens,
              0,
            ),
          estimateSource: "unicode_conservative",
          hasLargeAuthorizedContext: input.historyScanTruncated === true,
          requiredOutputClass: "standard",
          hasToolOrRetrieval: false,
          hasAttachmentsOrArtifacts: input.images !== undefined && input.images.length > 0,
          trustedPolicyFlags: [],
          systemTokens: estimateUnicodeTokens(SYSTEM_PROMPT),
          currentMessageTokens: estimateUnicodeTokens(input.text) + 8,
          toolSchemaTokens: 0,
          requiredFloorTokens: 0,
          exchanges,
        },
        {
          contextWindowTokens,
          outputReserveTokens: maxOutputTokens,
          thinkingReserveTokens: 0,
          safetyMarginTokens: 512,
        },
      );
      await options.onEvent?.(input.run.id, {
        type: "context_budget",
        policyVersion: "p5a-context-v1",
        capacityTokens: contextWindowTokens,
        outputReserveTokens: maxOutputTokens,
        thinkingReserveTokens: 0,
        inputBudgetTokens: Math.max(0, contextWindowTokens - maxOutputTokens - 512),
        estimatedTokens: projection.ok ? projection.projection.projectedTokens : 0,
        omittedExchanges: projection.ok ? projection.projection.omittedExchangeIds.length : 0,
        overflow: projection.ok ? null : projection.overflow.kind,
      });
      if (!projection.ok)
        return { status: "failed" as const, failureCode: "pre_provider_context_overflow" as const };
      const admitted = new Set(projection.projection.includedExchangeIds);
      const boundedHistory = input.history.filter((_entry, index) =>
        admitted.has(String(index - (index % 2))),
      );
      await options.onEvent?.(input.run.id, {
        type: "model_identity",
        provider: resolved.profile.id,
        model: resolved.profile.model,
      });
      const messages: Message[] = boundedHistory.map((entry) => {
        if (entry.role === "user") return { role: "user", content: entry.text, timestamp: 0 };
        return {
          role: "assistant",
          content: [{ type: "text", text: entry.text }],
          api: resolved.profile.protocol,
          provider: resolved.profile.id,
          model: resolved.profile.model,
          // Transcript reconstruction has no usage evidence. These required wire fields are not reported metrics.
          usage: {
            reported: {},
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 0,
        };
      });
      messages.push({
        role: "user",
        content: input.images?.length
          ? [
              { type: "text", text: input.text },
              ...input.images.map((image) => ({
                type: "image" as const,
                data: image.data,
                mimeType: image.mimeType,
              })),
            ]
          : input.text,
        timestamp: Date.now(),
      });
      const result = await runModelAgent({
        provider,
        authorizedContext: {
          systemPrompt: SYSTEM_PROMPT,
          messages,
        },
        signal: input.signal,
        maxTurns: 8,
        maxToolCalls: 0,
        maxOutputTokens,
        onEvent: options.onEvent ? (event) => options.onEvent!(input.run.id, event) : undefined,
      });
      return result.status === "completed"
        ? { status: "succeeded", text: result.text }
        : result.status === "cancelled"
          ? { status: "cancelled" }
          : {
              // The provider was engaged and the run it was given did not produce an answer, so
              // this is the one shape of failure that names the runtime itself.
              status: "failed",
              failureCode: "runtime_run_errored",
            };
    },
  };
}
