import type { Row, Transaction } from "@libsql/client";
import {
  evaluate,
  type AuthorizationDecision,
  type AuthorizationRequest,
} from "../auth/service.js";
import { readPolicyCondition, isPublicGroupCollectionGate } from "../auth/policy-condition.js";
import { sourceClassification } from "../auth/source-dependencies.js";
import { requireIdentifier, scopeKey, type TrustedChannelScope } from "../identity/scope.js";
import { stringColumn } from "../persistence/database.js";
import type { LearningOperationContext, MemoryEvidence } from "./contracts.js";
import { classifyAutoCapture } from "./auto-capture.js";

export type LearningSourceTarget = { kind: "candidate" | "memory"; id: string };
const MAX_SOURCES = 128;
const MAX_ANCESTORS = 32;

export class MemorySourceProvenanceError extends Error {
  constructor() {
    super("memory_source_provenance_unavailable");
  }
}
export class MemorySourceDeniedError extends Error {
  constructor(
    readonly decision: AuthorizationDecision,
    readonly request: AuthorizationRequest,
  ) {
    super("memory_source_denied");
  }
}
const unavailable = (): never => {
  throw new MemorySourceProvenanceError();
};
const tableFor = (kind: LearningSourceTarget["kind"]) =>
  kind === "candidate" ? "memory_candidates" : "memories";

function parse(raw: unknown): unknown {
  if (typeof raw !== "string") return unavailable();
  try {
    return JSON.parse(raw);
  } catch {
    return unavailable();
  }
}
function record(raw: unknown): Record<string, unknown> {
  const value = parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable();
  return value as Record<string, unknown>;
}
function ids(raw: unknown): string[] {
  if (
    !Array.isArray(raw) ||
    raw.length > MAX_SOURCES ||
    raw.some((value) => typeof value !== "string")
  )
    return unavailable();
  for (const value of raw) {
    try {
      requireIdentifier(value);
    } catch {
      return unavailable();
    }
  }
  return [...new Set(raw as string[])];
}
function storedSources(raw: unknown): string[] {
  const value = record(raw);
  if (value.version !== 1 || Object.keys(value).length !== 2) return unavailable();
  return ids(value.decisionIds);
}
export function sourceDependenciesJson(decisionIds: readonly string[]): string {
  return JSON.stringify({ version: 1, decisionIds: ids([...decisionIds]).sort() });
}

export async function learningSourceRows(
  tx: Transaction,
  decisionIds: readonly string[],
): Promise<Row[]> {
  if (!decisionIds.length) return [];
  if (decisionIds.length > MAX_SOURCES * 2) return unavailable();
  const wanted = [...new Set(decisionIds)];
  const result = await tx.execute({
    sql: `SELECT d.* FROM authorization_decisions_all d WHERE d.id IN (${wanted.map(() => "?").join(",")})`,
    args: wanted,
  });
  if (result.rows.length !== wanted.length) return unavailable();
  for (const row of result.rows) {
    if (row.decision !== "ALLOW") return unavailable();
    try {
      sourceClassification(row);
      readPolicyCondition(row);
    } catch {
      return unavailable();
    }
  }
  return result.rows;
}

export async function unionLearningSources(
  tx: Transaction,
  ...sets: readonly (readonly string[])[]
): Promise<string[]> {
  let result: string[] = [];
  for (const set of sets) {
    const rows = await learningSourceRows(tx, [...new Set([...result, ...set])]);
    const unique = new Map<string, string>();
    for (const row of rows) {
      const key = JSON.stringify([
        row.resource_id,
        row.action,
        sourceClassification(row),
        readPolicyCondition(row),
      ]);
      unique.set(key, stringColumn(row, "id"));
    }
    if (unique.size > MAX_SOURCES) return unavailable();
    result = [...unique.values()].sort();
  }
  return result;
}

async function runSources(
  tx: Transaction,
  runId: string,
  principalId: string,
  conversationId?: string,
  callerScope?: string,
  legacy = false,
  validateOnly = false,
  includeRunAccessGates = false,
): Promise<string[]> {
  const runs = await tx.execute({
    sql: "SELECT principal_id,conversation_id,scope_json FROM runs WHERE id = ?",
    args: [runId],
  });
  const run = runs.rows[0];
  if (
    !run ||
    run.principal_id !== principalId ||
    (conversationId && run.conversation_id !== conversationId)
  )
    return unavailable();
  if (callerScope) {
    try {
      if (scopeKey(parse(run.scope_json) as TrustedChannelScope) !== callerScope)
        return unavailable();
    } catch {
      return unavailable();
    }
  }
  if (validateOnly) return [];
  // Historical automatic Memory reads lack the consumed record set. Other documented
  // result-producing Actions need a matching trusted marker before their Run is complete.
  if (legacy) {
    const unmarked = await tx.execute({
      sql: `SELECT DISTINCT d.resource_id,d.action,d.scope_key,d.policy_condition_json,r.kind AS resource_kind
        FROM authorization_decisions_all d LEFT JOIN resources r ON r.id=d.resource_id
        WHERE d.run_id=? AND d.principal_id=? AND d.decision='ALLOW' AND d.delivery_source IS NULL
          AND COALESCE(r.kind,'')<>'web-public' AND (
            d.action IN ('read','list','status','search') OR d.action LIKE '%:read' OR d.action LIKE '%:list'
            OR d.action LIKE '%:status' OR d.action LIKE '%:search'
            OR (r.kind='workspace' AND d.resource_id LIKE 'workspace:%' AND d.action='workspace:write')
            OR (r.kind='owner-control' AND d.resource_id='owner-control' AND d.action='model:switch')) LIMIT 129`,
      args: [runId, principalId],
    });
    if (unmarked.rows.length > MAX_SOURCES) return unavailable();
    for (const row of unmarked.rows) {
      // Personal Agent admission checks this gate without loading an external body.
      // Do not generalize the exception to another resource, Action, or recorded scope.
      if (
        row.resource_id === "agent:personal" &&
        row.resource_kind === "agent" &&
        row.action === "conversation:read"
      ) {
        try {
          const condition = readPolicyCondition(row);
          if (
            row.scope_key === scopeKey(parse(run.scope_json) as TrustedChannelScope) &&
            (condition === null || condition.kind === "none")
          )
            continue;
        } catch {
          return unavailable();
        }
      }
      if (row.action === "memory:read") return unavailable();
      const covered = await tx.execute({
        sql: `SELECT 1 FROM authorization_decisions_all WHERE run_id=? AND principal_id=? AND decision='ALLOW'
          AND delivery_source IS NOT NULL AND resource_id=? AND action=? AND scope_key=? AND policy_condition_json IS ? LIMIT 1`,
        args: [
          runId,
          principalId,
          row.resource_id!,
          row.action!,
          row.scope_key!,
          row.policy_condition_json ?? null,
        ],
      });
      if (!covered.rows.length) return unavailable();
    }
  }
  const rows = await tx.execute({
    sql: `SELECT MIN(id) AS id FROM authorization_decisions_all WHERE run_id = ? AND principal_id = ? AND decision = 'ALLOW' AND delivery_source IS NOT NULL
      GROUP BY resource_id,action,delivery_source,policy_condition_json LIMIT 129`,
    args: [runId, principalId],
  });
  if (rows.rows.length > MAX_SOURCES) return unavailable();
  const sources = await learningSourceRows(
    tx,
    rows.rows.map((row) => stringColumn(row, "id")),
  );
  return unionLearningSources(
    tx,
    sources
      .filter((row) => {
        // This exact server-created gate protects the Owner's collection access in its
        // consuming Run. It does not reclassify already-public group content as private.
        const condition = readPolicyCondition(row);
        return (
          includeRunAccessGates ||
          !isPublicGroupCollectionGate({
            resourceId: stringColumn(row, "resource_id"),
            action: stringColumn(row, "action"),
            source: sourceClassification(row),
            policyCondition: condition,
          })
        );
      })
      .map((row) => stringColumn(row, "id")),
  );
}

async function evidenceSources(tx: Transaction, evidence: unknown): Promise<string[]> {
  if (!Array.isArray(evidence)) return unavailable();
  const result: string[] = [];
  for (const entry of evidence) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return unavailable();
    const metadata = (entry as MemoryEvidence).metadata;
    if (!metadata || typeof metadata !== "object") continue;
    const id = metadata.authorizationDecisionId;
    const qq = metadata.channel === "qq" || metadata.groupResourceId !== undefined;
    if (id === undefined && !qq) continue;
    if (typeof id !== "string" || typeof metadata.sourceReadRunId !== "string")
      return unavailable();
    const [row] = await learningSourceRows(tx, [id]);
    if (
      !row ||
      row.run_id !== metadata.sourceReadRunId ||
      (metadata.groupResourceId !== undefined && row.resource_id !== metadata.groupResourceId)
    )
      return unavailable();
    if (
      metadata.groupId !== undefined &&
      (typeof metadata.groupId !== "string" || row.resource_id !== `group:${metadata.groupId}`)
    )
      return unavailable();
    result.push(id);
    if (result.length > MAX_SOURCES) return unavailable();
  }
  return unionLearningSources(tx, result);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

async function isLiteralCurrentCapture(tx: Transaction, row: Row, audit: Row): Promise<boolean> {
  if (typeof audit.run_id !== "string") return false;
  const rows = await tx.execute({
    sql: "SELECT r.scope_json,r.principal_id,m.text FROM runs r JOIN messages m ON m.id = r.message_id WHERE r.id = ?",
    args: [audit.run_id],
  });
  const run = rows.rows[0];
  if (!run || run.principal_id !== audit.principal_id) return false;
  try {
    const scope = parse(run.scope_json) as TrustedChannelScope;
    const descriptor = classifyAutoCapture({
      text: stringColumn(run, "text"),
      actor: "owner",
      role: "user",
      origin: "current_message",
      scope:
        scope.chatType === "group"
          ? {
              type: "group",
              connectionId: scope.connectionId,
              botId: scope.botId,
              groupId: scope.chatId,
            }
          : { type: "private" },
      messageRef: `run:${audit.run_id}`,
    });
    if (
      !descriptor ||
      row.statement !== descriptor.statement ||
      row.proposed_type !== descriptor.type ||
      row.candidate_kind !==
        (descriptor.evidence.kind === "explicit_correction" ? "correction" : "assertion") ||
      row.confidence !== descriptor.confidence ||
      row.sensitivity !== (scope.chatType === "group" ? "public" : "confidential")
    )
      return false;
    if (
      stable(parse(row.subject_json)) !== stable({ kind: "user", id: audit.principal_id }) ||
      stable(parse(row.scope_json)) !== stable(descriptor.scope)
    )
      return false;
    const content = {
      statement: descriptor.statement,
      ...(descriptor.type === "preference" ? { preference: descriptor.statement } : {}),
    };
    if (
      stable(parse(row.content_json)) !== stable(content) ||
      stable(parse(row.source_json)) !== stable({ kind: "chat", ref: `run:${audit.run_id}` })
    )
      return false;
    if (
      stable(parse(row.extensions_json)) !== stable({ "glassbox:auto-capture": true }) ||
      stable(parse(row.merge_hint_json)) !== stable({ strategy: "manual_review_required" })
    )
      return false;
    if (row.retention_policy !== null || row.ttl_seconds !== null) return false;
    const evidence = parse(row.evidence_json);
    if (!Array.isArray(evidence) || evidence.length !== 1) return false;
    const item = evidence[0] as MemoryEvidence;
    return (
      Object.keys(item).length === 6 &&
      /^[0-9a-f-]{36}$/u.test(item.evidenceId) &&
      new Date(item.capturedAt).toISOString() === item.capturedAt &&
      item.kind === "chat_message" &&
      item.ref === `run:${audit.run_id}` &&
      item.trustLevel === "high" &&
      stable(item.metadata) === stable({ signalKind: descriptor.evidence.kind })
    );
  } catch {
    return false;
  }
}

export async function learningSourcesFor(
  tx: Transaction,
  target: LearningSourceTarget,
  state = { active: new Set<string>(), count: 0 },
): Promise<string[]> {
  const key = `${target.kind}:${target.id}`;
  if (state.active.has(key) || ++state.count > MAX_ANCESTORS) return unavailable();
  const metadata = await tx.execute({
    sql: `SELECT source_dependencies_json FROM ${tableFor(target.kind)} WHERE id = ?`,
    args: [target.id],
  });
  if (!metadata.rows[0]) return unavailable();
  if (metadata.rows[0].source_dependencies_json !== null)
    return unionLearningSources(tx, storedSources(metadata.rows[0].source_dependencies_json));
  // Legacy proof may need the exact historical body to distinguish a literal capture
  // from a model-authored lookalike. It remains internal until proof and policy succeed.
  const rows = await tx.execute({
    sql: `SELECT * FROM ${tableFor(target.kind)} WHERE id = ?`,
    args: [target.id],
  });
  const row = rows.rows[0]!;
  state.active.add(key);
  try {
    let sources = await evidenceSources(tx, parse(row.evidence_json));
    const audits = await tx.execute({
      sql: "SELECT * FROM memory_audit_events WHERE target_id = ? AND action IN ('write','promote','update','supersede') ORDER BY sequence",
      args: [target.id],
    });
    let origins = 0;
    for (const audit of audits.rows) {
      if (target.kind === "candidate") {
        if (audit.action !== "write") continue;
        origins++;
        // Generic candidate audit lineage is copied from untrusted evidence refs. Ignore it.
        if (!(await isLiteralCurrentCapture(tx, row, audit))) {
          if (typeof audit.run_id !== "string") return unavailable();
          sources = await unionLearningSources(
            tx,
            sources,
            await runSources(
              tx,
              audit.run_id,
              stringColumn(audit, "principal_id"),
              undefined,
              undefined,
              true,
            ),
          );
        }
      } else {
        const lineage = parse(audit.lineage_json);
        if (!Array.isArray(lineage)) return unavailable();
        const candidateIndex = audit.action === "supersede" ? 1 : 0;
        if (
          audit.action === "write" ||
          audit.action === "promote" ||
          audit.action === "supersede"
        ) {
          const candidateId = lineage[candidateIndex];
          if (typeof candidateId !== "string") return unavailable();
          const candidates = await tx.execute({
            sql: "SELECT id,promoted_memory_id FROM memory_candidates WHERE id = ?",
            args: [candidateId],
          });
          if (!candidates.rows[0] || candidates.rows[0].promoted_memory_id !== target.id)
            return unavailable();
          origins++;
          sources = await unionLearningSources(
            tx,
            sources,
            await learningSourcesFor(tx, { kind: "candidate", id: candidateId }, state),
          );
          if (audit.action === "supersede") {
            if (typeof lineage[0] !== "string") return unavailable();
            sources = await unionLearningSources(
              tx,
              sources,
              await learningSourcesFor(tx, { kind: "memory", id: lineage[0] }, state),
            );
          }
        }
        // updateMemory is an explicit-write route and preserves all prior origins above.
      }
    }
    if (target.kind === "candidate") {
      // Only memory-targeted write slot zero and supersede slot one are server-owned explicit links.
      // Do not interpret arbitrary generic candidate evidence refs as these links.
      const explicit = await tx.execute({
        sql: `SELECT a.*,m.derived_from_json FROM memory_audit_events a JOIN memories m ON m.id = a.target_id
        WHERE (a.action = 'write' AND json_extract(a.lineage_json,'$[0]') = ?)
          OR (a.action = 'supersede' AND json_extract(a.lineage_json,'$[1]') = ?)`,
        args: [target.id, target.id],
      });
      for (const audit of explicit.rows) {
        const derived = parse(audit.derived_from_json);
        if (
          row.promoted_memory_id !== audit.target_id ||
          !Array.isArray(derived) ||
          !derived.includes(target.id)
        )
          return unavailable();
        origins++;
        // These explicit server-only routes prove this contribution is user-authored.
        // Prior generic/dedupe origins above still apply and can never be overwritten.
      }
      const feedback = await tx.execute({
        sql: "SELECT a.* FROM memory_audit_events a JOIN feedback_events f ON f.id = a.target_id WHERE a.action = 'write' AND f.candidate_id = ?",
        args: [target.id],
      });
      for (const audit of feedback.rows) {
        origins++;
        if (typeof audit.run_id !== "string") return unavailable();
        sources = await unionLearningSources(
          tx,
          sources,
          await runSources(
            tx,
            audit.run_id,
            stringColumn(audit, "principal_id"),
            undefined,
            undefined,
            true,
          ),
        );
      }
    }
    if (!origins) return unavailable();
    await setLearningSources(tx, target, sources);
    return sources;
  } finally {
    state.active.delete(key);
  }
}

export async function captureLearningSources(
  tx: Transaction,
  context: LearningOperationContext,
  evidence: readonly MemoryEvidence[],
  options: {
    userAuthored?: boolean;
    memoryIds?: readonly string[];
    trustedSourceIds?: readonly string[];
    includeRunAccessGates?: boolean;
  } = {},
): Promise<string[]> {
  let sources: string[] = [];
  if (context.runId) {
    const consumed = await runSources(
      tx,
      context.runId,
      context.caller.principalId,
      context.conversationId,
      scopeKey(context.caller.scope),
      false,
      options.userAuthored === true || options.trustedSourceIds !== undefined,
      options.includeRunAccessGates === true,
    );
    if (!options.userAuthored) sources = [...(options.trustedSourceIds ?? consumed)];
  }
  sources = await unionLearningSources(tx, sources, await evidenceSources(tx, evidence));
  for (const memoryId of options.memoryIds ?? [])
    sources = await unionLearningSources(
      tx,
      sources,
      await learningSourcesFor(tx, { kind: "memory", id: memoryId }),
    );
  return sources;
}

export async function authorizeLearningSources(
  tx: Transaction,
  context: LearningOperationContext,
  decisionIds: readonly string[],
): Promise<void> {
  const reads = [];
  for (const row of await learningSourceRows(tx, decisionIds)) {
    const request: AuthorizationRequest = {
      ...context,
      resourceId: stringColumn(row, "resource_id"),
      action: stringColumn(row, "action"),
      policyCondition: readPolicyCondition(row),
    };
    const decision = await evaluate(tx, request);
    if (decision.decision !== "ALLOW") throw new MemorySourceDeniedError(decision, request);
    reads.push({ id: decision.id, source: sourceClassification(row) });
  }
  if (context.runId)
    for (const read of reads)
      await tx.execute({
        sql: "UPDATE authorization_decisions SET delivery_source = ? WHERE id = ?",
        args: [read.source, read.id],
      });
}

export async function setLearningSources(
  tx: Transaction,
  target: LearningSourceTarget,
  decisionIds: readonly string[],
): Promise<void> {
  await tx.execute({
    sql: `UPDATE ${tableFor(target.kind)} SET source_dependencies_json = ? WHERE id = ?`,
    args: [sourceDependenciesJson(decisionIds), target.id],
  });
}

/** A raw import is server-selected archive text, not an inference from the surrounding Run. */
export async function verifiedQQImportSources(
  tx: Transaction,
  context: LearningOperationContext,
  input: {
    candidateKind: string;
    proposedType: string;
    subject: unknown;
    statement: string;
    content: unknown;
    source: { kind: string; ref: string };
    sourceEvidence: readonly MemoryEvidence[];
    confidence?: number;
    sensitivity?: string;
    mergeHint: unknown;
    extensions: unknown;
  },
): Promise<string[]> {
  if (
    !context.runId ||
    input.candidateKind !== "derived" ||
    input.proposedType !== "semantic_fact" ||
    input.source.kind !== "external" ||
    !input.source.ref.startsWith("qq:") ||
    input.sourceEvidence.length !== 1
  )
    return unavailable();
  const evidence = input.sourceEvidence[0]!;
  const metadata = evidence.metadata;
  if (!metadata || typeof metadata.authorizationDecisionId !== "string") return unavailable();
  const [decision] = await learningSourceRows(tx, [metadata.authorizationDecisionId]);
  if (
    !decision ||
    decision.run_id !== context.runId ||
    decision.principal_id !== context.caller.principalId ||
    decision.conversation_id !== (context.conversationId ?? null)
  )
    return unavailable();
  const condition = readPolicyCondition(decision);
  if (
    !condition ||
    condition.kind !== "qq_memory_source" ||
    condition.connectionId !== context.caller.scope.connectionId
  )
    return unavailable();
  const rows = await tx.execute({
    sql: "SELECT * FROM channel_messages WHERE id = ? AND connection_id = ? AND group_id = ? AND source_class = ?",
    args: [
      input.source.ref.slice(3),
      condition.connectionId,
      condition.groupId,
      condition.sourceClass,
    ],
  });
  const row = rows.rows[0];
  if (!row) return unavailable();
  const text = stringColumn(row, "normalized_text");
  const statement = text.slice(0, 8_000);
  const expectedMetadata = {
    channel: "qq",
    groupResourceId: `group:${condition.groupId}`,
    groupId: condition.groupId,
    category: condition.sourceClass === "metadata" ? "group_info" : condition.sourceClass,
    sourceReadRunId: context.runId,
    authorizationDecisionId: metadata.authorizationDecisionId,
    occurredAt: row.occurred_at,
    ...(row.external_message_id ? { externalMessageId: row.external_message_id } : {}),
    ...(row.sender_id ? { senderId: row.sender_id } : {}),
    untrustedInput: true,
  };
  if (
    input.statement !== statement ||
    stable(input.content) !== stable({ statement }) ||
    stable(input.subject) !== stable({ kind: "user", id: context.caller.principalId }) ||
    stable(metadata) !== stable(expectedMetadata) ||
    evidence.kind !== "external_record" ||
    evidence.ref !== input.source.ref ||
    evidence.excerpt !== text.slice(0, 500) ||
    evidence.trustLevel !== "low" ||
    input.confidence !== 0.5 ||
    input.sensitivity !== "confidential" ||
    stable(input.mergeHint) !== stable({ strategy: "manual_review_required" }) ||
    stable(input.extensions) !==
      stable({ "glassbox:source": "authorized-qq", "glassbox:untrusted": true })
  )
    return unavailable();
  return [metadata.authorizationDecisionId];
}
