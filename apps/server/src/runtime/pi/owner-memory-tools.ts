import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { GlassboxMemoryScope, MemoryType } from "../../learning/contracts.js";
import {
  MEMORY_GOVERN_ACTION,
  OWNER_MEMORY_RESOURCE,
  type LearningStore,
} from "../../learning/store.js";
import type { DomainStore } from "../../persistence/index.js";
import { createProtectedTool, type ProtectedToolContext } from "./protected-tools.js";
import type { PiRunContext } from "./types.js";

export const OWNER_MEMORY_ADMIN_TOOL = "owner_memory_admin";

type OwnerMemoryToolInput = Record<string, unknown> & {
  action:
    | "list"
    | "get"
    | "list_candidates"
    | "write"
    | "update"
    | "expire"
    | "revoke"
    | "retire"
    | "supersede"
    | "promote"
    | "reject";
  id?: string;
  type?: MemoryType;
  statement?: string;
  scopeType?: "global" | "project";
  projectId?: string;
  confidence?: number;
  ttlSeconds?: number;
  includeInactive?: boolean;
};

function scopeFrom(input: OwnerMemoryToolInput): GlassboxMemoryScope {
  if (input.scopeType === "project" && typeof input.projectId === "string")
    return { type: "project", projectId: input.projectId };
  if (input.scopeType === "global" || input.scopeType === undefined) return { type: "global" };
  throw new Error("invalid_memory_scope");
}

function requiredId(input: OwnerMemoryToolInput): string {
  if (typeof input.id !== "string" || !input.id) throw new Error("memory_id_required");
  return input.id;
}

async function executeMemoryAction(
  learning: LearningStore,
  context: ProtectedToolContext,
  input: OwnerMemoryToolInput,
): Promise<unknown> {
  const operationContext = {
    caller: context.caller,
    conversationId: context.conversationId,
    runId: context.runId,
  };
  switch (input.action) {
    case "list":
      return learning.listMemories(operationContext, {
        scope: scopeFrom(input),
        includeInactive: input.includeInactive === true,
      });
    case "get":
      return learning.getMemory(operationContext, requiredId(input));
    case "list_candidates":
      return learning.listCandidates(operationContext);
    case "write":
      if (typeof input.statement !== "string" || typeof input.type !== "string")
        throw new Error("memory_write_fields_required");
      return learning.writeExplicit(operationContext, {
        subject: { kind: "user", id: context.caller.principalId },
        scope: scopeFrom(input),
        type: input.type,
        statement: input.statement,
        ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
        ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
      });
    case "update":
      return learning.updateMemory(operationContext, requiredId(input), {
        ...(typeof input.statement === "string" ? { statement: input.statement } : {}),
        ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
        ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
      });
    case "expire":
    case "revoke":
    case "retire":
      return learning.setLifecycle(
        operationContext,
        requiredId(input),
        input.action === "expire" ? "expired" : input.action === "revoke" ? "revoked" : "retired",
      );
    case "supersede":
      if (typeof input.statement !== "string" || typeof input.type !== "string")
        throw new Error("memory_write_fields_required");
      return learning.supersedeMemory(operationContext, requiredId(input), {
        subject: { kind: "user", id: context.caller.principalId },
        scope: scopeFrom(input),
        type: input.type,
        statement: input.statement,
        ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
        ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
      });
    case "promote":
      return learning.promoteCandidate(operationContext, requiredId(input));
    case "reject":
      return learning.rejectCandidate(operationContext, requiredId(input));
  }
}

export function createOwnerMemoryTools(options: {
  store: DomainStore;
  getContext: () => PiRunContext | undefined;
}): ToolDefinition[] {
  const getContext = (): ProtectedToolContext | undefined => {
    const value = options.getContext();
    return value?.caller && value.conversationId && value.runId
      ? { caller: value.caller, conversationId: value.conversationId, runId: value.runId }
      : undefined;
  };
  return [
    createProtectedTool<OwnerMemoryToolInput>({
      name: OWNER_MEMORY_ADMIN_TOOL,
      label: "Owner Memory 管理",
      description:
        "Owner-private governed Memory and Taste administration. Inferred content must be listed as a candidate and explicitly promoted; use write only for an explicit Owner statement.",
      parameters: Type.Object(
        {
          action: Type.Unsafe<OwnerMemoryToolInput["action"]>({
            type: "string",
            enum: [
              "list",
              "get",
              "list_candidates",
              "write",
              "update",
              "expire",
              "revoke",
              "retire",
              "supersede",
              "promote",
              "reject",
            ],
          }),
          id: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
          type: Type.Optional(
            Type.Unsafe<MemoryType>({
              type: "string",
              enum: ["preference", "semantic_fact", "episodic_event", "relationship"],
            }),
          ),
          statement: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
          scopeType: Type.Optional(
            Type.Unsafe<"global" | "project">({ type: "string", enum: ["global", "project"] }),
          ),
          projectId: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
          confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
          ttlSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
          includeInactive: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      action: MEMORY_GOVERN_ACTION,
      resourceId: OWNER_MEMORY_RESOURCE,
      authService: options.store.authorization,
      getContext,
      execute: (params, context) => executeMemoryAction(options.store.learning, context, params),
    }),
  ];
}
