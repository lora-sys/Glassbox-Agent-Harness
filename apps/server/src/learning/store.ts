import { createHash, randomUUID } from "node:crypto";
import type { Row, Transaction } from "@libsql/client";
import type { AuthorizationService } from "../auth/service.js";
import { requireIdentifier } from "../identity/scope.js";
import { DomainDatabase, optionalString, stringColumn } from "../persistence/database.js";
import type {
  CanonicalMemory,
  FeedbackEvent,
  FeedbackSignal,
  GlassboxMemoryScope,
  LearningOperationContext,
  MemoryCandidate,
  MemoryCandidateKind,
  MemoryEvidence,
  MemoryMergeHint,
  MemorySource,
  MemorySubject,
  MemoryType,
  RetentionFactors,
} from "./contracts.js";
import { candidateKinds, feedbackSignals, memoryTypes, mergeStrategies } from "./contracts.js";
import { createLearningId } from "./ids.js";
import { normalizedRetentionFactors, retentionValue } from "./retention.js";

export const OWNER_MEMORY_RESOURCE = "owner-memory";
export const MEMORY_READ_ACTION = "memory:read";
export const MEMORY_WRITE_ACTION = "memory:write";
export const MEMORY_GOVERN_ACTION = "memory:govern";

type CandidateCreate = Omit<
  MemoryCandidate,
  "candidateId" | "createdAt" | "status" | "reviewedAt" | "promotedMemoryId"
> & { candidateId?: string };

type ExplicitMemoryWrite = {
  subject: MemorySubject;
  scope: GlassboxMemoryScope;
  type: MemoryType;
  statement: string;
  content?: Record<string, unknown>;
  source?: MemorySource;
  evidence?: MemoryEvidence[];
  confidence?: number;
  sensitivity?: CanonicalMemory["sensitivity"];
  retentionPolicy?: string;
  ttlSeconds?: number;
  mergeHint?: MemoryMergeHint;
  extensions?: Record<string, unknown>;
  retentionFactors?: Partial<RetentionFactors>;
};

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parsed<T>(row: Row, key: string): T {
  return JSON.parse(stringColumn(row, key)) as T;
}

function optionalNumber(row: Row, key: string): number | undefined {
  const value = row[key];
  return typeof value === "number" ? value : undefined;
}

function requiredNumber(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new Error("Invalid persisted learning record");
  return value;
}

function validateDate(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`Invalid ${field}`);
}

function validateScore(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1))
    throw new Error(`Invalid ${field}`);
}

function validateScope(scope: GlassboxMemoryScope): void {
  if (scope.type === "global") return;
  if (scope.type === "project") {
    requireIdentifier(scope.projectId);
    return;
  }
  throw new Error("Invalid memory scope");
}

function validateSubject(subject: MemorySubject): void {
  if (!(["user", "agent", "org", "task", "session", "custom"] as const).includes(subject.kind))
    throw new Error("Invalid memory subject");
  requireIdentifier(subject.id);
}

function validateSource(source: MemorySource): void {
  if (!(["chat", "tool", "document", "human", "system", "external"] as const).includes(source.kind))
    throw new Error("Invalid memory source");
  requireIdentifier(source.ref);
}

function validateEvidence(evidence: MemoryEvidence): void {
  requireIdentifier(evidence.evidenceId);
  requireIdentifier(evidence.ref);
  validateDate(evidence.capturedAt, "evidence timestamp");
  if (evidence.excerpt !== undefined && evidence.excerpt.length > 500)
    throw new Error("Evidence excerpt is too long");
}

function validateCandidate(input: CandidateCreate): void {
  if (!candidateKinds.includes(input.candidateKind)) throw new Error("Invalid candidate kind");
  if (!memoryTypes.includes(input.proposedType)) throw new Error("Invalid memory type");
  if (!mergeStrategies.includes(input.mergeHint.strategy))
    throw new Error("Invalid merge strategy");
  validateSubject(input.subject);
  validateScope(input.scope);
  validateSource(input.source);
  if (!input.statement.trim() || input.statement.length > 8_000)
    throw new Error("Invalid memory statement");
  validateScore(input.confidence, "candidate confidence");
  if (
    input.ttlSeconds !== undefined &&
    (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 0)
  )
    throw new Error("Invalid memory TTL");
  for (const evidence of input.sourceEvidence) validateEvidence(evidence);
}

function normalizeStatement(statement: string): string {
  return statement.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function statementFromContent(content: Record<string, unknown>): string {
  return typeof content.statement === "string" ? content.statement : "";
}

export function memorySignature(input: {
  subject: MemorySubject;
  scope: GlassboxMemoryScope;
  type: MemoryType;
  statement: string;
}): string {
  return createHash("sha256")
    .update(json([input.subject, input.scope, input.type, normalizeStatement(input.statement)]))
    .digest("hex");
}

function candidateFromRow(row: Row): MemoryCandidate {
  return {
    candidateId: stringColumn(row, "id"),
    candidateKind: stringColumn(row, "candidate_kind") as MemoryCandidateKind,
    subject: parsed(row, "subject_json"),
    scope: parsed(row, "scope_json"),
    proposedType: stringColumn(row, "proposed_type") as MemoryType,
    statement: stringColumn(row, "statement"),
    content: parsed(row, "content_json"),
    source: parsed(row, "source_json"),
    sourceEvidence: parsed(row, "evidence_json"),
    ...(optionalNumber(row, "confidence") === undefined
      ? {}
      : { confidence: optionalNumber(row, "confidence") }),
    ...(optionalString(row, "sensitivity")
      ? { sensitivity: optionalString(row, "sensitivity") as MemoryCandidate["sensitivity"] }
      : {}),
    ...(optionalString(row, "retention_policy")
      ? { retentionPolicy: optionalString(row, "retention_policy")! }
      : {}),
    ...(optionalNumber(row, "ttl_seconds") === undefined
      ? {}
      : { ttlSeconds: optionalNumber(row, "ttl_seconds") }),
    mergeHint: parsed(row, "merge_hint_json"),
    extensions: parsed(row, "extensions_json"),
    status: stringColumn(row, "status") as MemoryCandidate["status"],
    createdAt: stringColumn(row, "created_at"),
    ...(optionalString(row, "reviewed_at")
      ? { reviewedAt: optionalString(row, "reviewed_at")! }
      : {}),
    ...(optionalString(row, "promoted_memory_id")
      ? { promotedMemoryId: optionalString(row, "promoted_memory_id")! }
      : {}),
  };
}

function memoryFromRow(row: Row): CanonicalMemory {
  const persistedState = stringColumn(row, "lifecycle_state") as CanonicalMemory["lifecycleState"];
  const expiresAt = optionalString(row, "expires_at");
  const lifecycleState =
    persistedState === "active" && expiresAt && Date.parse(expiresAt) <= Date.now()
      ? "expired"
      : persistedState;
  const updatedAt = stringColumn(row, "updated_at");
  const useCount = requiredNumber(row, "use_count");
  const freshness =
    lifecycleState === "expired"
      ? "expired"
      : useCount === 0 && Date.now() - Date.parse(updatedAt) >= 60 * 86_400_000
        ? "stale"
        : "fresh";
  return {
    memoryId: stringColumn(row, "id"),
    subject: parsed(row, "subject_json"),
    scope: parsed(row, "scope_json"),
    type: stringColumn(row, "type") as MemoryType,
    content: parsed(row, "content_json"),
    source: parsed(row, "source_json"),
    ...(optionalNumber(row, "confidence") === undefined
      ? {}
      : { confidence: optionalNumber(row, "confidence") }),
    ...(optionalString(row, "sensitivity")
      ? { sensitivity: optionalString(row, "sensitivity") as CanonicalMemory["sensitivity"] }
      : {}),
    ...(optionalString(row, "retention_policy")
      ? { retentionPolicy: optionalString(row, "retention_policy")! }
      : {}),
    ...(optionalNumber(row, "ttl_seconds") === undefined
      ? {}
      : { ttlSeconds: optionalNumber(row, "ttl_seconds") }),
    createdAt: stringColumn(row, "created_at"),
    updatedAt,
    assertionMode: stringColumn(row, "assertion_mode") as CanonicalMemory["assertionMode"],
    assertedBy: parsed(row, "asserted_by_json"),
    confirmedByUser: requiredNumber(row, "confirmed_by_user") === 1,
    evidenceRefs: (parsed<MemoryEvidence[]>(row, "evidence_json") ?? []).map((item) => item.ref),
    evidence: parsed(row, "evidence_json"),
    derivedFrom: parsed(row, "derived_from_json"),
    extensions: parsed(row, "extensions_json"),
    signature: stringColumn(row, "signature"),
    lifecycleState,
    freshness,
    ...(expiresAt ? { expiresAt } : {}),
    ...(optionalString(row, "disabled_at")
      ? { disabledAt: optionalString(row, "disabled_at")! }
      : {}),
    supersedes: parsed(row, "supersedes_json"),
    useCount,
    ...(optionalString(row, "last_used_at")
      ? { lastUsedAt: optionalString(row, "last_used_at")! }
      : {}),
    retentionFactors: parsed(row, "retention_factors_json"),
    retentionValue: requiredNumber(row, "retention_value"),
  };
}

function mergeUnique<T>(left: readonly T[], right: readonly T[], key: (value: T) => string): T[] {
  const values = new Map<string, T>();
  for (const item of [...left, ...right]) values.set(key(item), item);
  return [...values.values()];
}

function deepMerge(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const result = structuredClone(left);
  for (const [key, value] of Object.entries(right)) {
    const current = result[key];
    result[key] =
      current &&
      value &&
      typeof current === "object" &&
      typeof value === "object" &&
      !Array.isArray(current) &&
      !Array.isArray(value)
        ? deepMerge(current as Record<string, unknown>, value as Record<string, unknown>)
        : structuredClone(value);
  }
  return result;
}

export class LearningStore {
  constructor(
    private readonly db: DomainDatabase,
    private readonly authorization: AuthorizationService,
  ) {}

  private async authorize(context: LearningOperationContext, action: string): Promise<string> {
    const decision = await this.authorization.check({
      caller: context.caller,
      resourceId: OWNER_MEMORY_RESOURCE,
      action,
      conversationId: context.conversationId,
      runId: context.runId,
    });
    if (decision.decision !== "ALLOW") {
      const error = new Error(`Permission denied: ${decision.reason}`);
      Object.assign(error, { decision });
      throw error;
    }
    return decision.id;
  }

  private async audit(
    tx: Transaction,
    context: LearningOperationContext,
    decisionId: string,
    action:
      | "write"
      | "read"
      | "update"
      | "expire"
      | "revoke"
      | "retire"
      | "supersede"
      | "promote"
      | "reject",
    targetId: string,
    lineage: readonly string[] = [],
  ): Promise<void> {
    await tx.execute({
      sql: "INSERT INTO memory_audit_events(id, request_id, principal_id, action, target_id, decision_id, conversation_id, run_id, lineage_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [
        randomUUID(),
        context.runId ?? randomUUID(),
        context.caller.principalId,
        action,
        targetId,
        decisionId,
        context.conversationId ?? null,
        context.runId ?? null,
        json(lineage),
        new Date().toISOString(),
      ],
    });
  }

  private async insertCandidate(tx: Transaction, input: CandidateCreate): Promise<MemoryCandidate> {
    validateCandidate(input);
    const candidate: MemoryCandidate = {
      ...structuredClone(input),
      candidateId: input.candidateId ?? createLearningId("candidate"),
      statement: input.statement.trim(),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    await tx.execute({
      sql: "INSERT INTO memory_candidates(id, candidate_kind, subject_json, scope_json, proposed_type, statement, content_json, source_json, evidence_json, confidence, sensitivity, retention_policy, ttl_seconds, merge_hint_json, extensions_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
      args: [
        candidate.candidateId,
        candidate.candidateKind,
        json(candidate.subject),
        json(candidate.scope),
        candidate.proposedType,
        candidate.statement,
        json(candidate.content),
        json(candidate.source),
        json(candidate.sourceEvidence),
        candidate.confidence ?? null,
        candidate.sensitivity ?? null,
        candidate.retentionPolicy ?? null,
        candidate.ttlSeconds ?? null,
        json(candidate.mergeHint),
        json(candidate.extensions),
        candidate.createdAt,
      ],
    });
    return candidate;
  }

  async createCandidate(
    context: LearningOperationContext,
    input: CandidateCreate,
  ): Promise<MemoryCandidate> {
    const decisionId = await this.authorize(context, MEMORY_WRITE_ACTION);
    return this.db.transaction(async (tx) => {
      const candidate = await this.insertCandidate(tx, input);
      await this.audit(
        tx,
        context,
        decisionId,
        "write",
        candidate.candidateId,
        candidate.sourceEvidence.map((e) => e.ref),
      );
      return candidate;
    });
  }

  async listCandidates(
    context: LearningOperationContext,
    status?: MemoryCandidate["status"],
  ): Promise<MemoryCandidate[]> {
    await this.authorize(context, MEMORY_READ_ACTION);
    return this.db.transaction(async (tx) => {
      const result = await tx.execute({
        sql: `SELECT * FROM memory_candidates${status ? " WHERE status = ?" : ""} ORDER BY created_at ASC, id ASC`,
        args: status ? [status] : [],
      });
      return result.rows.map(candidateFromRow);
    });
  }

  async getCandidate(
    context: LearningOperationContext,
    candidateId: string,
  ): Promise<MemoryCandidate | null> {
    requireIdentifier(candidateId);
    await this.authorize(context, MEMORY_READ_ACTION);
    return this.db.transaction(async (tx) => {
      const row = (
        await tx.execute({
          sql: "SELECT * FROM memory_candidates WHERE id = ?",
          args: [candidateId],
        })
      ).rows[0];
      return row ? candidateFromRow(row) : null;
    });
  }

  async listMemories(
    context: LearningOperationContext,
    options: { scope?: GlassboxMemoryScope; includeInactive?: boolean } = {},
  ): Promise<CanonicalMemory[]> {
    await this.authorize(context, MEMORY_READ_ACTION);
    if (options.scope) validateScope(options.scope);
    return this.db.transaction(async (tx) => {
      const clauses: string[] = [];
      const args: string[] = [];
      if (options.scope) {
        clauses.push("scope_json = ?");
        args.push(json(options.scope));
      }
      if (!options.includeInactive) clauses.push("lifecycle_state = 'active'");
      const result = await tx.execute({
        sql: `SELECT * FROM memories${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY updated_at DESC, id ASC`,
        args,
      });
      return result.rows
        .map(memoryFromRow)
        .filter((memory) => options.includeInactive || memory.lifecycleState === "active");
    });
  }

  async getMemory(
    context: LearningOperationContext,
    memoryId: string,
  ): Promise<CanonicalMemory | null> {
    requireIdentifier(memoryId);
    const decisionId = await this.authorize(context, MEMORY_READ_ACTION);
    return this.db.transaction(async (tx) => {
      const row = (
        await tx.execute({ sql: "SELECT * FROM memories WHERE id = ?", args: [memoryId] })
      ).rows[0];
      if (!row) return null;
      await this.audit(tx, context, decisionId, "read", memoryId);
      return memoryFromRow(row);
    });
  }

  async markUsed(
    context: LearningOperationContext,
    memoryIds: readonly string[],
  ): Promise<CanonicalMemory[]> {
    for (const memoryId of memoryIds) requireIdentifier(memoryId);
    await this.authorize(context, MEMORY_READ_ACTION);
    return this.db.transaction(async (tx) => {
      const updated: CanonicalMemory[] = [];
      for (const memoryId of new Set(memoryIds)) {
        const row = (
          await tx.execute({
            sql: "SELECT * FROM memories WHERE id = ? AND lifecycle_state = 'active'",
            args: [memoryId],
          })
        ).rows[0];
        if (!row) continue;
        const memory = memoryFromRow(row);
        if (memory.lifecycleState !== "active") continue;
        const useCount = memory.useCount + 1;
        const retentionFactors = normalizedRetentionFactors({
          ...memory.retentionFactors,
          usage: useCount / (1 + useCount),
        });
        const next = {
          ...memory,
          useCount,
          lastUsedAt: new Date().toISOString(),
          retentionFactors,
          retentionValue: retentionValue(retentionFactors),
        };
        await this.persistMemory(tx, next);
        updated.push(next);
      }
      return updated;
    });
  }

  private canonicalFromCandidate(
    candidate: MemoryCandidate,
    actor: MemorySubject,
    factors: Partial<RetentionFactors> = {},
  ): CanonicalMemory {
    const createdAt = new Date().toISOString();
    const content = structuredClone(candidate.content);
    content.statement ??= candidate.statement;
    if (candidate.proposedType === "preference") content.preference ??= candidate.statement;
    if (candidate.proposedType === "semantic_fact") content.fact ??= candidate.statement;
    const normalizedFactors = normalizedRetentionFactors({
      reliability: candidate.confidence ?? 0.5,
      ...factors,
    });
    return {
      memoryId: createLearningId("memory"),
      subject: candidate.subject,
      scope: candidate.scope,
      type: candidate.proposedType,
      content,
      source: candidate.source,
      ...(candidate.confidence === undefined ? {} : { confidence: candidate.confidence }),
      ...(candidate.sensitivity === undefined ? {} : { sensitivity: candidate.sensitivity }),
      ...(candidate.retentionPolicy === undefined
        ? {}
        : { retentionPolicy: candidate.retentionPolicy }),
      ...(candidate.ttlSeconds === undefined ? {} : { ttlSeconds: candidate.ttlSeconds }),
      createdAt,
      updatedAt: createdAt,
      assertionMode:
        candidate.candidateKind === "confirmation"
          ? "confirmed"
          : candidate.candidateKind === "derived"
            ? "derived"
            : "asserted",
      assertedBy: actor,
      confirmedByUser:
        (candidate.candidateKind === "assertion" || candidate.candidateKind === "confirmation") &&
        candidate.subject.kind === "user",
      evidenceRefs: candidate.sourceEvidence.map((item) => item.ref),
      evidence: structuredClone(candidate.sourceEvidence),
      derivedFrom: [candidate.candidateId],
      extensions: {
        ...structuredClone(candidate.extensions),
        "glassbox:scope": candidate.scope,
        ...(candidate.mergeHint.dedupeKey
          ? { "mgp:dedupe_key": candidate.mergeHint.dedupeKey }
          : {}),
      },
      signature: memorySignature({
        subject: candidate.subject,
        scope: candidate.scope,
        type: candidate.proposedType,
        statement: candidate.statement,
      }),
      lifecycleState: "active",
      freshness: "fresh",
      ...(candidate.ttlSeconds === undefined
        ? {}
        : {
            expiresAt: new Date(Date.parse(createdAt) + candidate.ttlSeconds * 1_000).toISOString(),
          }),
      supersedes: [],
      useCount: 0,
      retentionFactors: normalizedFactors,
      retentionValue: retentionValue(normalizedFactors),
    };
  }

  private async persistMemory(tx: Transaction, memory: CanonicalMemory): Promise<void> {
    await tx.execute({
      sql: "INSERT INTO memories(id, subject_json, scope_json, type, statement, content_json, source_json, confidence, sensitivity, retention_policy, ttl_seconds, assertion_mode, asserted_by_json, confirmed_by_user, evidence_json, derived_from_json, extensions_json, signature, lifecycle_state, expires_at, disabled_at, supersedes_json, use_count, last_used_at, retention_factors_json, retention_value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET subject_json = excluded.subject_json, scope_json = excluded.scope_json, type = excluded.type, statement = excluded.statement, content_json = excluded.content_json, source_json = excluded.source_json, confidence = excluded.confidence, sensitivity = excluded.sensitivity, retention_policy = excluded.retention_policy, ttl_seconds = excluded.ttl_seconds, assertion_mode = excluded.assertion_mode, asserted_by_json = excluded.asserted_by_json, confirmed_by_user = excluded.confirmed_by_user, evidence_json = excluded.evidence_json, derived_from_json = excluded.derived_from_json, extensions_json = excluded.extensions_json, signature = excluded.signature, lifecycle_state = excluded.lifecycle_state, expires_at = excluded.expires_at, disabled_at = excluded.disabled_at, supersedes_json = excluded.supersedes_json, use_count = excluded.use_count, last_used_at = excluded.last_used_at, retention_factors_json = excluded.retention_factors_json, retention_value = excluded.retention_value, created_at = excluded.created_at, updated_at = excluded.updated_at",
      args: [
        memory.memoryId,
        json(memory.subject),
        json(memory.scope),
        memory.type,
        statementFromContent(memory.content),
        json(memory.content),
        json(memory.source),
        memory.confidence ?? null,
        memory.sensitivity ?? null,
        memory.retentionPolicy ?? null,
        memory.ttlSeconds ?? null,
        memory.assertionMode,
        json(memory.assertedBy),
        memory.confirmedByUser ? 1 : 0,
        json(memory.evidence),
        json(memory.derivedFrom),
        json(memory.extensions),
        memory.signature,
        memory.lifecycleState,
        memory.expiresAt ?? null,
        memory.disabledAt ?? null,
        json(memory.supersedes),
        memory.useCount,
        memory.lastUsedAt ?? null,
        json(memory.retentionFactors),
        memory.retentionValue,
        memory.createdAt,
        memory.updatedAt,
      ],
    });
  }

  private mergeCandidate(
    existing: CanonicalMemory,
    incoming: CanonicalMemory,
    hint: MemoryMergeHint,
  ): CanonicalMemory {
    const now = new Date().toISOString();
    if (hint.strategy === "create") throw new Error("memory_conflict_unresolved");
    if (hint.strategy === "manual_review_required")
      throw new Error("memory_manual_review_required");
    if (hint.strategy === "upsert" || hint.strategy === "replace") {
      return {
        ...incoming,
        memoryId: existing.memoryId,
        createdAt: existing.createdAt,
        updatedAt: now,
        supersedes: mergeUnique(existing.supersedes, incoming.supersedes, String),
      };
    }
    const evidence = mergeUnique(
      existing.evidence,
      incoming.evidence,
      (item) => `${item.kind}:${item.ref}`,
    );
    return {
      ...existing,
      ...(hint.strategy === "merge"
        ? {
            content: deepMerge(existing.content, incoming.content),
            extensions: deepMerge(existing.extensions, incoming.extensions),
          }
        : {}),
      confidence:
        incoming.confidence === undefined
          ? existing.confidence
          : Math.max(existing.confidence ?? 0, incoming.confidence),
      evidence,
      evidenceRefs: evidence.map((item) => item.ref),
      derivedFrom: mergeUnique(existing.derivedFrom, incoming.derivedFrom, String),
      updatedAt: now,
    };
  }

  private async promoteInTransaction(
    tx: Transaction,
    candidate: MemoryCandidate,
    actor: MemorySubject,
    factors: Partial<RetentionFactors> = {},
  ): Promise<CanonicalMemory> {
    if (candidate.status === "promoted" && candidate.promotedMemoryId) {
      const row = (
        await tx.execute({
          sql: "SELECT * FROM memories WHERE id = ?",
          args: [candidate.promotedMemoryId],
        })
      ).rows[0];
      if (row) return memoryFromRow(row);
    }
    if (candidate.status !== "pending") throw new Error("candidate_not_pending");
    let incoming = this.canonicalFromCandidate(candidate, actor, factors);
    const matchId = candidate.mergeHint.ifMatchMemoryId;
    let existingRow: Row | undefined;
    const now = new Date().toISOString();
    // TTL is projected on read, but the active index is persisted. Materialize expiry
    // before signature lookup so a renewed assertion cannot be absorbed by old truth.
    const expiredRows = (
      await tx.execute({
        sql: "SELECT * FROM memories WHERE signature = ? AND lifecycle_state = 'active' AND expires_at IS NOT NULL AND expires_at <= ?",
        args: [incoming.signature, now],
      })
    ).rows;
    for (const expiredRow of expiredRows) {
      const expired = memoryFromRow(expiredRow);
      await this.persistMemory(tx, {
        ...expired,
        lifecycleState: "expired",
        freshness: "expired",
        disabledAt: now,
        updatedAt: now,
      });
      incoming.supersedes.push(expired.memoryId);
    }
    if (matchId) {
      existingRow = (
        await tx.execute({
          sql: "SELECT * FROM memories WHERE id = ? AND lifecycle_state = 'active' AND (expires_at IS NULL OR expires_at > ?)",
          args: [matchId, now],
        })
      ).rows[0];
    } else {
      existingRow = (
        await tx.execute({
          sql: "SELECT * FROM memories WHERE signature = ? AND lifecycle_state = 'active' AND (expires_at IS NULL OR expires_at > ?) LIMIT 1",
          args: [incoming.signature, now],
        })
      ).rows[0];
    }
    const manualReview = candidate.mergeHint.strategy === "manual_review_required";
    const resolvedHint: MemoryMergeHint = manualReview
      ? {
          ...candidate.mergeHint,
          strategy: candidate.candidateKind === "correction" ? "replace" : "dedupe",
        }
      : candidate.mergeHint;
    const extractorRetire = candidate.extensions["glassbox:extractor_action"] === "retire";
    const tasteRetire =
      candidate.extensions["glassbox:taste"] === true && candidate.candidateKind === "correction";
    if (extractorRetire || tasteRetire) {
      if ((extractorRetire && !matchId) || !existingRow) throw new Error("memory_not_active");
      const existing = memoryFromRow(existingRow);
      if (
        json(existing.subject) !== json(incoming.subject) ||
        json(existing.scope) !== json(incoming.scope) ||
        existing.type !== incoming.type
      )
        throw new Error("memory_match_scope_mismatch");
      const retired: CanonicalMemory = {
        ...existing,
        lifecycleState: "retired",
        freshness: "stale",
        disabledAt: now,
        updatedAt: now,
      };
      await this.persistMemory(tx, retired);
      await tx.execute({
        sql: "UPDATE memory_candidates SET status = 'promoted', reviewed_at = ?, promoted_memory_id = ?, merge_hint_json = ? WHERE id = ? AND status = 'pending'",
        args: [now, retired.memoryId, json(resolvedHint), candidate.candidateId],
      });
      return retired;
    }
    if (existingRow) {
      const existing = memoryFromRow(existingRow);
      if (
        json(existing.subject) !== json(incoming.subject) ||
        json(existing.scope) !== json(incoming.scope) ||
        existing.type !== incoming.type
      )
        throw new Error("memory_match_scope_mismatch");
      if (manualReview && candidate.candidateKind === "correction") {
        await this.persistMemory(tx, {
          ...existing,
          lifecycleState: "retired",
          freshness: "stale",
          disabledAt: now,
          updatedAt: now,
        });
        incoming.supersedes = [existing.memoryId, ...existing.supersedes, ...incoming.supersedes];
      } else {
        incoming = this.mergeCandidate(existing, incoming, resolvedHint);
      }
    }
    await this.persistMemory(tx, incoming);
    await tx.execute({
      sql: "UPDATE memory_candidates SET status = 'promoted', reviewed_at = ?, promoted_memory_id = ?, merge_hint_json = ? WHERE id = ? AND status = 'pending'",
      args: [now, incoming.memoryId, json(resolvedHint), candidate.candidateId],
    });
    return incoming;
  }

  async promoteCandidate(
    context: LearningOperationContext,
    candidateId: string,
    factors: Partial<RetentionFactors> = {},
  ): Promise<CanonicalMemory> {
    requireIdentifier(candidateId);
    const decisionId = await this.authorize(context, MEMORY_GOVERN_ACTION);
    return this.db.transaction(async (tx) => {
      const row = (
        await tx.execute({
          sql: "SELECT * FROM memory_candidates WHERE id = ?",
          args: [candidateId],
        })
      ).rows[0];
      if (!row) throw new Error("candidate_not_found");
      const candidate = candidateFromRow(row);
      if (candidate.status !== "pending") throw new Error("candidate_not_pending");
      const promoted = await this.promoteInTransaction(
        tx,
        candidate,
        { kind: "user", id: context.caller.principalId },
        factors,
      );
      const confirmation: MemoryEvidence = {
        evidenceId: randomUUID(),
        kind: "user_confirmation",
        ref: context.runId ? `run:${context.runId}` : `owner-promotion:${candidateId}`,
        capturedAt: new Date().toISOString(),
        trustLevel: "high",
      };
      const evidence = mergeUnique(
        promoted.evidence,
        [confirmation],
        (item) => `${item.kind}:${item.ref}`,
      );
      const memory: CanonicalMemory = {
        ...promoted,
        assertionMode: "confirmed",
        confirmedByUser: true,
        evidence,
        evidenceRefs: evidence.map((item) => item.ref),
        updatedAt: new Date().toISOString(),
      };
      await this.persistMemory(tx, memory);
      await this.audit(tx, context, decisionId, "promote", memory.memoryId, [
        candidateId,
        confirmation.ref,
      ]);
      return memory;
    });
  }

  async rejectCandidate(
    context: LearningOperationContext,
    candidateId: string,
  ): Promise<MemoryCandidate> {
    requireIdentifier(candidateId);
    const decisionId = await this.authorize(context, MEMORY_GOVERN_ACTION);
    return this.db.transaction(async (tx) => {
      const now = new Date().toISOString();
      const result = await tx.execute({
        sql: "UPDATE memory_candidates SET status = 'rejected', reviewed_at = ? WHERE id = ? AND status = 'pending'",
        args: [now, candidateId],
      });
      if (result.rowsAffected !== 1) throw new Error("candidate_not_pending");
      await this.audit(tx, context, decisionId, "reject", candidateId);
      const row = (
        await tx.execute({
          sql: "SELECT * FROM memory_candidates WHERE id = ?",
          args: [candidateId],
        })
      ).rows[0]!;
      return candidateFromRow(row);
    });
  }

  async writeExplicit(
    context: LearningOperationContext,
    input: ExplicitMemoryWrite,
  ): Promise<CanonicalMemory> {
    const decisionId = await this.authorize(context, MEMORY_WRITE_ACTION);
    const evidence = input.evidence ?? [
      {
        evidenceId: randomUUID(),
        kind: "user_confirmation" as const,
        ref: context.runId ? `run:${context.runId}` : `owner-statement:${randomUUID()}`,
        capturedAt: new Date().toISOString(),
        trustLevel: "high" as const,
      },
    ];
    return this.db.transaction(async (tx) => {
      const candidate = await this.insertCandidate(tx, {
        candidateKind: "assertion",
        subject: input.subject,
        scope: input.scope,
        proposedType: input.type,
        statement: input.statement,
        content: input.content ?? { statement: input.statement },
        source: input.source ?? { kind: "human", ref: `principal:${context.caller.principalId}` },
        sourceEvidence: evidence,
        ...(input.confidence === undefined ? { confidence: 1 } : { confidence: input.confidence }),
        ...(input.sensitivity === undefined ? {} : { sensitivity: input.sensitivity }),
        ...(input.retentionPolicy === undefined ? {} : { retentionPolicy: input.retentionPolicy }),
        ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
        mergeHint: input.mergeHint ?? { strategy: "dedupe" },
        extensions: input.extensions ?? {},
      });
      const memory = await this.promoteInTransaction(
        tx,
        candidate,
        { kind: "user", id: context.caller.principalId },
        input.retentionFactors,
      );
      await this.audit(tx, context, decisionId, "write", memory.memoryId, [
        candidate.candidateId,
        ...evidence.map((item) => item.ref),
      ]);
      return memory;
    });
  }

  async updateMemory(
    context: LearningOperationContext,
    memoryId: string,
    input: {
      statement?: string;
      content?: Record<string, unknown>;
      confidence?: number;
      ttlSeconds?: number;
    },
  ): Promise<CanonicalMemory> {
    requireIdentifier(memoryId);
    validateScore(input.confidence, "memory confidence");
    if (
      input.ttlSeconds !== undefined &&
      (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 0)
    )
      throw new Error("Invalid memory TTL");
    const decisionId = await this.authorize(context, MEMORY_WRITE_ACTION);
    return this.db.transaction(async (tx) => {
      const row = (
        await tx.execute({ sql: "SELECT * FROM memories WHERE id = ?", args: [memoryId] })
      ).rows[0];
      if (!row) throw new Error("memory_not_found");
      const memory = memoryFromRow(row);
      if (memory.lifecycleState !== "active") throw new Error("memory_not_active");
      const statement = input.statement?.trim() ?? statementFromContent(memory.content);
      if (!statement) throw new Error("Invalid memory statement");
      const content = { ...(input.content ?? memory.content), statement };
      const updated: CanonicalMemory = {
        ...memory,
        content,
        ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
        ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
        signature: memorySignature({ ...memory, statement }),
        updatedAt: new Date().toISOString(),
        ...(input.ttlSeconds === undefined
          ? {}
          : { expiresAt: new Date(Date.now() + input.ttlSeconds * 1_000).toISOString() }),
      };
      await this.persistMemory(tx, updated);
      await this.audit(tx, context, decisionId, "update", memoryId, memory.evidenceRefs);
      return updated;
    });
  }

  async setLifecycle(
    context: LearningOperationContext,
    memoryId: string,
    state: "expired" | "revoked" | "retired",
  ): Promise<CanonicalMemory> {
    requireIdentifier(memoryId);
    const decisionId = await this.authorize(context, MEMORY_GOVERN_ACTION);
    return this.db.transaction(async (tx) => {
      const now = new Date().toISOString();
      const result = await tx.execute({
        sql: "UPDATE memories SET lifecycle_state = ?, disabled_at = ?, updated_at = ? WHERE id = ? AND lifecycle_state = 'active'",
        args: [state, now, now, memoryId],
      });
      if (result.rowsAffected !== 1) throw new Error("memory_not_active");
      await this.audit(
        tx,
        context,
        decisionId,
        state === "expired" ? "expire" : state === "revoked" ? "revoke" : "retire",
        memoryId,
      );
      const row = (
        await tx.execute({ sql: "SELECT * FROM memories WHERE id = ?", args: [memoryId] })
      ).rows[0]!;
      return memoryFromRow(row);
    });
  }

  async supersedeMemory(
    context: LearningOperationContext,
    memoryId: string,
    input: ExplicitMemoryWrite,
  ): Promise<CanonicalMemory> {
    requireIdentifier(memoryId);
    const decisionId = await this.authorize(context, MEMORY_GOVERN_ACTION);
    return this.db.transaction(async (tx) => {
      const row = (
        await tx.execute({
          sql: "SELECT * FROM memories WHERE id = ? AND lifecycle_state = 'active'",
          args: [memoryId],
        })
      ).rows[0];
      if (!row) throw new Error("memory_not_active");
      const existing = memoryFromRow(row);
      if (
        json(existing.subject) !== json(input.subject) ||
        json(existing.scope) !== json(input.scope) ||
        existing.type !== input.type
      )
        throw new Error("memory_scope_mismatch");
      const evidence = input.evidence ?? [
        {
          evidenceId: randomUUID(),
          kind: "user_confirmation" as const,
          ref: context.runId ? `run:${context.runId}` : `owner-statement:${randomUUID()}`,
          capturedAt: new Date().toISOString(),
          trustLevel: "high" as const,
        },
      ];
      const candidate = await this.insertCandidate(tx, {
        candidateKind: "correction",
        subject: input.subject,
        scope: input.scope,
        proposedType: input.type,
        statement: input.statement,
        content: input.content ?? { statement: input.statement },
        source: input.source ?? { kind: "human", ref: `principal:${context.caller.principalId}` },
        sourceEvidence: evidence,
        confidence: input.confidence ?? 1,
        ...(input.sensitivity === undefined ? {} : { sensitivity: input.sensitivity }),
        ...(input.retentionPolicy === undefined ? {} : { retentionPolicy: input.retentionPolicy }),
        ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
        mergeHint: { strategy: "replace", ifMatchMemoryId: memoryId },
        extensions: input.extensions ?? {},
      });
      const now = new Date().toISOString();
      await this.persistMemory(tx, {
        ...existing,
        lifecycleState: "retired",
        freshness: "stale",
        disabledAt: now,
        updatedAt: now,
      });
      const replacement = {
        ...this.canonicalFromCandidate(
          candidate,
          { kind: "user", id: context.caller.principalId },
          input.retentionFactors,
        ),
        supersedes: [memoryId, ...existing.supersedes],
      };
      await this.persistMemory(tx, replacement);
      await tx.execute({
        sql: "UPDATE memory_candidates SET status = 'promoted', reviewed_at = ?, promoted_memory_id = ? WHERE id = ?",
        args: [now, replacement.memoryId, candidate.candidateId],
      });
      await this.audit(tx, context, decisionId, "supersede", replacement.memoryId, [
        memoryId,
        candidate.candidateId,
      ]);
      return replacement;
    });
  }

  async recordFeedback(
    context: LearningOperationContext,
    input: {
      signalType: FeedbackSignal;
      scope: GlassboxMemoryScope;
      statement: string;
      category?: string;
      conversationId?: string;
      runId?: string;
      taskId?: string;
      artifactRef?: string;
    },
  ): Promise<{ feedback: FeedbackEvent; candidate: MemoryCandidate }> {
    if (!feedbackSignals.includes(input.signalType)) throw new Error("Invalid feedback signal");
    validateScope(input.scope);
    if (!input.statement.trim()) throw new Error("Invalid feedback statement");
    const decisionId = await this.authorize(context, MEMORY_WRITE_ACTION);
    return this.db.transaction(async (tx) => {
      const subject: MemorySubject = { kind: "user", id: context.caller.principalId };
      const pendingRows = (
        await tx.execute({
          sql: "SELECT * FROM memory_candidates WHERE status = 'pending' AND proposed_type = 'preference' ORDER BY created_at ASC, id ASC",
          args: [],
        })
      ).rows;
      let candidate = pendingRows
        .map(candidateFromRow)
        .find(
          (item) =>
            json(item.subject) === json(subject) &&
            json(item.scope) === json(input.scope) &&
            normalizeStatement(item.statement) === normalizeStatement(input.statement),
        );
      const supporting = input.signalType === "accept" || input.signalType === "explicit_positive";
      const contradicting =
        input.signalType === "reject" ||
        input.signalType === "revert" ||
        input.signalType === "explicit_negative";
      const evidence: MemoryEvidence = {
        evidenceId: randomUUID(),
        kind: input.signalType.startsWith("explicit_") ? "user_confirmation" : "human_annotation",
        ref: input.artifactRef ?? (input.runId ? `run:${input.runId}` : `feedback:${randomUUID()}`),
        capturedAt: new Date().toISOString(),
        trustLevel: input.signalType.startsWith("explicit_") ? "high" : "medium",
        metadata: {
          signalType: input.signalType,
          ...(input.category ? { category: input.category } : {}),
        },
      };
      if (!candidate) {
        candidate = await this.insertCandidate(tx, {
          candidateKind: contradicting ? "correction" : "assertion",
          subject,
          scope: input.scope,
          proposedType: "preference",
          statement: input.statement,
          content: {
            statement: input.statement,
            preference: input.statement,
            category: input.category,
          },
          source: { kind: "human", ref: `principal:${context.caller.principalId}` },
          sourceEvidence: [evidence],
          confidence: supporting ? 0.6 : contradicting ? 0.4 : 0.5,
          sensitivity: "confidential",
          mergeHint: {
            strategy: "reinforce",
            dedupeKey: memorySignature({
              subject,
              scope: input.scope,
              type: "preference",
              statement: input.statement,
            }),
          },
          extensions: { "glassbox:taste": true },
        });
      } else {
        const evidenceItems = mergeUnique(
          candidate.sourceEvidence,
          [evidence],
          (item) => `${item.kind}:${item.ref}`,
        );
        const delta = supporting ? 0.1 : contradicting ? -0.1 : 0;
        const confidence = Math.max(0, Math.min(1, (candidate.confidence ?? 0.5) + delta));
        await tx.execute({
          sql: "UPDATE memory_candidates SET candidate_kind = ?, evidence_json = ?, confidence = ? WHERE id = ? AND status = 'pending'",
          args: [
            contradicting ? "correction" : candidate.candidateKind,
            json(evidenceItems),
            confidence,
            candidate.candidateId,
          ],
        });
        candidate = {
          ...candidate,
          candidateKind: contradicting ? "correction" : candidate.candidateKind,
          sourceEvidence: evidenceItems,
          confidence,
        };
      }
      const feedback: FeedbackEvent = {
        id: randomUUID(),
        principalId: context.caller.principalId,
        scope: input.scope,
        signalType: input.signalType,
        statement: input.statement.trim(),
        ...(input.category ? { category: input.category } : {}),
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.artifactRef ? { artifactRef: input.artifactRef } : {}),
        evidence,
        createdAt: new Date().toISOString(),
        candidateId: candidate.candidateId,
      };
      await tx.execute({
        sql: "INSERT INTO feedback_events(id, principal_id, scope_json, signal_type, statement, category, conversation_id, run_id, task_id, artifact_ref, evidence_json, candidate_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        args: [
          feedback.id,
          feedback.principalId,
          json(feedback.scope),
          feedback.signalType,
          feedback.statement,
          feedback.category ?? null,
          feedback.conversationId ?? null,
          feedback.runId ?? null,
          feedback.taskId ?? null,
          feedback.artifactRef ?? null,
          json(feedback.evidence),
          feedback.candidateId,
          feedback.createdAt,
        ],
      });
      await this.audit(tx, context, decisionId, "write", feedback.id, [
        candidate.candidateId,
        evidence.ref,
      ]);
      return { feedback, candidate };
    });
  }
}
