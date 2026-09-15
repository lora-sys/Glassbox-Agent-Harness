import { streamSimple as streamCompletions } from "./vendor/pi/api/openai-completions.ts";
import { streamSimple as streamResponses } from "./vendor/pi/api/openai-responses.ts";
import { streamSimple as streamAnthropic } from "./vendor/pi/api/anthropic-messages.ts";
import { AssistantMessageEventStream } from "./vendor/pi/utils/event-stream.ts";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  Usage,
} from "./vendor/pi/types.ts";

export type ModelProtocol = "openai-completions" | "openai-responses" | "anthropic-messages";

/** Supplied by the configuration domain. This module does not load files or credentials. */
export interface ModelProfile {
  id: string;
  label: string;
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  credentialSlot: string | null;
}

export interface ModelUsage {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  totalTokens: number | null;
  totalSource: "reported" | "derived" | null;
}

export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string }
  | { type: "completed"; reason: "stop" | "length" | "toolUse"; usage: ModelUsage }
  | { type: "failed"; code: "provider_failed" | "cancelled"; message: string };

export interface ModelRequest {
  context: Context;
  signal?: AbortSignal;
  maxOutputTokens?: number;
}

export interface ModelProvider {
  readonly profile: Readonly<ModelProfile>;
  readonly capabilities: {
    readonly streaming: true;
    readonly cancel: true;
    readonly tools: true;
    readonly resume: false;
    readonly images: false;
  };
  readonly model: Model<ModelProtocol>;
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
  /** Server-internal model context. Never send this stream directly to a channel or UI. */
  streamForAgent(
    this: void,
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream;
}

export class ModelConfigurationError extends Error {
  constructor(
    readonly code:
      | "unsupported_protocol"
      | "invalid_endpoint"
      | "missing_credential"
      | "invalid_model"
      | "unsupported_credential",
  ) {
    super(
      {
        unsupported_protocol: "Unsupported model protocol",
        invalid_endpoint: "Invalid model API address",
        missing_credential: "Model credential is not configured",
        invalid_model: "Model is not configured",
        unsupported_credential: "Use an API key for this model profile",
      }[code],
    );
    this.name = "ModelConfigurationError";
  }
}

const EMPTY_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function modelUsage(usage: Usage): ModelUsage {
  const measured = (field: keyof NonNullable<Usage["reported"]>): number | null => {
    const value = usage[field];
    return usage.reported?.[field] &&
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0
      ? value
      : null;
  };
  const input = measured("input");
  const output = measured("output");
  const cacheRead = measured("cacheRead");
  const cacheWrite = measured("cacheWrite");
  const reportedTotal = measured("totalTokens");
  // Anthropic reports components rather than a total. Missing cache fields represent no cache accounting.
  const total =
    reportedTotal ??
    (input !== null && output !== null
      ? input + output + (cacheRead ?? 0) + (cacheWrite ?? 0)
      : null);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning: measured("reasoning"),
    totalTokens: total,
    totalSource: reportedTotal !== null ? "reported" : total !== null ? "derived" : null,
  };
}

function errorMessage(model: Model<ModelProtocol>, cancelled: boolean): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { ...EMPTY_COST, totalTokens: 0, cost: { ...EMPTY_COST, total: 0 } },
    stopReason: cancelled ? "aborted" : "error",
    errorMessage: cancelled ? "Model request cancelled" : "Model request failed",
    timestamp: Date.now(),
  };
}

export function createModelProvider(options: {
  profile: ModelProfile;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): ModelProvider {
  const profile = Object.freeze({ ...options.profile });
  if (!["openai-completions", "openai-responses", "anthropic-messages"].includes(profile.protocol))
    throw new ModelConfigurationError("unsupported_protocol");
  if (!profile.model?.trim() || profile.model.split("").some((char) => char.charCodeAt(0) < 32))
    throw new ModelConfigurationError("invalid_model");
  let endpoint: URL;
  try {
    endpoint = new URL(profile.baseUrl);
  } catch {
    throw new ModelConfigurationError("invalid_endpoint");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.protocol !== "https:" && !(loopback && endpoint.protocol === "http:"))
  )
    throw new ModelConfigurationError("invalid_endpoint");
  const apiKey =
    options.apiKey ||
    (loopback && profile.credentialSlot === null ? "glassbox-local-no-auth" : undefined);
  if (!apiKey) throw new ModelConfigurationError("missing_credential");
  if (profile.protocol === "anthropic-messages" && apiKey.includes("sk-ant-oat"))
    throw new ModelConfigurationError("unsupported_credential");
  const model: Model<ModelProtocol> = {
    id: profile.model,
    name: profile.label,
    api: profile.protocol,
    provider: profile.protocol === "anthropic-messages" ? "anthropic" : "openai",
    baseUrl: profile.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { ...EMPTY_COST },
    // Request budgets, not claims about an unregistered model's measured capacity.
    contextWindow: 32_768,
    maxTokens: 4_096,
  };
  const streamForAgent: ModelProvider["streamForAgent"] = (
    _requestedModel,
    context,
    request = {},
  ) => {
    const safeStream = new AssistantMessageEventStream();
    void (async () => {
      try {
        if (request.signal?.aborted) throw new Error("Cancelled");
        const streamOptions: SimpleStreamOptions = {
          apiKey,
          env: {},
          signal: request.signal,
          maxTokens: request.maxTokens ?? model.maxTokens,
          timeoutMs: options.timeoutMs ?? 60_000,
          maxRetries: 0,
          cacheRetention: "none",
          fetch: options.fetch,
        };
        const stream =
          profile.protocol === "openai-completions"
            ? streamCompletions(model as Model<"openai-completions">, context, streamOptions)
            : profile.protocol === "openai-responses"
              ? streamResponses(model as Model<"openai-responses">, context, streamOptions)
              : streamAnthropic(model as Model<"anthropic-messages">, context, streamOptions);
        for await (const event of stream) {
          if (event.type === "error") {
            const safeError = errorMessage(
              model,
              event.reason === "aborted" || request.signal?.aborted === true,
            );
            safeStream.push({
              type: "error",
              reason: safeError.stopReason as "error" | "aborted",
              error: safeError,
            });
          } else {
            // Provider diagnostics can contain malformed response fragments. They are never evidence at this boundary.
            if (event.type === "done") delete event.message.diagnostics;
            safeStream.push(event);
          }
        }
      } catch {
        const safeError = errorMessage(model, request.signal?.aborted === true);
        safeStream.push({
          type: "error",
          reason: safeError.stopReason as "error" | "aborted",
          error: safeError,
        });
      } finally {
        safeStream.end();
      }
    })();
    return safeStream;
  };
  return {
    profile,
    model,
    capabilities: { streaming: true, cancel: true, tools: true, resume: false, images: false },
    streamForAgent,
    async *stream(request): AsyncGenerator<ModelEvent> {
      const controller = new AbortController();
      const signal = request.signal
        ? AbortSignal.any([request.signal, controller.signal])
        : controller.signal;
      try {
        for await (const event of streamForAgent(model, request.context, {
          signal,
          maxTokens: request.maxOutputTokens,
        })) {
          if (event.type === "text_delta") yield { type: "text_delta", text: event.delta };
          else if (event.type === "toolcall_end")
            yield { type: "tool_call", id: event.toolCall.id, name: event.toolCall.name };
          else if (event.type === "done" && event.reason !== "deferred")
            yield {
              type: "completed",
              reason: event.reason,
              usage: modelUsage(event.message.usage),
            };
          else if (event.type === "done")
            yield {
              type: "failed",
              code: "provider_failed",
              message: "Provider returned an unsupported continuation",
            };
          else if (event.type === "error")
            yield {
              type: "failed",
              code: event.reason === "aborted" ? "cancelled" : "provider_failed",
              message:
                event.reason === "aborted" ? "Model request cancelled" : "Model request failed",
            };
        }
      } finally {
        controller.abort();
      }
    },
  };
}
