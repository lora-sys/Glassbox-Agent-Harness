import type { ModelProfileStore } from "../config/model-profiles.js";
import { createModelProvider } from "../model/provider.js";
import type { Message } from "../model/vendor/pi/types.js";
import { runModelAgent, type ModelAgentEvent } from "./model-agent/index.js";
import type { RunExecutionAdapter } from "./run-service/types.js";

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
      const messages: Message[] = input.history.map((entry) => {
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
          systemPrompt:
            "You are the Glassbox personal assistant. Use the supplied conversation context. Report unavailable tools accurately.",
          messages,
        },
        signal: input.signal,
        maxTurns: 8,
        maxToolCalls: 0,
        maxOutputTokens: 4096,
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
