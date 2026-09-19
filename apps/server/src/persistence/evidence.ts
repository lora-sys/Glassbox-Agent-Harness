import { randomUUID } from "node:crypto";
import { authorizedValue, evaluate, type AuthorizedResult } from "../auth/service.js";
import {
  agentResourceId,
  authorizeRun,
  makePage,
  pageParameters,
  type Page,
  type PageOptions,
} from "../conversation/store.js";
import { requireIdentifier, scopeKey, type CallerContext } from "../identity/scope.js";
import { DomainDatabase, optionalString, stringColumn } from "./database.js";

export interface TraceCursor {
  runId: string;
  traceRef: string;
  byteOffset: number;
  eventCount: number;
}
export interface EvalResultInput {
  runId: string;
  sampleId: string;
  scorerVersion: string;
  traceRef: string;
  traceStart: number;
  traceEnd: number;
  expected: string;
  observed: string;
  passed: boolean;
  inputTokens?: number | null;
  outputTokens?: number | null;
  durationMs?: number | null;
}
export interface EvalResult extends EvalResultInput {
  id: string;
  createdAt: string;
}
export interface DecisionRecord {
  id: string;
  decision: string;
  reason: string;
  resourceId: string;
  action: string;
  grantId: string | null;
  approvalId: string | null;
  conversationId: string | null;
  runId: string | null;
  createdAt: string;
}

function counter(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid evidence counter");
}

export class EvidenceStore {
  constructor(private readonly db: DomainDatabase) {}

  /** Guard the external Trace read as well as the eventual Eval mutation. */
  async assertEvalAccess(caller: CallerContext, runId: string): Promise<void> {
    authorizedValue(
      await this.db.transaction<AuthorizedResult<void>>(async (tx) => {
        for (const action of ["conversation:read", "eval:write"]) {
          const decision = await authorizeRun(tx, caller, runId, action);
          if ("denied" in decision) return decision;
        }
        return { value: undefined };
      }),
    );
  }

  async getEval(caller: CallerContext, runId: string, evalId: string): Promise<EvalResult | null> {
    requireIdentifier(evalId);
    return authorizedValue(
      await this.db.transaction<AuthorizedResult<EvalResult | null>>(async (tx) => {
        const decision = await authorizeRun(tx, caller, runId, "conversation:read");
        if ("denied" in decision) return decision;
        const result = await tx.execute({
          sql: "SELECT * FROM eval_results WHERE id = ? AND run_id = ?",
          args: [evalId, runId],
        });
        const row = result.rows[0];
        return {
          value: row
            ? {
                id: stringColumn(row, "id"),
                runId,
                sampleId: stringColumn(row, "sample_id"),
                scorerVersion: stringColumn(row, "scorer_version"),
                traceRef: stringColumn(row, "trace_ref"),
                traceStart: Number(row.trace_start),
                traceEnd: Number(row.trace_end),
                expected: stringColumn(row, "expected"),
                observed: stringColumn(row, "observed"),
                passed: row.passed === 1,
                inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
                outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
                durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
                createdAt: stringColumn(row, "created_at"),
              }
            : null,
        };
      }),
    );
  }

  /** Raw JSONL is external evidence. Only advance after a complete record has
   * been read; this transaction never claims to commit the file append itself. */
  async advanceTrace(caller: CallerContext, cursor: TraceCursor): Promise<void> {
    requireIdentifier(cursor.traceRef);
    counter(cursor.byteOffset);
    counter(cursor.eventCount);
    authorizedValue(
      await this.db.transaction<AuthorizedResult<void>>(async (tx) => {
        const decision = await authorizeRun(tx, caller, cursor.runId, "trace:write");
        if ("denied" in decision) return decision;
        const result = await tx.execute({
          sql: "INSERT INTO trace_cursors(run_id, trace_ref, byte_offset, event_count, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET byte_offset = excluded.byte_offset, event_count = excluded.event_count, updated_at = excluded.updated_at WHERE trace_cursors.trace_ref = excluded.trace_ref AND trace_cursors.byte_offset <= excluded.byte_offset AND trace_cursors.event_count <= excluded.event_count",
          args: [
            cursor.runId,
            cursor.traceRef,
            cursor.byteOffset,
            cursor.eventCount,
            new Date().toISOString(),
          ],
        });
        if (result.rowsAffected !== 1)
          throw new Error("Trace cursor cannot move backwards or replace evidence");
        return { value: undefined };
      }),
    );
  }

  async getTrace(caller: CallerContext, runId: string): Promise<TraceCursor | null> {
    return authorizedValue(
      await this.db.transaction<AuthorizedResult<TraceCursor | null>>(async (tx) => {
        const decision = await authorizeRun(tx, caller, runId, "conversation:read");
        if ("denied" in decision) return decision;
        const result = await tx.execute({
          sql: "SELECT * FROM trace_cursors WHERE run_id = ?",
          args: [runId],
        });
        const row = result.rows[0];
        return {
          value: row
            ? {
                runId,
                traceRef: stringColumn(row, "trace_ref"),
                byteOffset: Number(row.byte_offset),
                eventCount: Number(row.event_count),
              }
            : null,
        };
      }),
    );
  }

  async recordEval(caller: CallerContext, input: EvalResultInput): Promise<string> {
    for (const value of [input.sampleId, input.scorerVersion, input.traceRef])
      requireIdentifier(value);
    for (const value of [
      input.traceStart,
      input.traceEnd,
      input.inputTokens,
      input.outputTokens,
      input.durationMs,
    ])
      if (value !== null && value !== undefined) counter(value);
    if (input.traceEnd < input.traceStart || typeof input.passed !== "boolean")
      throw new Error("Invalid Eval result");
    for (const value of [input.expected, input.observed])
      if (typeof value !== "string" || value.length > 32_000)
        throw new Error("Eval evidence exceeds the accepted text limit");
    return authorizedValue(
      await this.db.transaction<AuthorizedResult<string>>(async (tx) => {
        const decision = await authorizeRun(tx, caller, input.runId, "eval:write");
        if ("denied" in decision) return decision;
        const traces = await tx.execute({
          sql: "SELECT trace_ref, event_count FROM trace_cursors WHERE run_id = ?",
          args: [input.runId],
        });
        const trace = traces.rows[0];
        if (
          !trace ||
          stringColumn(trace, "trace_ref") !== input.traceRef ||
          Number(trace.event_count) < input.traceEnd
        )
          throw new Error("Eval must reference indexed Run evidence");
        const id = randomUUID();
        await tx.execute({
          sql: "INSERT INTO eval_results(id, run_id, sample_id, scorer_version, trace_ref, trace_start, trace_end, expected, observed, passed, input_tokens, output_tokens, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          args: [
            id,
            input.runId,
            input.sampleId,
            input.scorerVersion,
            input.traceRef,
            input.traceStart,
            input.traceEnd,
            input.expected,
            input.observed,
            input.passed ? 1 : 0,
            input.inputTokens ?? null,
            input.outputTokens ?? null,
            input.durationMs ?? null,
            new Date().toISOString(),
          ],
        });
        return { value: id };
      }),
    );
  }

  async listEvals(
    caller: CallerContext,
    runId: string,
    options: PageOptions = {},
  ): Promise<Page<EvalResult>> {
    const page = pageParameters(options);
    return authorizedValue(
      await this.db.transaction<AuthorizedResult<Page<EvalResult>>>(async (tx) => {
        const decision = await authorizeRun(tx, caller, runId, "conversation:read");
        if ("denied" in decision) return decision;
        const rows = await tx.execute({
          sql: "SELECT * FROM eval_results WHERE run_id = ? AND (created_at, id) > (?, ?) ORDER BY created_at, id LIMIT ?",
          args: [runId, page.afterTime, page.afterId, page.limit + 1],
        });
        return {
          value: makePage(rows.rows, page.limit, (row) => ({
            id: stringColumn(row, "id"),
            runId,
            sampleId: stringColumn(row, "sample_id"),
            scorerVersion: stringColumn(row, "scorer_version"),
            traceRef: stringColumn(row, "trace_ref"),
            traceStart: Number(row.trace_start),
            traceEnd: Number(row.trace_end),
            expected: stringColumn(row, "expected"),
            observed: stringColumn(row, "observed"),
            passed: row.passed === 1,
            inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
            outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
            durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
            createdAt: stringColumn(row, "created_at"),
          })),
        };
      }),
    );
  }

  async listDecisions(
    caller: CallerContext,
    agentId: string,
    options: PageOptions = {},
  ): Promise<Page<DecisionRecord>> {
    const page = pageParameters(options);
    return authorizedValue(
      await this.db.transaction<AuthorizedResult<Page<DecisionRecord>>>(async (tx) => {
        const decision = await evaluate(tx, {
          caller,
          resourceId: agentResourceId(agentId),
          action: "conversation:read",
        });
        if (decision.decision !== "ALLOW") return { denied: decision };
        const rows = await tx.execute({
          sql: "SELECT * FROM authorization_decisions WHERE principal_id = ? AND scope_key = ? AND (created_at, id) > (?, ?) ORDER BY created_at, id LIMIT ?",
          args: [
            caller.principalId,
            scopeKey(caller.scope),
            page.afterTime,
            page.afterId,
            page.limit + 1,
          ],
        });
        return {
          value: makePage(rows.rows, page.limit, (row) => ({
            id: stringColumn(row, "id"),
            decision: stringColumn(row, "decision"),
            reason: stringColumn(row, "reason"),
            resourceId: stringColumn(row, "resource_id"),
            action: stringColumn(row, "action"),
            grantId: optionalString(row, "grant_id"),
            approvalId: optionalString(row, "approval_id"),
            conversationId: optionalString(row, "conversation_id"),
            runId: optionalString(row, "run_id"),
            createdAt: stringColumn(row, "created_at"),
          })),
        };
      }),
    );
  }
}
