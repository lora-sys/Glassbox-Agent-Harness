import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { CallerContext } from "../../identity/scope.js";
import type { AuthorizationService } from "../../auth/service.js";

export interface ProtectedToolContext {
  caller: CallerContext;
  conversationId: string;
  runId: string;
}

export interface ProtectedToolOptions<
  TParams extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown,
> {
  name: string;
  label?: string;
  description: string;
  parameters: TSchema;
  action: string;
  resourceId: string | ((params: TParams) => string);
  authService: AuthorizationService;
  getContext: () => ProtectedToolContext | undefined;
  execute: (
    params: TParams,
    context: ProtectedToolContext,
    signal?: AbortSignal,
  ) => Promise<TResult>;
  redactSensitive?: (params: TParams) => Record<string, unknown>;
}

export function createProtectedTool<
  TParams extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown,
>(options: ProtectedToolOptions<TParams, TResult>): ToolDefinition {
  return {
    name: options.name,
    label: options.label ?? options.name,
    description: options.description,
    parameters: options.parameters,
    async execute(
      _id: string,
      params: unknown,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<TResult>> {
      if (signal?.aborted) {
        throw new Error("Operation cancelled");
      }

      const context = options.getContext();
      if (!context) {
        throw new Error(`Permission denied for tool '${options.name}': context_missing`);
      }

      const typedParams = (params ?? {}) as TParams;
      const resourceId =
        typeof options.resourceId === "function"
          ? options.resourceId(typedParams)
          : options.resourceId;

      // Gate 3 — Re-authorize immediately before executing side effect!
      const decision = await options.authService.check({
        caller: context.caller,
        resourceId,
        action: options.action,
        conversationId: context.conversationId,
        runId: context.runId,
      });

      if (decision.decision !== "ALLOW") {
        // Redact any confidential arguments from the denial output. Never echo raw parameters.
        throw new Error(`Permission denied: ${decision.reason}`);
      }

      if (signal?.aborted) {
        throw new Error("Operation cancelled");
      }

      try {
        const result = await options.execute(typedParams, context, signal);
        if (signal?.aborted) {
          throw new Error("Operation cancelled");
        }
        return {
          content: [
            {
              type: "text",
              text: typeof result === "string" ? result : JSON.stringify(result),
            },
          ],
          details: result,
        };
      } catch (error) {
        if (
          signal?.aborted ||
          (error instanceof Error && error.message === "Operation cancelled")
        ) {
          throw new Error("Operation cancelled");
        }
        throw new Error("protected_tool_failed");
      }
    },
  };
}
