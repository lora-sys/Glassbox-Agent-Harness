import type {
  RunExecutionAdapter,
  ExecutionInput,
  ExecutionResult,
} from "../../execution/run-service/types.js";
import { scopeKey } from "../../identity/scope.js";
import type { PiRuntimeAdapter, PiRuntimeProfileName } from "./types.js";

function recreatedPrompt(input: ExecutionInput): string {
  if (input.history.length === 0) return input.text;
  const history = input.history
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.text}`)
    .join("\n");
  return `Authorized Conversation history:\n${history}\n\nCurrent user message:\n${input.text}`;
}

export class PiRunExecutionAdapter implements RunExecutionAdapter {
  readonly supportsGroup = true;

  constructor(private readonly runtime: PiRuntimeAdapter) {}

  async execute(input: ExecutionInput): Promise<ExecutionResult> {
    await this.runtime.initialize();
    const profile: PiRuntimeProfileName =
      input.caller.scope.chatType === "group" ? "qq-group" : "main-agent";
    const binding = await this.runtime.createOrRestoreSession(
      {
        id: input.conversation.id,
        agentId: input.conversation.agentId,
        principalId: input.caller.principalId,
        scope: {
          channel: "qq",
          scopeType: input.conversation.scope.chatType === "group" ? "group" : "direct",
          scopeKey: scopeKey(input.conversation.scope),
          chatId: input.conversation.scope.chatId,
          connectionId: input.conversation.scope.connectionId,
        },
        resourceId: `conversation:${input.conversation.id}`,
        createdAt: input.conversation.createdAt,
      },
      profile,
    );
    const abort = () => {
      void this.runtime.abort(binding.runtimeSessionId);
    };
    input.signal.addEventListener("abort", abort, { once: true });
    try {
      if (input.signal.aborted) {
        await this.runtime.abort(binding.runtimeSessionId);
        return { status: "cancelled", providerSessionId: binding.runtimeSessionId };
      }
      const result = await this.runtime.run(
        binding,
        { ...input.run, principalId: input.caller.principalId },
        recreatedPrompt(input),
        {
          caller: input.caller,
          conversationId: input.conversation.id,
          runId: input.run.id,
        },
      );
      return {
        status:
          result.status === "completed"
            ? "succeeded"
            : result.status === "aborted"
              ? "cancelled"
              : "failed",
        text: result.text,
        providerSessionId: binding.runtimeSessionId,
      };
    } finally {
      input.signal.removeEventListener("abort", abort);
      await this.runtime.disposeSession?.(binding.runtimeSessionId);
    }
  }

  async cleanup(): Promise<void> {
    return this.runtime.cleanup();
  }
}
