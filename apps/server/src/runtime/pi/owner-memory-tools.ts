import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { QQ_SOURCE_CLASSES, type QqSourceClass } from "@glassbox/contracts";
import type { FeedbackSignal, GlassboxMemoryScope, MemoryType } from "../../learning/contracts.js";
import { feedbackSignals } from "../../learning/contracts.js";
import { MemoryConsolidator } from "../../learning/consolidation.js";
import { createLearningId, internalLearningId, publicLearningId } from "../../learning/ids.js";
import {
  candidateFromAuthorizedSource,
  sourceStatementIsSubstantive,
} from "../../learning/source.js";
import {
  MEMORY_GOVERN_ACTION,
  MEMORY_READ_ACTION,
  MEMORY_WRITE_ACTION,
  OWNER_MEMORY_RESOURCE,
  type LearningStore,
} from "../../learning/store.js";
import type { DomainStore } from "../../persistence/index.js";
import { stringColumn } from "../../persistence/database.js";
import { AuthorizedQQSourceReader } from "../../retrieval/qq-source-reader.js";
import { groupResourceId } from "../../retrieval/source-resolver.js";
import {
  createProtectedTool,
  ToolInputError,
  type ProtectedToolContext,
} from "./protected-tools.js";
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
    | "confirm"
    | "reject"
    | "feedback"
    | "extract"
    | "source";
  id?: string;
  candidateIds?: string[];
  type?: MemoryType;
  statement?: string;
  scopeType?: "global" | "project" | "group";
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

function currentRequestInput(
  context: ProtectedToolContext,
  input: OwnerMemoryToolInput,
): OwnerMemoryToolInput {
  if (context.requiredToolName !== OWNER_MEMORY_ADMIN_TOOL || !context.requiredToolInput)
    return input;
  const required = context.requiredToolInput as OwnerMemoryToolInput;
  if (required.action !== input.action) throw new ToolInputError("mutation_not_requested");
  return required;
}

function scopeFrom(
  input: OwnerMemoryToolInput,
  context: ProtectedToolContext,
): GlassboxMemoryScope {
  if (input.scopeType === "project" && typeof input.projectId === "string")
    return { type: "project", projectId: input.projectId };
  if (input.scopeType === "global" && input.projectId === undefined) return { type: "global" };
  if (input.scopeType === "group" && input.groupId) {
    if (context.caller.scope.chatType !== "private" || !/^[1-9]\d{0,15}$/u.test(input.groupId))
      throw new Error("invalid_memory_scope");
    return {
      type: "group",
      connectionId: context.caller.scope.connectionId,
      botId: context.caller.scope.botId,
      groupId: input.groupId,
    };
  }
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
  if (input.action === "confirm") return "/memory ok";
  const scopeCommand = (value: GlassboxMemoryScope) =>
    value.type === "global"
      ? "global"
      : value.type === "project"
        ? `project:${value.projectId}`
        : `group:${value.groupId}`;
  if (input.action === "write" && scope && input.type && input.statement)
    return `/memory write ${scopeCommand(scope)} ${input.type} ${input.statement.trim()}`;
  if (input.action === "supersede" && input.id && input.statement)
    return `/memory supersede ${input.id} ${input.statement.trim()}`;
  if (input.action === "update" && input.id && input.statement)
    return `/memory update ${input.id} ${input.statement.trim()}`;
  if ((input.action === "promote" || input.action === "reject") && input.candidateIds?.length)
    return `/memory ${input.action} ${input.candidateIds.join(" ")}`;
  if (input.action === "feedback" && scope && input.signalType && input.statement)
    return `/memory feedback ${scopeCommand(scope)} ${input.signalType} ${input.statement.trim()}`;
  if (["promote", "reject", "expire", "revoke", "retire"].includes(input.action) && input.id)
    return `/memory ${input.action} ${input.id}`;
  return "";
}

/**
 * The Owner's message as the command lines it contains, each with its whitespace collapsed.
 *
 * A command has to be a literal `/memory ...` line the Owner wrote, so a message that merely
 * mentions promoting a candidate still authorizes nothing. Anchoring on the line rather than on
 * the whole message lets the Owner put the command inside a longer one, and collapsing runs of
 * whitespace lets it be indented or wrapped without changing what it says. Requiring byte
 * equality against the whole message failed on both, and the failure surfaced as an opaque Tool
 * error instead of as a request for the command.
 */
function commandLines(persisted: string): string[] {
  return persisted
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter((line) => line.length > 0);
}

function commandAuthorized(persisted: string, expected: string): boolean {
  const want = expected.replace(/\s+/gu, " ").trim();
  return want.length > 0 && commandLines(persisted).includes(want);
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

async function latestConversationCandidates(
  store: DomainStore,
  context: ProtectedToolContext,
  learning: LearningStore,
  wholeBatch = false,
) {
  // Only the first server-written creation audit owns a candidate's batch. A repeated
  // model suggestion can reuse a pending row, but cannot move it into another Run.
  const rows = await store.db.transaction(
    async (tx) =>
      (
        await tx.execute({
          sql: `WITH origins AS (
          SELECT target_id, MIN(sequence) AS sequence FROM memory_audit_events
          WHERE action = 'write' GROUP BY target_id
        )
        SELECT c.id, source_run.id AS run_id
        FROM origins
        JOIN memory_audit_events e ON e.sequence = origins.sequence
        JOIN memory_candidates c ON c.id = origins.target_id
        JOIN runs source_run ON source_run.id = e.run_id
        JOIN runs current_run ON current_run.id = ?
        WHERE current_run.conversation_id = ? AND current_run.principal_id = ?
          AND e.conversation_id = current_run.conversation_id
          AND e.principal_id = current_run.principal_id
          AND source_run.conversation_id = current_run.conversation_id
          AND source_run.principal_id = current_run.principal_id
          AND source_run.sequence < current_run.sequence
          AND c.status = 'pending'
          AND json_extract(c.subject_json, '$.kind') = 'user'
          AND json_extract(c.subject_json, '$.id') = current_run.principal_id
        ORDER BY source_run.sequence DESC, e.sequence DESC
        LIMIT ?`,
          args: [
            context.runId,
            context.conversationId,
            context.caller.principalId,
            wholeBatch ? 21 : 1,
          ],
        })
      ).rows,
  );
  const latestRunId = rows[0] && stringColumn(rows[0], "run_id");
  const selected = wholeBatch
    ? rows.filter((row) => stringColumn(row, "run_id") === latestRunId)
    : rows;
  // Read one extra row to reject an oversized batch before any promotion occurs.
  if (selected.length > 20) throw new Error("too_many_pending_candidates");
  const pending = [];
  for (const row of selected) {
    const candidate = await learning.getCandidate(
      {
        caller: context.caller,
        conversationId: context.conversationId,
        runId: context.runId,
      },
      stringColumn(row, "id"),
    );
    if (candidate?.status === "pending") pending.push(candidate);
  }
  if (!pending.length) throw new Error("no_pending_conversation_candidates");
  return pending;
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
          : { scope: scopeFrom(input, context) }),
        includeInactive: input.includeInactive === true,
      });
    case "get":
      return learning.getMemory(operationContext, internalLearningId("memory", requiredId(input)));
    case "list_candidates":
      return learning.listCandidates(
        operationContext,
        input.scopeType === undefined && input.groupId === undefined
          ? {}
          : { scope: scopeFrom(input, context) },
      );
    case "write":
      if (typeof input.statement !== "string" || typeof input.type !== "string")
        throw new Error("memory_write_fields_required");
      {
        const scope = scopeFrom(input, context);
        const command = await ownerCommand(store, context);
        const explicit = commandAuthorized(command, commandFor(input, scope));
        if (
          commandLines(command).some((line) => line.startsWith("/memory write ")) &&
          (!explicit || input.confidence !== undefined || input.ttlSeconds !== undefined)
        )
          throw new Error("owner_confirmation_required");
        const explicitWrite =
          input.confidence === undefined && input.ttlSeconds === undefined && explicit;
        if (!explicitWrite)
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
      if (!commandAuthorized(await ownerCommand(store, context), commandFor(input)))
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
      if (!commandAuthorized(await ownerCommand(store, context), commandFor(input)))
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
          JSON.stringify(scopeFrom(input, context)) !== JSON.stringify(existing.scope)
        )
          throw new Error("memory_scope_mismatch");
        const command = await ownerCommand(store, context);
        const explicit = commandAuthorized(command, commandFor(input));
        if (
          commandLines(command).some((line) => line.startsWith("/memory supersede ")) &&
          (!explicit || input.confidence !== undefined || input.ttlSeconds !== undefined)
        )
          throw new Error("owner_confirmation_required");
        if (input.confidence !== undefined || input.ttlSeconds !== undefined || !explicit)
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
            mergeHint: {
              strategy: "manual_review_required",
              ifMatchMemoryId: existing.memoryId,
              ifMatchUpdatedAt: existing.updatedAt,
            },
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
      if (input.id === "last") {
        if (!commandAuthorized(await ownerCommand(store, context), "/memory promote last"))
          throw new Error("owner_confirmation_required");
        const [latest] = await latestConversationCandidates(store, context, learning);
        return learning.promoteCandidate(operationContext, latest!.candidateId);
      }
      if (input.candidateIds) {
        const candidateIds = checkedCandidateIds(input.candidateIds);
        if (
          !commandAuthorized(
            await ownerCommand(store, context),
            commandFor({ ...input, candidateIds }),
          )
        )
          throw new Error("owner_confirmation_required");
        const results = [];
        for (const publicId of candidateIds) {
          const candidateId = internalLearningId("candidate", publicId);
          const candidate = await learning.getCandidate(operationContext, candidateId);
          if (!candidate) {
            results.push({ candidateId: publicId, status: "not_found" });
          } else if (candidate.status !== "pending") {
            results.push({ candidateId: publicId, status: candidate.status });
          } else {
            try {
              const memory = await learning.promoteCandidate(operationContext, candidateId);
              results.push({
                candidateId: publicId,
                status: "promoted",
                memoryId: memory.memoryId,
              });
            } catch {
              results.push({ candidateId: publicId, status: "failed", reason: "review_failed" });
            }
          }
        }
        return { results };
      }
      if (!commandAuthorized(await ownerCommand(store, context), commandFor(input)))
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
    case "confirm": {
      if (
        input.id !== undefined ||
        input.candidateIds !== undefined ||
        !commandAuthorized(await ownerCommand(store, context), "/memory ok")
      )
        throw new Error("owner_confirmation_required");
      const selected = await latestConversationCandidates(store, context, learning, true);
      const results = [];
      for (const candidate of selected.reverse()) {
        try {
          const memory = await learning.promoteCandidate(operationContext, candidate.candidateId);
          results.push({
            candidateId: candidate.candidateId,
            status: "promoted",
            memoryId: memory.memoryId,
          });
        } catch {
          results.push({
            candidateId: candidate.candidateId,
            status: "failed",
            reason: "review_failed",
          });
        }
      }
      return { results };
    }
    case "reject":
      if (input.candidateIds) {
        const candidateIds = checkedCandidateIds(input.candidateIds);
        if (
          !commandAuthorized(
            await ownerCommand(store, context),
            commandFor({ ...input, candidateIds }),
          )
        )
          throw new Error("owner_confirmation_required");
        const results = [];
        for (const publicId of candidateIds) {
          const candidateId = internalLearningId("candidate", publicId);
          const status = await learning.candidateReviewStatus(operationContext, candidateId);
          if (!status) {
            results.push({ candidateId: publicId, status: "not_found" });
          } else if (status !== "pending") {
            results.push({ candidateId: publicId, status: status });
          } else {
            try {
              await learning.rejectCandidate(operationContext, candidateId);
              results.push({ candidateId: publicId, status: "rejected" });
            } catch {
              results.push({ candidateId: publicId, status: "failed", reason: "review_failed" });
            }
          }
        }
        return { results };
      }
      if (!commandAuthorized(await ownerCommand(store, context), commandFor(input)))
        throw new Error("owner_confirmation_required");
      {
        const candidateId = internalLearningId("candidate", requiredId(input));
        const status = await learning.candidateReviewStatus(operationContext, candidateId);
        if (!status) throw new Error("candidate_not_found");
        if (status !== "pending")
          return {
            executed: false,
            reason: "candidate_not_pending",
            candidateId,
            status: status,
          };
        return learning.rejectCandidate(operationContext, candidateId);
      }
    case "feedback": {
      if (!input.signalType || !feedbackSignals.includes(input.signalType) || !input.statement)
        throw new Error("invalid_feedback_input");
      const scope = scopeFrom(input, context);
      if (!commandAuthorized(await ownerCommand(store, context), commandFor(input, scope)))
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
        scope: scopeFrom(input, context),
        messages: [{ role: "user", text: message, ref: `run:${context.runId}` }],
      });
    }
    case "source": {
      if (!input.groupId || !input.sourceClass || !QQ_SOURCE_CLASSES.includes(input.sourceClass))
        throw new Error("invalid_memory_source_input");
      const resourceId = groupResourceId(input.groupId);
      // A query is what makes this an import of something asked about rather than a dump of
      // whatever the archive happened to hold last. Without one the read returns the most recent
      // messages in the group, which is how the review queue came to hold `可以`, `风控有点严`
      // and `@3394947361 who are you` as pending candidates.
      if (typeof input.query !== "string" || !input.query.trim())
        throw new Error("memory_source_query_required");
      const reader = new AuthorizedQQSourceReader({ store, caller: context.caller });
      const { items, decision } = await reader.readAuthorizedCandidates({
        conversationId: context.conversationId,
        runId: context.runId,
        connectionId: context.caller.scope.connectionId,
        groupId: input.groupId,
        sourceClass: input.sourceClass,
        query: input.query,
        limit: input.limit ?? 10,
        ...(input.since === undefined ? {} : { since: input.since }),
        ...(input.until === undefined ? {} : { until: input.until }),
      });
      const scope = scopeFrom(input, context);
      const category = input.sourceClass === "metadata" ? "group_info" : input.sourceClass;
      const candidates = [];
      const reusedCandidateIds: string[] = [];
      let created = 0;
      let skipped = 0;
      for (const item of items) {
        // A message that asserts nothing is not a candidate. Counting what was dropped is what
        // keeps the answer honest: "imported 3 candidates" would otherwise be said about a read
        // that matched ten messages and queued three.
        if (!sourceStatementIsSubstantive(item.text)) {
          skipped += 1;
          continue;
        }
        const candidateId = createLearningId("candidate");
        const candidate = await learning.createSourceCandidate(operationContext, {
          ...candidateFromAuthorizedSource({
            item: {
              channel: "qq",
              groupResourceId: resourceId,
              groupId: input.groupId,
              category,
              sourceReadRunId: context.runId,
              authorizationDecisionId: decision!.id,
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
          candidateId,
        });
        candidates.push(candidate);
        if (candidate.candidateId === candidateId) created++;
        else reusedCandidateIds.push(publicLearningId("candidate", candidate.candidateId));
      }
      // The source reader reauthorized and marked the actual returned source before any
      // candidate was created, so the store can snapshot trusted Run dependencies.
      return {
        matched: items.length,
        imported: candidates.length,
        created,
        reused: reusedCandidateIds.length,
        reusedCandidateIds,
        reviewGuidance:
          "Only newly created candidates join this Run's batch. Reused pending candidates keep their original batch; review them with /memory promote <candidateId>.",
        skipped,
        candidates,
      };
    }
  }
}

async function executeMemoryAction(
  store: DomainStore,
  context: ProtectedToolContext,
  input: OwnerMemoryToolInput,
): Promise<unknown> {
  const result = ownerVisibleLearningResult(await executeMemoryActionRaw(store, context, input));
  if (
    (input.action === "write" || input.action === "supersede") &&
    result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    "candidateId" in result &&
    typeof result.candidateId === "string"
  )
    return { ...result, confirmationCommand: `/memory promote ${result.candidateId}` };
  return result;
}

function checkedCandidateIds(value: string[]): string[] {
  if (
    value.length < 2 ||
    value.length > 20 ||
    new Set(value).size !== value.length ||
    value.some((id) => !/^candidate_(?:[a-f0-9]{32}|legacy_[a-f0-9]{32})$/iu.test(id))
  )
    throw new Error("invalid_candidate_ids");
  return value;
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
        "Owner-private Memory administration. Read with /memory list [all|global|project:id|group:id], /memory get <id>, or /memory candidates. Import an authorized QQ source as pending candidates with /memory source <global|project:id> <groupId> <history|notice|essence|metadata|file|album> <query> [limit], or use /memory source group:<id> <history|notice|essence|metadata|file|album> <query> [limit] to keep it in that group's scope. Model-originated write and supersede calls create pending candidates only; include the returned confirmationCommand in your reply so the Owner can copy it. Review candidates with an exact current-message /memory promote <id> [id ...], /memory promote last, or /memory ok (the most recent conversation batch, up to 20). Other active changes require exact current-message commands. Every governing command must appear as a literal /memory line in the Owner's own current message; prose authorizes nothing.",
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
              "confirm",
              "reject",
              "feedback",
              "extract",
              "source",
            ],
          }),
          id: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
          candidateIds: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 80 }), {
              minItems: 2,
              maxItems: 20,
            }),
          ),
          type: Type.Optional(
            Type.Unsafe<MemoryType>({
              type: "string",
              enum: ["preference", "semantic_fact", "episodic_event", "relationship"],
            }),
          ),
          statement: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
          scopeType: Type.Optional(
            Type.Unsafe<"global" | "project" | "group">({
              type: "string",
              enum: ["global", "project", "group"],
            }),
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
      deliverySource: (params) =>
        ["list", "get", "list_candidates"].includes(params.action) ? "content_source" : undefined,
      resourceId: OWNER_MEMORY_RESOURCE,
      authService: options.store.authorization,
      getContext,
      execute: (params, context) =>
        executeMemoryAction(options.store, context, currentRequestInput(context, params)),
    }),
  ];
}
