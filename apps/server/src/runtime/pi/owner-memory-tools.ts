import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { QQ_SOURCE_CLASSES, type QqSourceClass } from "@glassbox/contracts";
import type { FeedbackSignal, GlassboxMemoryScope, MemoryType } from "../../learning/contracts.js";
import { feedbackSignals } from "../../learning/contracts.js";
import { MemoryConsolidator } from "../../learning/consolidation.js";
import { internalLearningId, publicLearningId } from "../../learning/ids.js";
import { candidateFromAuthorizedSource } from "../../learning/source.js";
import {
  MEMORY_GOVERN_ACTION,
  MEMORY_READ_ACTION,
  MEMORY_WRITE_ACTION,
  OWNER_MEMORY_RESOURCE,
  type LearningStore,
} from "../../learning/store.js";
import type { DomainStore } from "../../persistence/index.js";
import { stringColumn } from "../../persistence/database.js";
import {
  AuthorizedQQSourceReader,
  sourceClassAuthority,
} from "../../retrieval/qq-source-reader.js";
import { groupResourceId } from "../../retrieval/source-resolver.js";
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
    | "reject"
    | "feedback"
    | "extract"
    | "source";
  id?: string;
  type?: MemoryType;
  statement?: string;
  scopeType?: "global" | "project";
  projectId?: string;
  confidence?: number;
  ttlSeconds?: number;
  includeInactive?: boolean;
  signalType?: FeedbackSignal;
  groupId?: string;
  sourceClass?: QqSourceClass;
  query?: string;
  limit?: number;
  since?: string;
  until?: string;
};

function scopeFrom(input: OwnerMemoryToolInput): GlassboxMemoryScope {
  if (input.scopeType === "project" && typeof input.projectId === "string")
    return { type: "project", projectId: input.projectId };
  if (input.scopeType === "global" && input.projectId === undefined) return { type: "global" };
  throw new Error("invalid_memory_scope");
}

/** An Owner command comes from the current persisted input message, never model arguments. */
async function ownerCommand(store: DomainStore, context: ProtectedToolContext): Promise<string> {
  const row = await store.db.transaction(
    async (tx) =>
      (
        await tx.execute({
          sql: "SELECT messages.text FROM runs JOIN messages ON messages.id = runs.message_id WHERE runs.id = ? AND runs.principal_id = ? AND runs.conversation_id = ?",
          args: [context.runId, context.caller.principalId, context.conversationId],
        })
      ).rows[0],
  );
  return row ? stringColumn(row, "text").trim() : "";
}

function commandFor(input: OwnerMemoryToolInput, scope?: GlassboxMemoryScope): string {
  if (input.action === "write" && scope && input.type && input.statement)
    return `/memory write ${scope.type === "global" ? "global" : `project:${scope.projectId}`} ${input.type} ${input.statement.trim()}`;
  if (input.action === "supersede" && input.id && input.statement)
    return `/memory supersede ${input.id} ${input.statement.trim()}`;
  if (input.action === "update" && input.id && input.statement)
    return `/memory update ${input.id} ${input.statement.trim()}`;
  if (input.action === "feedback" && scope && input.signalType && input.statement)
    return `/memory feedback ${scope.type === "global" ? "global" : `project:${scope.projectId}`} ${input.signalType} ${input.statement.trim()}`;
  if (["promote", "reject", "expire", "revoke", "retire"].includes(input.action) && input.id)
    return `/memory ${input.action} ${input.id}`;
  return "";
}

function modelEvidence(runId: string) {
  return [
    {
      evidenceId: randomUUID(),
      kind: "system_inference" as const,
      ref: `run:${runId}`,
      capturedAt: new Date().toISOString(),
      trustLevel: "low" as const,
    },
  ];
}

function requiredId(input: OwnerMemoryToolInput): string {
  if (typeof input.id !== "string" || !input.id) throw new Error("memory_id_required");
  return input.id;
}

function authorizationAction(input: OwnerMemoryToolInput): string {
  if (["list", "get", "list_candidates"].includes(input.action)) return MEMORY_READ_ACTION;
  if (["write", "update", "feedback", "extract", "source"].includes(input.action))
    return MEMORY_WRITE_ACTION;
  return MEMORY_GOVERN_ACTION;
}

const hiddenLearningFields = new Set([
  "id",
  "evidenceId",
  "ref",
  "source",
  "evidence",
  "evidenceRefs",
  "derivedFrom",
  "extensions",
  "signature",
  "supersedes",
  "assertedBy",
  "principalId",
  "conversationId",
  "runId",
  "taskId",
  "artifactRef",
]);

function ownerVisibleLearningResult(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    if (key === "memoryId" || key === "promotedMemoryId" || key === "ifMatchMemoryId")
      return publicLearningId("memory", value);
    if (key === "candidateId") return publicLearningId("candidate", value);
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => ownerVisibleLearningResult(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([field]) => !hiddenLearningFields.has(field))
      .map(([field, item]) => [field, ownerVisibleLearningResult(item, field)]),
  );
}

async function executeMemoryActionRaw(
  store: DomainStore,
  context: ProtectedToolContext,
  input: OwnerMemoryToolInput,
): Promise<unknown> {
  const learning: LearningStore = store.learning;
  const operationContext = {
    caller: context.caller,
    conversationId: context.conversationId,
    runId: context.runId,
  };
  switch (input.action) {
    case "list":
      return learning.listMemories(operationContext, {
        ...(input.scopeType === undefined && input.projectId === undefined
          ? {}
          : { scope: scopeFrom(input) }),
        includeInactive: input.includeInactive === true,
      });
    case "get":
      return learning.getMemory(operationContext, internalLearningId("memory", requiredId(input)));
    case "list_candidates":
      return learning.listCandidates(operationContext);
    case "write":
      if (typeof input.statement !== "string" || typeof input.type !== "string")
        throw new Error("memory_write_fields_required");
      {
        const scope = scopeFrom(input);
        const command = await ownerCommand(store, context);
        if (
          command.startsWith("/memory write ") &&
          (command !== commandFor(input, scope) ||
            input.confidence !== undefined ||
            input.ttlSeconds !== undefined)
        )
          throw new Error("owner_confirmation_required");
        const explicit =
          input.confidence === undefined &&
          input.ttlSeconds === undefined &&
          command === commandFor(input, scope);
        if (!explicit)
          return learning.createCandidate(operationContext, {
            candidateKind: "derived",
            subject: { kind: "user", id: context.caller.principalId },
            scope,
            proposedType: input.type,
            statement: input.statement,
            content: { statement: input.statement },
            source: { kind: "system", ref: `run:${context.runId}` },
            sourceEvidence: modelEvidence(context.runId),
            confidence: input.confidence ?? 0.5,
            mergeHint: { strategy: "manual_review_required" },
            extensions: { "glassbox:model_inference": true },
          });
        return learning.writeExplicit(operationContext, {
          subject: { kind: "user", id: context.caller.principalId },
          scope,
          type: input.type,
          statement: input.statement,
          ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
          ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
        });
      }
    case "update":
      if (input.confidence !== undefined || input.ttlSeconds !== undefined)
        throw new Error("owner_confirmation_required");
      if ((await ownerCommand(store, context)) !== commandFor(input))
        throw new Error("owner_confirmation_required");
      return learning.updateMemory(
        operationContext,
        internalLearningId("memory", requiredId(input)),
        {
          ...(typeof input.statement === "string" ? { statement: input.statement } : {}),
          ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
          ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
        },
      );
    case "expire":
    case "revoke":
    case "retire":
      if ((await ownerCommand(store, context)) !== commandFor(input))
        throw new Error("owner_confirmation_required");
      return learning.setLifecycle(
        operationContext,
        internalLearningId("memory", requiredId(input)),
        input.action === "expire" ? "expired" : input.action === "revoke" ? "revoked" : "retired",
      );
    case "supersede":
      if (typeof input.statement !== "string") throw new Error("memory_write_fields_required");
      {
        const existing = await learning.getMemory(
          operationContext,
          internalLearningId("memory", requiredId(input)),
        );
        if (!existing || existing.lifecycleState !== "active") throw new Error("memory_not_active");
        if (input.type !== undefined && input.type !== existing.type)
          throw new Error("memory_type_mismatch");
        if (
          input.scopeType !== undefined &&
          JSON.stringify(scopeFrom(input)) !== JSON.stringify(existing.scope)
        )
          throw new Error("memory_scope_mismatch");
        const command = await ownerCommand(store, context);
        if (
          command.startsWith("/memory supersede ") &&
          (command !== commandFor(input) ||
            input.confidence !== undefined ||
            input.ttlSeconds !== undefined)
        )
          throw new Error("owner_confirmation_required");
        if (
          input.confidence !== undefined ||
          input.ttlSeconds !== undefined ||
          command !== commandFor(input)
        )
          return learning.createCandidate(operationContext, {
            candidateKind: "correction",
            subject: existing.subject,
            scope: existing.scope,
            proposedType: existing.type,
            statement: input.statement,
            content: { statement: input.statement },
            source: { kind: "system", ref: `run:${context.runId}` },
            sourceEvidence: modelEvidence(context.runId),
            confidence: input.confidence ?? 0.5,
            mergeHint: { strategy: "manual_review_required", ifMatchMemoryId: existing.memoryId },
            extensions: { "glassbox:model_inference": true },
          });
        return learning.supersedeMemory(
          operationContext,
          internalLearningId("memory", requiredId(input)),
          {
            subject: { kind: "user", id: context.caller.principalId },
            scope: existing.scope,
            type: existing.type,
            statement: input.statement,
            ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
            ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
          },
        );
      }
    case "promote":
      if ((await ownerCommand(store, context)) !== commandFor(input))
        throw new Error("owner_confirmation_required");
      {
        const candidateId = internalLearningId("candidate", requiredId(input));
        const candidate = await learning.getCandidate(operationContext, candidateId);
        if (!candidate) throw new Error("candidate_not_found");
        if (candidate.status !== "pending")
          return {
            executed: false,
            reason: "candidate_not_pending",
            candidateId: candidate.candidateId,
            status: candidate.status,
          };
        return learning.promoteCandidate(operationContext, candidateId);
      }
    case "reject":
      if ((await ownerCommand(store, context)) !== commandFor(input))
        throw new Error("owner_confirmation_required");
      {
        const candidateId = internalLearningId("candidate", requiredId(input));
        const candidate = await learning.getCandidate(operationContext, candidateId);
        if (!candidate) throw new Error("candidate_not_found");
        if (candidate.status !== "pending")
          return {
            executed: false,
            reason: "candidate_not_pending",
            candidateId: candidate.candidateId,
            status: candidate.status,
          };
        return learning.rejectCandidate(operationContext, candidateId);
      }
    case "feedback": {
      if (!input.signalType || !feedbackSignals.includes(input.signalType) || !input.statement)
        throw new Error("invalid_feedback_input");
      const scope = scopeFrom(input);
      if ((await ownerCommand(store, context)) !== commandFor(input, scope))
        throw new Error("owner_confirmation_required");
      return learning.recordFeedback(operationContext, {
        signalType: input.signalType,
        scope,
        statement: input.statement,
        conversationId: context.conversationId,
        runId: context.runId,
      });
    }
    case "extract": {
      if (
        !input.statement ||
        !input.type ||
        !["semantic_fact", "episodic_event"].includes(input.type)
      )
        throw new Error("invalid_extraction_input");
      const message = await ownerCommand(store, context);
      const consolidator = new MemoryConsolidator(learning, {
        async extract({ existing }) {
          const existingMemoryId = input.id ? internalLearningId("memory", input.id) : undefined;
          if (existingMemoryId && !existing.some((memory) => memory.memoryId === existingMemoryId))
            throw new Error("memory_scope_mismatch");
          return [
            {
              action: input.id ? "update" : "create",
              type: input.type as "semantic_fact" | "episodic_event",
              statement: input.statement!,
              ...(existingMemoryId ? { existingMemoryId } : {}),
            },
          ];
        },
      });
      return consolidator.consolidate({
        context: operationContext,
        subject: { kind: "user", id: context.caller.principalId },
        scope: scopeFrom(input),
        messages: [{ role: "user", text: message, ref: `run:${context.runId}` }],
      });
    }
    case "source": {
      if (!input.groupId || !input.sourceClass || !QQ_SOURCE_CLASSES.includes(input.sourceClass))
        throw new Error("invalid_memory_source_input");
      const resourceId = groupResourceId(input.groupId);
      const decision = await store.authorization.check({
        caller: context.caller,
        resourceId,
        action: sourceClassAuthority(input.sourceClass).action,
        conversationId: context.conversationId,
        runId: context.runId,
      });
      if (decision.decision !== "ALLOW") throw new Error("memory_source_denied");
      const reader = new AuthorizedQQSourceReader({ store, caller: context.caller });
      const items = await reader.readCandidates({
        connectionId: context.caller.scope.connectionId,
        groupId: input.groupId,
        sourceClass: input.sourceClass,
        ...(input.query === undefined ? {} : { query: input.query }),
        limit: input.limit ?? 10,
        ...(input.since === undefined ? {} : { since: input.since }),
        ...(input.until === undefined ? {} : { until: input.until }),
      });
      const scope = scopeFrom(input);
      const category = input.sourceClass === "metadata" ? "group_info" : input.sourceClass;
      const candidates = [];
      for (const item of items) {
        candidates.push(
          await learning.createCandidate(
            operationContext,
            candidateFromAuthorizedSource({
              item: {
                channel: "qq",
                groupResourceId: resourceId,
                groupId: input.groupId,
                category,
                sourceReadRunId: context.runId,
                authorizationDecisionId: decision.id,
                occurredAt: item.occurredAt,
                stableRef: `qq:${item.id}`,
                snippet: item.text,
                ...(item.externalMessageId ? { externalMessageId: item.externalMessageId } : {}),
                ...(item.senderId ? { senderId: item.senderId } : {}),
              },
              subject: { kind: "user", id: context.caller.principalId },
              scope,
              type: "semantic_fact",
              statement: item.text.slice(0, 8000),
            }),
          ),
        );
      }
      return candidates;
    }
  }
}

async function executeMemoryAction(
  store: DomainStore,
  context: ProtectedToolContext,
  input: OwnerMemoryToolInput,
): Promise<unknown> {
  return ownerVisibleLearningResult(await executeMemoryActionRaw(store, context, input));
}

export function createOwnerMemoryTools(options: {
  store: DomainStore;
  getContext: () => PiRunContext | undefined;
}): ToolDefinition[] {
  const getContext = (): ProtectedToolContext | undefined => {
    const value = options.getContext();
    return value?.caller && value.conversationId && value.runId
      ? {
          caller: value.caller,
          conversationId: value.conversationId,
          runId: value.runId,
          ...(value.requiredToolName === undefined
            ? {}
            : { requiredToolName: value.requiredToolName }),
          ...(value.requiredToolInput === undefined
            ? {}
            : { requiredToolInput: value.requiredToolInput }),
        }
      : undefined;
  };
  return [
    createProtectedTool<OwnerMemoryToolInput>({
      name: OWNER_MEMORY_ADMIN_TOOL,
      label: "Owner Memory 管理",
      description:
        "Owner-private Memory administration. Read with /memory list [all|global|project:id], /memory get <id>, or /memory candidates. Import an authorized QQ source as pending candidates with /memory source <global|project:id> <groupId> <history|notice|essence|metadata|file|album>. Model-originated write and supersede calls create pending candidates only. Active changes require the exact current-message commands /memory write <global|project:id> <type> <statement>, /memory update <id> <statement>, /memory supersede <id> <statement>, or /memory <promote|reject|expire|revoke|retire> <id>.",
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
              "feedback",
              "extract",
              "source",
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
          signalType: Type.Optional(
            Type.Unsafe<FeedbackSignal>({ type: "string", enum: [...feedbackSignals] }),
          ),
          groupId: Type.Optional(Type.String({ pattern: "^[1-9]\\d{0,15}$" })),
          sourceClass: Type.Optional(
            Type.Unsafe<QqSourceClass>({ type: "string", enum: [...QQ_SOURCE_CLASSES] }),
          ),
          query: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
          since: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
          until: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        },
        { additionalProperties: false },
      ),
      action: authorizationAction,
      resourceId: OWNER_MEMORY_RESOURCE,
      authService: options.store.authorization,
      getContext,
      execute: (params, context) => executeMemoryAction(options.store, context, params),
    }),
  ];
}
