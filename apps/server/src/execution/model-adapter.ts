import type { ModelProfileStore } from "../config/model-profiles.js";
import { createModelProvider } from "../model/provider.js";
import type { Message } from "../model/vendor/pi/types.js";
import { runModelAgent, type ModelAgentEvent } from "./model-agent/index.js";
import type { RunExecutionAdapter } from "./run-service/types.js";
import { estimateUnicodeTokens, projectContextBudget } from "../efficiency/index.js";

const SYSTEM_PROMPT =
  "You are the Glassbox personal assistant. Use the supplied conversation context. Report unavailable tools accurately.";

/** The copied Pi runtime receives only the context already authorized by RunService. */
export function configuredModelAdapter(options: {
  profiles: ModelProfileStore;
  profileId: string;
  onEvent?: (runId: string, event: ModelAgentEvent) => void | Promise<void>;
}): RunExecutionAdapter {
  return {
    supportsGroup: true,
    async execute(input) {
      const resolved = options.profiles.resolve(options.profileId);
      const provider = createModelProvider(resolved);
      const contextWindowTokens = resolved.profile.contextWindowTokens ?? 32_768;
      const maxOutputTokens = resolved.profile.maxOutputTokens ?? 4_096;
      const exchanges = [];
      for (let index = 0; index < input.history.length; index += 2) {
        const first = input.history[index];
        const second = input.history[index + 1];
        if (!first || first.role !== "user" || (second && second.role !== "assistant"))
          return { status: "failed" as const };
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
          hasAttachmentsOrArtifacts: false,
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
          safetyMarginTokens: 512,
        },
      );
      await options.onEvent?.(input.run.id, {
        type: "context_budget",
        policyVersion: "p5a-context-v1",
        capacityTokens: contextWindowTokens,
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
      messages.push({ role: "user", content: input.text, timestamp: Date.now() });
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
      return {
        status:
          result.status === "completed"
            ? "succeeded"
            : result.status === "cancelled"
              ? "cancelled"
              : "failed",
        ...(result.status === "completed" ? { text: result.text } : {}),
      };
    },
  };
}
