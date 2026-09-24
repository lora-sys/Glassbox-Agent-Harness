import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DomainStore } from "../../application/domain-store.js";
import type { WorkspaceRegistry } from "../../workspace/registry.js";
import type { PiRunContext } from "./types.js";

const WRITE_TOOLS = new Set(["write", "edit", "bash", "powershell"]);

export interface IsolatedPiResult {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  details?: unknown;
  isError?: boolean;
}

export interface IsolatedPiSession {
  readonly toolDefinitions: readonly {
    name: string;
    description: string;
    parameters: unknown;
    available: boolean;
  }[];
  execute(input: {
    id: string;
    name: string;
    params: unknown;
    signal?: AbortSignal;
    onUpdate?: (result: IsolatedPiResult) => void;
  }): Promise<IsolatedPiResult>;
  close(): Promise<void>;
}

/** Keep the native Pi result intact while Glassbox performs a fresh product decision. */
export function createIsolatedPiTools(input: {
  session: IsolatedPiSession;
  workspaceId: string;
  registry: WorkspaceRegistry;
  store: DomainStore;
  getContext: () => PiRunContext | undefined;
  onEvidence?: (record: Record<string, unknown>, context: PiRunContext) => Promise<void>;
}): ToolDefinition[] {
  return input.session.toolDefinitions
    .filter((definition) => definition.available)
    .map((definition): ToolDefinition => ({
      name: definition.name,
      label: definition.name,
      description: definition.description,
      parameters: definition.parameters as ToolDefinition["parameters"],
      async execute(id, params, signal, onUpdate) {
        const context = input.getContext();
        if (!context?.caller || !context.conversationId || !context.runId)
          throw new Error("context_missing");
        const access = WRITE_TOOLS.has(definition.name) ? "write" : "read";
        await input.registry.resolveAuthorized(
          context.caller.principalId,
          input.workspaceId,
          access,
        );
        const action = access === "write" ? "workspace:write" : "workspace:read";
        const decision = await input.store.authorization.check({
          caller: context.caller,
          resourceId: `workspace:${input.workspaceId}`,
          action,
          conversationId: context.conversationId,
          runId: context.runId,
        });
        if (decision.decision !== "ALLOW") throw new Error("authorization_denied");
        if (signal?.aborted) throw new Error("Operation cancelled");
        await input.onEvidence?.(
          {
            type: "isolated_pi_tool_call",
            runId: context.runId,
            principalId: context.caller.principalId,
            toolCallId: id,
            toolName: definition.name,
            workspaceId: input.workspaceId,
            action,
            decisionId: decision.id,
            grantId: decision.grantId,
          },
          context,
        );
        let executionCompleted = false;
        try {
          const result = await input.session.execute({
            id,
            name: definition.name,
            params,
            signal,
            onUpdate: (update) => onUpdate?.({ content: update.content, details: update.details }),
          });
          executionCompleted = true;
          await input.onEvidence?.(
            {
              type: "isolated_pi_tool_result",
              runId: context.runId,
              toolCallId: id,
              toolName: definition.name,
              workspaceId: input.workspaceId,
              outcome: result.isError ? "process_failed" : "success",
              contentTypes: result.content.map((part) => part.type),
              detailsPresent: result.details !== undefined,
            },
            context,
          );
          if (result.isError)
            return { content: result.content, details: result.details, isError: true };
          return { content: result.content, details: result.details };
        } catch (error) {
          const uncertain =
            executionCompleted ||
            signal?.aborted ||
            /uncertain|exited|timeout|closed|cancelled/iu.test(
              error instanceof Error ? error.message : String(error),
            );
          await input.onEvidence?.(
            {
              type: "isolated_pi_tool_failure",
              runId: context.runId,
              toolCallId: id,
              toolName: definition.name,
              workspaceId: input.workspaceId,
              outcome: uncertain ? "unknown" : "process_failed",
              sideEffectPossible: WRITE_TOOLS.has(definition.name),
            },
            context,
          );
          throw new Error(uncertain ? "provider_unknown" : "sandbox_tool_failed");
        }
      },
    }));
}
