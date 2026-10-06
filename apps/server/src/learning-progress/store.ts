import { randomUUID } from "node:crypto";
import type { Row, Transaction } from "@libsql/client";
import {
  AccessDeniedError,
  evaluate,
  recordDecision,
  type AuthorizationService,
} from "../auth/service.js";
import type { AuthorizationPolicyCondition } from "../auth/policy-condition.js";
import {
  requireIdentifier,
  scopeKey,
  validateScope,
  type TrustedChannelScope,
} from "../identity/scope.js";
import { DomainDatabase, stringColumn } from "../persistence/database.js";
import { classifyLearningProgress, isSafeProgressText, repeatedQuestionCue } from "./classifier.js";
import { parseLearningProgressCommand } from "./commands.js";
import { tokenizeText } from "../retrieval/tokenizer.js";
import type {
  LearningProgressContext,
  LearningProgressList,
  LearningProgressRecord,
} from "./contracts.js";
import {
  learningProgressPersonKey,
  learningProgressResourceId,
  progressPolicyAllows,
  type ProgressSourceCondition,
} from "./policy.js";

const WRITE = "progress:write";
const READ = "progress:read";
const MANAGE = "progress:manage";

interface TrustedRunInput {
  runId: string;
  conversationId: string;
  messageId: string;
  text: string;
  scope: TrustedChannelScope;
}

function sameScope(left: TrustedChannelScope, right: TrustedChannelScope): boolean {
  try {
    validateScope(left);
    validateScope(right);
    return scopeKey(left) === scopeKey(right);
  } catch {
    return false;
  }
}

function contextMatchesRun(
  context: LearningProgressContext,
  run: {
    runId: string;
    conversationId: string;
    principalId: string;
    scopeJson: string;
    source: string;
  },
): boolean {
  if (
    run.runId !== context.runId ||
    run.conversationId !== context.conversationId ||
    run.principalId !== context.caller.principalId ||
    run.source !== "external"
  )
    return false;
  try {
    const runScope = JSON.parse(run.scopeJson) as TrustedChannelScope;
    return sameScope(runScope, context.caller.scope);
  } catch {
    return false;
  }
}

async function loadTrustedRunInput(
  tx: Transaction,
  context: LearningProgressContext,
): Promise<TrustedRunInput | null> {
  if (!context.runId || !context.conversationId) return null;
  const rows = await tx.execute({
    sql: `SELECT r.id AS run_id, r.conversation_id, r.principal_id, r.scope_json, r.source,
                 m.id AS message_id, m.text
          FROM runs r JOIN messages m ON m.id = r.message_id
          WHERE r.id = ? AND r.conversation_id = ? LIMIT 1`,
    args: [context.runId, context.conversationId],
  });
  const row = rows.rows[0];
  if (!row) return null;
  const run = {
    runId: stringColumn(row, "run_id"),
    conversationId: stringColumn(row, "conversation_id"),
    principalId: stringColumn(row, "principal_id"),
    scopeJson: stringColumn(row, "scope_json"),
    source: stringColumn(row, "source"),
  };
  if (!contextMatchesRun(context, run)) return null;
  return {
    runId: run.runId,
    conversationId: run.conversationId,
    messageId: stringColumn(row, "message_id"),
    text: stringColumn(row, "text"),
    scope: JSON.parse(run.scopeJson) as TrustedChannelScope,
  };
}

function condition(recordId: string, revision: number): ProgressSourceCondition {
  return { version: 1, kind: "learning_progress", recordId, revision };
}

function lexicalScore(text: string, query: string): number {
  const left = tokenizeText(text);
  const right = tokenizeText(query);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection++;
  return intersection / (left.size + right.size - intersection);
}

function request(
  context: LearningProgressContext,
  action: string,
  policyCondition?: ProgressSourceCondition,
) {
  return {
    caller: context.caller,
    resourceId: learningProgressResourceId(context.caller),
    action,
    ...(context.conversationId ? { conversationId: context.conversationId } : {}),
    ...(context.runId ? { runId: context.runId } : {}),
    ...(policyCondition
      ? { policyCondition: policyCondition as unknown as AuthorizationPolicyCondition }
      : {}),
  };
}

async function audit(
  tx: Transaction,
  context: LearningProgressContext,
  action: "capture" | "read" | "correct" | "delete" | "confirm",
  targetId: string,
  decisionId: string,
): Promise<void> {
  await tx.execute({
    sql: `INSERT INTO learning_progress_audit
      (id, person_key, principal_id, action, target_id, decision_id, conversation_id, run_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      randomUUID(),
      learningProgressPersonKey(context.caller),
      context.caller.principalId,
      action,
      targetId,
      decisionId,
      context.conversationId ?? null,
      context.runId ?? null,
      new Date().toISOString(),
    ],
  });
}

function recordFromRow(row: Row): LearningProgressRecord {
  const sourceScope = JSON.parse(stringColumn(row, "source_scope_json")) as TrustedChannelScope;
  return {
    id: stringColumn(row, "id"),
    principalId: stringColumn(row, "principal_id"),
    kind: stringColumn(row, "kind") as LearningProgressRecord["kind"],
    state: stringColumn(row, "state") as LearningProgressRecord["state"],
    statement: stringColumn(row, "statement"),
    confidence: Number(row.confidence),
    revision: Number(row.revision),
    source: {
      runId: stringColumn(row, "source_run_id"),
      messageId: stringColumn(row, "source_message_id"),
      chatType: sourceScope.chatType,
      connectionId: sourceScope.connectionId,
      botId: sourceScope.botId,
      chatId: sourceScope.chatId,
      senderId: sourceScope.senderId,
    },
    createdAt: stringColumn(row, "created_at"),
    updatedAt: stringColumn(row, "updated_at"),
  };
}

export class LearningProgressStore {
  constructor(
    private readonly db: DomainDatabase,
    // Kept in the composition contract alongside the other stores. Decisions are evaluated
    // inside the data transaction so authorization and mutations share one snapshot.
    _authorization?: AuthorizationService,
  ) {}

  /** Capture only from the persisted external input of this exact current Run. */
  async captureCurrentRun(
    context: LearningProgressContext,
  ): Promise<LearningProgressRecord | null> {
    const result = await this.db.transaction(async (tx) => {
      const decision = await evaluate(tx, request(context, WRITE));
      if (decision.decision !== "ALLOW") return { denied: decision };
      const input = await loadTrustedRunInput(tx, context);
      if (!input)
        return {
          denied: await recordDecision(tx, request(context, WRITE), "DENY", "scope_mismatch"),
        };
      const captured = await tx.execute({
        sql: `SELECT target_id FROM learning_progress_audit
              WHERE person_key = ? AND run_id = ? AND action = 'capture' ORDER BY sequence DESC LIMIT 1`,
        args: [learningProgressPersonKey(context.caller), input.runId],
      });
      if (captured.rows[0]) {
        const prior = await tx.execute({
          sql: "SELECT * FROM learning_progress_records WHERE id = ? AND state != 'deleted' AND (kind != 'question_cue' OR occurrence_count >= 2)",
          args: [stringColumn(captured.rows[0], "target_id")],
        });
        return {
          decisionId: decision.id,
          record: prior.rows[0] ? recordFromRow(prior.rows[0]) : null,
        };
      }
      const command = parseLearningProgressCommand(input.text);
      const content = command?.action === "capture" ? (command.statement ?? "") : input.text;
      let classified = classifyLearningProgress(content);
      if (
        !classified &&
        command?.action === "capture" &&
        command.statement &&
        command.statement.length >= 2 &&
        command.statement.length <= 180 &&
        isSafeProgressText(command.statement)
      ) {
        classified = { kind: "goal", statement: command.statement.trim(), confidence: 0.85 };
      }
      const cue = classified ? null : repeatedQuestionCue(content);
      if (!classified && !cue) return { decisionId: decision.id, record: null };
      const personKey = learningProgressPersonKey(context.caller);
      const now = new Date().toISOString();
      const existing = cue
        ? await tx.execute({
            sql: `SELECT id, occurrence_count, revision FROM learning_progress_records
                  WHERE person_key = ? AND kind = 'question_cue' AND state != 'deleted'
                    AND statement = ? AND source_scope_key = ? LIMIT 1`,
            args: [personKey, cue, scopeKey(input.scope)],
          })
        : { rows: [] };
      let id: string;
      let revision = 1;
      let count = 1;
      if (existing.rows[0]) {
        id = stringColumn(existing.rows[0], "id");
        count = Number(existing.rows[0].occurrence_count) + 1;
        revision = Number(existing.rows[0].revision) + 1;
        await tx.execute({
          sql: "UPDATE learning_progress_records SET occurrence_count = ?, revision = ?, updated_at = ? WHERE id = ? AND state != 'deleted'",
          args: [count, revision, now, id],
        });
      } else {
        id = randomUUID();
        const kind = classified?.kind ?? "question_cue";
        const statement = classified?.statement ?? cue!;
        const confidence = classified?.confidence ?? 0.25;
        await tx.execute({
          sql: `INSERT INTO learning_progress_records
            (id, person_key, principal_id, kind, state, statement, confidence, connection_id,
             bot_id, sender_id, source_chat_type, source_chat_id, source_scope_json,
             source_scope_key, source_run_id, source_message_id, revision, occurrence_count, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'observed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
          args: [
            id,
            personKey,
            context.caller.principalId,
            kind,
            statement,
            confidence,
            input.scope.connectionId,
            input.scope.botId,
            input.scope.senderId,
            input.scope.chatType,
            input.scope.chatId,
            JSON.stringify(input.scope),
            scopeKey(input.scope),
            input.runId,
            input.messageId,
            now,
            now,
          ],
        });
      }
      await audit(tx, context, "capture", id, decision.id);
      const row = await tx.execute({
        sql: "SELECT * FROM learning_progress_records WHERE id = ?",
        args: [id],
      });
      const record = recordFromRow(row.rows[0]!);
      return { decisionId: decision.id, record: cue && count < 2 ? null : record };
    });
    if ("denied" in result && result.denied) throw new AccessDeniedError(result.denied);
    return result.record;
  }

  /** List the user's authorized progress, after each source condition passes. */
  async list(
    context: LearningProgressContext,
    options: { query?: string; limit?: number } = {},
  ): Promise<LearningProgressRecord[]> {
    return (await this.inspect(context, options)).records;
  }

  async inspect(
    context: LearningProgressContext,
    options: { query?: string; limit?: number } = {},
  ): Promise<LearningProgressList> {
    const query = options.query?.trim() ?? "";
    const limit = Math.max(1, Math.min(options.limit ?? (query ? 4 : 40), query ? 4 : 40));
    const result = await this.db.transaction(async (tx) => {
      const gate = await evaluate(tx, request(context, READ));
      if (gate.decision !== "ALLOW") return { denied: gate };
      const rows = await tx.execute({
        sql: `SELECT id, person_key, principal_id, kind, state, connection_id, bot_id, sender_id,
                     source_chat_type, source_chat_id, source_scope_json, source_scope_key, source_run_id,
                     source_message_id, revision, occurrence_count, confidence,
                     created_at, updated_at
              FROM learning_progress_records WHERE person_key = ? AND state != 'deleted'
              ORDER BY updated_at DESC, id LIMIT 5001`,
        args: [learningProgressPersonKey(context.caller)],
      });
      const eligible: { row: Row; score: number; decisionId: string; statement: string }[] = [];
      for (const row of rows.rows) {
        if (row.kind === "question_cue" && Number(row.occurrence_count) < 2) continue;
        const id = stringColumn(row, "id");
        const revision = Number(row.revision);
        const decision = await evaluate(tx, request(context, READ, condition(id, revision)));
        if (decision.decision !== "ALLOW") continue;
        const body = await tx.execute({
          sql: "SELECT statement FROM learning_progress_records WHERE id = ? AND revision = ? AND state != 'deleted'",
          args: [id, revision],
        });
        if (!body.rows[0]) continue;
        const statement = stringColumn(body.rows[0], "statement");
        await audit(tx, context, "read", id, decision.id);
        const score = query ? lexicalScore(statement, query) : 0;
        if (query && score <= 0) continue;
        eligible.push({ row, score, decisionId: decision.id, statement });
      }
      eligible.sort((a, b) =>
        query
          ? b.score - a.score ||
            stringColumn(b.row, "updated_at").localeCompare(stringColumn(a.row, "updated_at")) ||
            stringColumn(a.row, "id").localeCompare(stringColumn(b.row, "id"))
          : stringColumn(b.row, "updated_at").localeCompare(stringColumn(a.row, "updated_at")) ||
            stringColumn(a.row, "id").localeCompare(stringColumn(b.row, "id")),
      );
      const selected = eligible.slice(0, limit);
      const records: LearningProgressRecord[] = [];
      for (const { row, decisionId } of selected) {
        const id = stringColumn(row, "id");
        await tx.execute({
          sql: "UPDATE authorization_decisions SET delivery_source = 'content_source' WHERE id = ? AND decision = 'ALLOW'",
          args: [decisionId],
        });
        const body = await tx.execute({
          sql: "SELECT * FROM learning_progress_records WHERE id = ?",
          args: [id],
        });
        if (body.rows[0]) records.push(recordFromRow(body.rows[0]));
      }
      return {
        records,
        truncated: query
          ? rows.rows.length >= 5001
          : eligible.length > limit || rows.rows.length >= 5001,
      };
    });
    if ("denied" in result && result.denied) throw new AccessDeniedError(result.denied);
    return { records: result.records, truncated: result.truncated };
  }

  /** Recheck precisely the revisions that were loaded into prompt Context. */
  async authorizeContext(
    context: LearningProgressContext,
    records: readonly LearningProgressRecord[],
  ): Promise<void> {
    if (records.length > 100) throw new Error("Too many learning progress records");
    const result = await this.db.transaction(async (tx) => {
      for (const record of records) {
        const decision = await evaluate(
          tx,
          request(context, READ, condition(record.id, record.revision)),
        );
        if (decision.decision !== "ALLOW") return { denied: decision };
      }
      if (records.length > 0) {
        const delivery = await evaluate(tx, request(context, "delivery:send"));
        if (delivery.decision !== "ALLOW") return { denied: delivery };
      }
      return { allowed: true as const };
    });
    if ("denied" in result && result.denied) throw new AccessDeniedError(result.denied);
  }

  /** The command is parsed from the persisted current Run input, never model arguments. */
  async executeCommandFromCurrentRun(context: LearningProgressContext): Promise<
    | { action: "list"; records: LearningProgressRecord[]; truncated: boolean }
    | { action: "capture"; record: LearningProgressRecord | null }
    | {
        action: "correct" | "delete" | "confirm";
        recordId: string;
        records: LearningProgressRecord[];
        truncated: boolean;
      }
    | null
  > {
    const input = await this.db.transaction(async (tx) => {
      const decision = await evaluate(tx, request(context, READ));
      if (decision.decision !== "ALLOW") return { denied: decision };
      const value = await loadTrustedRunInput(tx, context);
      if (!value)
        return {
          denied: await recordDecision(tx, request(context, READ), "DENY", "scope_mismatch"),
        };
      return { input: value.text };
    });
    if ("denied" in input && input.denied) throw new AccessDeniedError(input.denied);
    const command = parseLearningProgressCommand(input.input);
    if (!command) return null;
    if (command.action === "list") return { action: "list", ...(await this.inspect(context)) };
    if (command.action === "capture")
      return { action: "capture", record: await this.captureCurrentRun(context) };
    const updated = await this.mutate(
      context,
      command.action,
      command.recordId!,
      command.statement,
    );
    const listed = updated ? await this.inspect(context) : { records: [], truncated: false };
    return { action: command.action, recordId: command.recordId!, ...listed };
  }

  private async mutate(
    context: LearningProgressContext,
    action: "correct" | "delete" | "confirm",
    recordId: string,
    statement?: string,
  ): Promise<boolean> {
    requireIdentifier(recordId);
    if (
      action === "correct" &&
      (!statement || !isSafeProgressText(statement) || statement.length > 500)
    )
      throw new Error("Invalid progress correction");
    const result = await this.db.transaction(async (tx) => {
      const manage = await evaluate(tx, request(context, MANAGE));
      if (manage.decision !== "ALLOW") return { denied: manage };
      const meta = await tx.execute({
        sql: `SELECT revision FROM learning_progress_records WHERE id = ? AND person_key = ?
              AND principal_id = ? AND state != 'deleted'`,
        args: [recordId, learningProgressPersonKey(context.caller), context.caller.principalId],
      });
      if (!meta.rows[0])
        return {
          denied: await recordDecision(tx, request(context, MANAGE), "DENY", "resource_missing"),
        };
      const policy = condition(recordId, Number(meta.rows[0].revision));
      if (!(await progressPolicyAllows(tx, context.caller, policy)))
        return {
          denied: await recordDecision(
            tx,
            request(context, MANAGE),
            "DENY",
            "source_policy_denied",
          ),
        };
      const now = new Date().toISOString();
      const update =
        action === "correct"
          ? await tx.execute({
              sql: "UPDATE learning_progress_records SET statement = ?, kind = 'goal', state = 'observed', revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND state != 'deleted'",
              args: [statement!.trim(), now, recordId, Number(meta.rows[0].revision)],
            })
          : action === "confirm"
            ? await tx.execute({
                sql: "UPDATE learning_progress_records SET state = 'confirmed', revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND state != 'deleted'",
                args: [now, recordId, Number(meta.rows[0].revision)],
              })
            : await tx.execute({
                sql: "UPDATE learning_progress_records SET state = 'deleted', statement = '', revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND state != 'deleted'",
                args: [now, recordId, Number(meta.rows[0].revision)],
              });
      if (update.rowsAffected !== 1)
        return {
          denied: await recordDecision(
            tx,
            request(context, MANAGE),
            "DENY",
            "source_read_unverified",
          ),
        };
      await audit(tx, context, action, recordId, manage.id);
      return { changed: true as const };
    });
    if ("denied" in result && result.denied) throw new AccessDeniedError(result.denied);
    return result.changed;
  }
}
