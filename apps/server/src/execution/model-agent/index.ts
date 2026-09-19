import type { TSchema } from "typebox";
import { modelUsage, type ModelProvider, type ModelUsage } from "../../model/provider.ts";
import type { Context, Message, TextContent } from "../../model/vendor/pi/types.ts";
import { runAgentLoop } from "./vendor/agent-loop.ts";
import type { AgentEvent, AgentTool } from "./vendor/types.ts";

export interface AuthorizedModelTool {
  name: string;
  description: string;
  parameters: TSchema;
  /** Read CURRENT policy. No authorization is inferred from the tool being present. */
  authorize(
    args: unknown,
    signal: AbortSignal | undefined,
    phase: "execute" | "result",
  ): Promise<boolean>;
  /** Must honor cancellation and return only context authorized for this Run's destination. */
  execute(args: unknown, signal?: AbortSignal): Promise<{ text: string }>;
}

export type ModelAgentEvent =
  | { type: "started" }
  | { type: "turn_started"; turn: number }
  | { type: "text_delta"; text: string }
  | { type: "tool_started"; id: string; name: string }
  | { type: "tool_finished"; id: string; name: string; success: boolean }
  | { type: "usage"; turn: number; usage: ModelUsage }
  | { type: "finished"; status: ModelAgentResult["status"]; turns: number; toolCalls: number };

export interface ModelAgentResult {
  status: "completed" | "cancelled" | "failed" | "limit_reached";
  text: string;
  /** Authorized conversation messages, with hidden reasoning and provider diagnostics excluded. */
  messages: Message[];
  turns: number;
  toolCalls: number;
  usage: ModelUsage[];
  error?:
    | "provider_failed"
    | "execution_failed"
    | "cancelled"
    | "turn_limit"
    | "tool_limit"
    | "output_limit";
}

/** Invoke the copied Pi loop with an explicit provider and no default tools or host discovery. */
export async function runModelAgent(input: {
  provider: ModelProvider;
  authorizedContext: Omit<Context, "tools">;
  tools?: AuthorizedModelTool[];
  signal?: AbortSignal;
  maxTurns?: number;
  maxToolCalls?: number;
  maxOutputTokens?: number;
  onEvent?: (event: ModelAgentEvent) => void | Promise<void>;
}): Promise<ModelAgentResult> {
  const maxTurns = input.maxTurns ?? 8;
  const maxToolCalls = input.maxToolCalls ?? 16;
  if (
    !Number.isInteger(maxTurns) ||
    maxTurns < 1 ||
    maxTurns > 64 ||
    !Number.isInteger(maxToolCalls) ||
    maxToolCalls < 0 ||
    maxToolCalls > 128
  )
    throw new Error("Invalid model execution budget");
  const toolSpecs = input.tools ?? [];
  if (new Set(toolSpecs.map((tool) => tool.name)).size !== toolSpecs.length)
    throw new Error("Duplicate tool name");
  const usage: ModelUsage[] = [];
  let turns = 0;
  let toolCalls = 0;
  let limit: "turn_limit" | "tool_limit" | undefined;
  let failed = false;
  let messages: Message[] = [];
  const tools: AgentTool[] = toolSpecs.map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    replay: "never",
    executionMode: "sequential",
    async execute(_id, args, signal) {
      if (signal?.aborted) throw new Error("Operation cancelled");
      if (toolCalls >= maxToolCalls) {
        limit = "tool_limit";
        throw new Error("Tool budget exhausted");
      }
      toolCalls++;
      // Sequential execution keeps this check adjacent to the protected operation.
      if (!(await tool.authorize(args, signal, "execute"))) throw new Error("Tool access denied");
      if (signal?.aborted) throw new Error("Operation cancelled");
      let result: { text: string };
      try {
        result = await tool.execute(args, signal);
      } catch {
        throw new Error("Tool execution failed");
      }
      if (signal?.aborted) throw new Error("Operation cancelled");
      // Revoked authority must not release a previously started tool's protected result.
      if (!(await tool.authorize(args, signal, "result")))
        throw new Error("Tool result access denied");
      if (typeof result?.text !== "string") throw new Error("Invalid tool result");
      return { content: [{ type: "text", text: result.text }], details: undefined };
    },
  }));
  const emit = async (event: AgentEvent) => {
    let safeEvent: ModelAgentEvent | undefined;
    if (event.type === "agent_start") safeEvent = { type: "started" };
    else if (event.type === "turn_start") safeEvent = { type: "turn_started", turn: ++turns };
    else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
      safeEvent = { type: "text_delta", text: event.assistantMessageEvent.delta };
    else if (event.type === "tool_execution_start")
      safeEvent = { type: "tool_started", id: event.toolCallId, name: event.toolName };
    else if (event.type === "tool_execution_end")
      safeEvent = {
        type: "tool_finished",
        id: event.toolCallId,
        name: event.toolName,
        success: !event.isError,
      };
    else if (event.type === "turn_end" && event.message.role === "assistant") {
      const measured = modelUsage(event.message.usage);
      usage.push(measured);
      safeEvent = { type: "usage", turn: turns, usage: measured };
    }
    if (safeEvent) await input.onEvent?.(safeEvent);
  };
  try {
    const context = structuredClone(input.authorizedContext);
    messages = await runAgentLoop(
      [],
      { ...context, systemPrompt: context.systemPrompt ?? "", tools },
      {
        model: input.provider.model,
        env: {},
        maxTokens: input.maxOutputTokens,
        convertToLlm: (history) => history,
        toolExecution: "sequential",
        beforeToolCall: async () => {
          if (limit || toolCalls >= maxToolCalls) {
            limit = "tool_limit";
            return { block: true, reason: "Tool budget exhausted", terminate: true };
          }
          return undefined;
        },
        shouldStopAfterTurn: ({ message }) => {
          if (input.signal?.aborted || limit) return true;
          if (turns >= maxTurns && message.content.some((part) => part.type === "toolCall")) {
            limit = "turn_limit";
            return true;
          }
          return false;
        },
      },
      emit,
      input.signal,
      input.provider.streamForAgent,
    );
  } catch {
    failed = true;
  }

  const visibleMessages: Message[] = messages.map((message) => {
    if (message.role !== "assistant") {
      if (message.role === "toolResult")
        return {
          role: "toolResult",
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          content: message.content,
          isError: message.isError,
          timestamp: message.timestamp,
        };
      return message;
    }
    return {
      role: "assistant",
      content: message.content
        .filter((part) => part.type !== "thinking")
        .map((part) =>
          part.type === "text" ? ({ type: "text", text: part.text } satisfies TextContent) : part,
        ),
      api: message.api,
      provider: message.provider,
      model: message.model,
      usage: message.usage,
      stopReason: message.stopReason,
      timestamp: message.timestamp,
      ...(message.stopReason === "error" && { errorMessage: "Model request failed" }),
    };
  });
  const lastAssistant = visibleMessages.findLast((message) => message.role === "assistant");
  const status =
    input.signal?.aborted || lastAssistant?.stopReason === "aborted"
      ? "cancelled"
      : limit
        ? "limit_reached"
        : failed ||
            !lastAssistant ||
            lastAssistant.stopReason === "error" ||
            lastAssistant.stopReason === "length"
          ? "failed"
          : "completed";
  const result: ModelAgentResult = {
    status,
    text:
      lastAssistant?.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("") ?? "",
    messages: visibleMessages,
    turns,
    toolCalls,
    usage,
    ...(status === "cancelled"
      ? { error: "cancelled" as const }
      : limit
        ? { error: limit }
        : failed
          ? { error: "execution_failed" as const }
          : lastAssistant?.stopReason === "length"
            ? { error: "output_limit" as const }
            : status === "failed"
              ? { error: "provider_failed" as const }
              : {}),
  };
  await input.onEvent?.({ type: "finished", status, turns, toolCalls });
  return result;
}
