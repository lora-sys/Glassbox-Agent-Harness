import { readPolicyCondition } from "../auth/policy-condition.js";
import { recordFilteredDecision } from "../auth/filtered-decision.js";
import {
  readRunSourceRows,
  readTaskSourceRows,
  reauthorizeSourceRows,
  sourceClassification,
} from "../auth/source-dependencies.js";
import { randomUUID } from "node:crypto";
import type { Row, Transaction } from "@libsql/client";
import {
  authorizedValue,
  evaluate,
  recordDecision,
  type AuthorizedResult,
  type AuthorizationDecision,
} from "../auth/service.js";
import { resolveIdentity } from "../identity/service.js";
import {
  conversationScopeKey,
  requireIdentifier,
  scopeKey,
  type CallerContext,
  type TrustedChannelScope,
} from "../identity/scope.js";
import { DomainDatabase, optionalString, stringColumn } from "../persistence/database.js";
import { parseCheckpointWriteSpec, parseTaskGetSpec } from "../ops/tool-step-spec.js";
import { parseWorkerTextFileSpec } from "../ops/worker-file-spec.js";

export type RunStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "cancelled"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "unknown";
export interface ConversationRecord {
  id: string;
  agentId: string;
  principalId: string;
  scope: TrustedChannelScope;
  providerKind: string | null;
  providerSessionId: string | null;
  providerSessionPrincipalId?: string | null;
  createdAt: string;
}
export interface RunRecord {
  id: string;
  conversationId: string;
  messageId: string;
  source: "external" | "task_step";
  principalId: string;
  executionRef: string;
  /** Server-owned snapshot, only supplied for a persisted Owner-private Channel preference. */
  channelDefaultExecutionRef?: string;
  status: RunStatus;
  resultText: string | null;
  /** Why a non-succeeded Run produced no usable text, when the adapter could name a cause. */
  failureCode?: string;
  createdAt: string;
  updatedAt: string;
}
export type StepResultRecord =
  | {
      stepId: string;
      runId: string;
      sourceRef?: never;
      text: string;
      truncated: boolean;
    }
  | {
      stepId: string;
      runId?: never;
      sourceRef: string;
      text: string;
      truncated: boolean;
    };
export interface InternalStepRunInput {
  caller: CallerContext;
  taskId: string;
  stepId: string;
  attemptId: string;
  executionRef: string;
}
export interface PageOptions {
  limit?: number;
  cursor?: string;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export interface IncomingMessage {
  agentId: string;
  scope: TrustedChannelScope;
  messageId: string;
  text: string;
  executionRef: string;
  /** Trusted Channel ingress only; never accepted from external request payloads. */
  channelDefaultExecutionRef?: string;
  approvalId?: string;
  images?: readonly IncomingImage[];
  imageFailureCode?: IncomingImageFailure;
}
export type IncomingImageMimeType = "image/png" | "image/jpeg" | "image/webp";
export type IncomingImageFailure =
  | "image_unavailable"
  | "image_invalid"
  | "image_too_large"
  | "image_timeout";
export interface IncomingImage {
  mimeType: IncomingImageMimeType;
  data: Buffer;
}
/**
 * Who wrote one turn of a Conversation's history.
 *
 * The principal is the durable identity behind the turn; the QQ number is what a group member
 * can actually see and refer to, and it is what a rendered label carries.
 */
export interface HistoryActor {
  principalId: string;
  senderId?: string;
}

export interface RunInputRecord {
  run: RunRecord;
  conversation: ConversationRecord;
  text: string;
  images?: Array<{ mimeType: IncomingImageMimeType; data: string }>;
  imageFailureCode?: IncomingImageFailure;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  /**
   * One entry per history turn, in the same order, naming the principal who spoke it.
   *
   * Present only where the Conversation is shared between senders. A group keeps one Conversation
   * for everyone in it, so its history interleaves several principals; without this, a turn the
   * Owner wrote and a turn a visitor wrote arrive at the model as the same unattributed voice,
   * and the current speaker inherits every claim either of them made.
   */
  historyActors?: HistoryActor[];
  /** One Run id per complete user/assistant exchange in history. */
  historyRunIds?: string[];
  /** A bounded source scan or load bound was reached after authorization checks. */
  historyScanTruncated?: boolean;
  historyOmittedRunIds?: string[];
  providerSessionId: string | null;
  taskStepBinding?: { taskId: string; stepId: string; attemptId: string };
  /** Current-authorized excerpts from accepted direct Step dependencies. */
  stepResults?: StepResultRecord[];
}

export function agentResourceId(agentId: string): string {
  requireIdentifier(agentId);
  return `agent:${agentId}`;
}

export function runRecord(row: Row): RunRecord {
  return {
    id: stringColumn(row, "id"),
    conversationId: stringColumn(row, "conversation_id"),
    messageId: stringColumn(row, "message_id"),
    source: stringColumn(row, "source") as RunRecord["source"],
    principalId: stringColumn(row, "principal_id"),
    executionRef: stringColumn(row, "execution_ref"),
    ...(typeof row.channel_default_execution_ref === "string"
      ? { channelDefaultExecutionRef: row.channel_default_execution_ref }
      : {}),
    status: stringColumn(row, "status") as RunStatus,
    resultText: optionalString(row, "result_text"),
    ...(optionalString(row, "failure_code") === null
      ? {}
      : { failureCode: optionalString(row, "failure_code")! }),
    createdAt: stringColumn(row, "created_at"),
    updatedAt: stringColumn(row, "updated_at"),
  };
}

function conversationRecord(row: Row, scope: TrustedChannelScope): ConversationRecord {
  return {
    id: stringColumn(row, "id"),
    agentId: stringColumn(row, "agent_id"),
    principalId: stringColumn(row, "principal_id"),
    scope: { ...scope },
    providerKind: optionalString(row, "provider_kind"),
    providerSessionId: optionalString(row, "provider_session_id"),
    providerSessionPrincipalId: optionalString(row, "provider_session_principal_id"),
    createdAt: stringColumn(row, "created_at"),
  };
}

export function pageParameters(options: PageOptions = {}): {
  limit: number;
  afterTime: string;
  afterId: string;
} {
  const limit = options.limit ?? 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Page limit must be between 1 and 100");
  if (!options.cursor) return { limit, afterTime: "", afterId: "" };
  try {
    if (options.cursor.length > 4096) throw new Error();
    const decoded: unknown = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      decoded.some((value) => typeof value !== "string")
    )
      throw new Error();
    return { limit, afterTime: decoded[0] as string, afterId: decoded[1] as string };
  } catch {
    throw new Error("Invalid page cursor");
  }
}

export function makePage<T>(
  rows: Row[],
  limit: number,
  map: (row: Row) => T,
  cursorColumns: readonly [string, string] = ["created_at", "id"],
): Page<T> {
  const included = rows.slice(0, limit);
  const last = included.at(-1);
  return {
    items: included.map(map),
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify([
              stringColumn(last, cursorColumns[0]),
              stringColumn(last, cursorColumns[1]),
            ]),
          ).toString("base64url")
        : null,
  };
}

/** Reads only addressing metadata until scope, identity and the live grant pass. */
export async function authorizeConversation(
  tx: Transaction,
  caller: CallerContext,
  conversationId: string,
  action: string,
  runId?: string,
  delegatedTaskId?: string,
): Promise<AuthorizedResult<{ agentId: string }>> {
  requireIdentifier(conversationId);
  const result = await tx.execute({
    sql: "SELECT c.agent_id, c.principal_id, c.scope_key, c.scope_json, r.visibility, r.owner_id FROM conversations c JOIN resources r ON r.id = c.resource_id WHERE c.id = ?",
    args: [conversationId],
  });
  const row = result.rows[0];
  if (!row) {
    const denied = await recordDecision(
      tx,
      { caller, resourceId: "conversation", action },
      "DENY",
      "scope_mismatch",
    );
    return { denied };
  }

  const agentId = stringColumn(row, "agent_id");
  const visibility = stringColumn(row, "visibility");
  const ownerId = optionalString(row, "owner_id");
  const storedScopeKey = stringColumn(row, "scope_key");

  const callerLocationKey = conversationScopeKey(caller.scope);
  let matchesLocation = storedScopeKey === callerLocationKey;
  if (!matchesLocation) {
    const loc = await tx.execute({
      sql: "SELECT 1 FROM conversation_locations WHERE conversation_id = ? AND location_key = ?",
      args: [conversationId, callerLocationKey],
    });
    if (loc.rows.length > 0) {
      matchesLocation = true;
    } else {
      try {
        const storedScope = JSON.parse(stringColumn(row, "scope_json"));
        if (conversationScopeKey(storedScope) === callerLocationKey) {
          matchesLocation = true;
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  if (!matchesLocation) {
    const denied = await recordDecision(
      tx,
      { caller, resourceId: "conversation", action },
      "DENY",
      "scope_mismatch",
    );
    return { denied };
  }

  if (
    visibility === "private" &&
    caller.principalId !== (ownerId ?? stringColumn(row, "principal_id"))
  ) {
    const denied = await recordDecision(
      tx,
      { caller, resourceId: "conversation", action },
      "DENY",
      "scope_mismatch",
    );
    return { denied };
  }

  const decision = await evaluate(tx, {
    caller,
    resourceId: agentResourceId(agentId),
    action,
    conversationId,
    ...(runId ? { runId } : {}),
    ...(delegatedTaskId ? { delegatedTaskId } : {}),
  });
  return decision.decision === "ALLOW" ? { value: { agentId } } : { denied: decision };
}

export async function authorizeRun(
  tx: Transaction,
  caller: CallerContext,
  runId: string,
  action: string,
): Promise<AuthorizedResult<{ conversationId: string }>> {
  requireIdentifier(runId);
  const result = await tx.execute({
    sql: "SELECT conversation_id, principal_id, source, execution_ref FROM runs WHERE id = ?",
    args: [runId],
  });
  const row = result.rows[0];
  if (!row)
    return {
      denied: await recordDecision(
        tx,
        { caller, resourceId: "run", action },
        "DENY",
        "scope_mismatch",
      ),
    };
  const conversationId = stringColumn(row, "conversation_id");
  const runPrincipalId = stringColumn(row, "principal_id");

  if (caller.principalId !== runPrincipalId) {
    return {
      denied: await recordDecision(
        tx,
        { caller, resourceId: "run", action, runId, conversationId },
        "DENY",
        "scope_mismatch",
      ),
    };
  }

  if (stringColumn(row, "source") === "task_step") {
    const linkedTask = await tx.execute({
      sql: `SELECT ar.task_id,s.kind,s.spec_ref FROM task_attempt_runs ar
            JOIN task_steps s ON s.id = ar.step_id AND s.task_id = ar.task_id
            WHERE ar.run_id = ?`,
      args: [runId],
    });
    const linkedStep = linkedTask.rows[0];
    const taskId = linkedStep ? stringColumn(linkedStep, "task_id") : null;
    if (!taskId) {
      return {
        denied: await recordDecision(
          tx,
          { caller, resourceId: "run", action, runId, conversationId },
          "DENY",
          "scope_mismatch",
        ),
      };
    }
    const taskAuthorization = await evaluate(tx, {
      caller,
      resourceId: `task-${taskId}`,
      action: "task:read",
      conversationId,
      runId,
    });
    if (taskAuthorization.decision !== "ALLOW") return { denied: taskAuthorization };
    const executionRef = stringColumn(row, "execution_ref");
    if (linkedStep?.kind === "tool" || executionRef.startsWith("tool:")) {
      const readSpec = parseTaskGetSpec(executionRef);
      const writeSpec = parseCheckpointWriteSpec(executionRef);
      if (
        (!readSpec && !writeSpec) ||
        linkedStep?.kind !== "tool" ||
        linkedStep.spec_ref !== executionRef
      )
        return {
          denied: await recordDecision(
            tx,
            { caller, resourceId: "run", action, runId, conversationId },
            "DENY",
            "scope_mismatch",
          ),
        };
      if (readSpec) {
        const targetAuthorization = await evaluate(tx, {
          caller,
          resourceId: `task-${readSpec.targetTaskId}`,
          action: "task:read",
          conversationId,
          runId,
        });
        if (targetAuthorization.decision !== "ALLOW") return { denied: targetAuthorization };
      }
    }
  }

  const authorization = await authorizeConversation(tx, caller, conversationId, action, runId);
  return "denied" in authorization ? authorization : { value: { conversationId } };
}

function matchesDestinationLocation(
  destinationScopeKey: string,
  targetLocationKey: string,
): boolean {
  if (destinationScopeKey === targetLocationKey) return true;
  try {
    const parsed = JSON.parse(destinationScopeKey);
    if (Array.isArray(parsed)) {
      if (parsed.length >= 5) {
        const [conn, bot, chatType, chatId, , thread] = parsed;
        const convKey = JSON.stringify([conn, bot, chatType, chatId, thread ?? null]);
        if (convKey === targetLocationKey) return true;
      }
    } else if (parsed && typeof parsed === "object" && parsed.chatType) {
      if (conversationScopeKey(parsed) === targetLocationKey) return true;
    }
  } catch {
    // ignore parse errors
  }
  return false;
}

export class ConversationStore {
  constructor(private readonly db: DomainDatabase) {}

  /** Management-only setup. Reopening the same configured Agent is idempotent. */
  async createAgent(id: string): Promise<void> {
    const resourceId = agentResourceId(id);
    await this.db.transaction(async (tx) => {
      await tx.execute({
        sql: "INSERT INTO agents(id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING",
        args: [id, new Date().toISOString()],
      });
      await tx.execute({
        sql: "INSERT INTO resources(id, kind, visibility) VALUES (?, 'agent', 'public') ON CONFLICT(id) DO NOTHING",
        args: [resourceId],
      });
    });
  }

  async acceptIncoming(input: IncomingMessage): Promise<{
    conversation: ConversationRecord;
    run: RunRecord;
    duplicate: boolean;
    caller: CallerContext;
  }> {
    requireIdentifier(input.messageId);
    requireIdentifier(input.executionRef);
    if (input.channelDefaultExecutionRef !== undefined)
      requireIdentifier(input.channelDefaultExecutionRef);
    if (typeof input.text !== "string" || input.text.length > 64_000)
      throw new Error("Message exceeds the accepted text limit");
    const images = input.images ?? [];
    if (
      images.length > 4 ||
      (input.imageFailureCode !== undefined && images.length > 0) ||
      images.some(
        (image) =>
          !["image/png", "image/jpeg", "image/webp"].includes(image.mimeType) ||
          !Buffer.isBuffer(image.data) ||
          image.data.length < 1 ||
          image.data.length > 8 * 1024 * 1024,
      ) ||
      images.reduce((sum, image) => sum + image.data.length, 0) > 16 * 1024 * 1024
    )
      throw new Error("Invalid incoming image attachments");
    const key = scopeKey(input.scope);
    const convKey = conversationScopeKey(input.scope);
    const outcome = await this.db.transaction<
      AuthorizedResult<{
        conversation: ConversationRecord;
        run: RunRecord;
        duplicate: boolean;
        caller: CallerContext;
      }>
    >(async (tx) => {
      const principalId = await resolveIdentity(tx, input.scope);
      const caller = { principalId: principalId ?? "unbound", scope: input.scope };
      const prior = await tx.execute({
        sql: "SELECT runs.id, runs.conversation_id, runs.principal_id FROM runs JOIN messages ON messages.id = runs.message_id WHERE messages.scope_key = ? AND messages.external_id = ?",
        args: [key, input.messageId],
      });
      if (prior.rows[0]) {
        const runId = stringColumn(prior.rows[0], "id");
        const authorization = await authorizeRun(tx, caller, runId, "conversation:read");
        if ("denied" in authorization) return authorization;
        const rows = await tx.execute({
          sql: "SELECT * FROM conversations WHERE id = ? AND agent_id = ?",
          args: [authorization.value.conversationId, input.agentId],
        });
        if (!rows.rows[0])
          return {
            denied: await recordDecision(
              tx,
              { caller, resourceId: "conversation", action: "run:create" },
              "DENY",
              "scope_mismatch",
            ),
          };
        const runRows = await tx.execute({ sql: "SELECT * FROM runs WHERE id = ?", args: [runId] });
        const run = runRecord(runRows.rows[0]!);
        if (run.principalId !== caller.principalId) {
          return {
            denied: await recordDecision(
              tx,
              { caller, resourceId: "run", action: "run:create" },
              "DENY",
              "scope_mismatch",
            ),
          };
        }
        return {
          value: {
            conversation: conversationRecord(rows.rows[0], input.scope),
            run,
            duplicate: true,
            caller,
          },
        };
      }
      const decision = await evaluate(tx, {
        caller,
        resourceId: agentResourceId(input.agentId),
        action: "run:create",
        ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      });
      if (decision.decision !== "ALLOW") return { denied: decision };
      const locRow = await tx.execute({
        sql: "SELECT conversation_id FROM conversation_locations WHERE agent_id = ? AND location_key = ?",
        args: [input.agentId, convKey],
      });
      const conversations = locRow.rows[0]
        ? await tx.execute({
            sql: "SELECT * FROM conversations WHERE id = ?",
            args: [stringColumn(locRow.rows[0], "conversation_id")],
          })
        : await tx.execute({
            sql: "SELECT * FROM conversations WHERE agent_id = ? AND scope_key = ?",
            args: [input.agentId, convKey],
          });
      let conversationRow: Row | undefined = conversations.rows[0];
      let remapPrivateLocation = false;
      const now = new Date().toISOString();
      if (
        conversationRow &&
        input.scope.chatType === "private" &&
        stringColumn(conversationRow, "principal_id") !== caller.principalId
      ) {
        const principalConversations = await tx.execute({
          sql: "SELECT * FROM conversations WHERE agent_id = ? AND principal_id = ? ORDER BY created_at DESC, id DESC",
          args: [input.agentId, caller.principalId],
        });
        conversationRow = principalConversations.rows.find((row) => {
          try {
            return conversationScopeKey(JSON.parse(stringColumn(row, "scope_json"))) === convKey;
          } catch {
            return false;
          }
        });
        remapPrivateLocation = true;
      }
      // A group Conversation is opened by whoever speaks in it first, so its principal is
      // usually a visitor and stays that way. The Owner's own management view lists Conversations
      // by principal, which left a group the Owner actively uses out of that view entirely.
      // Rebinding records the Owner-facing principal; it grants nothing, because a group's
      // resource is public and every decision is already keyed on the speaking principal and
      // scope rather than on the Conversation's.
      if (
        conversationRow &&
        input.scope.chatType === "group" &&
        stringColumn(conversationRow, "principal_id") !== caller.principalId &&
        (
          await tx.execute({
            sql: "SELECT 1 FROM principals WHERE id = ? AND kind = 'owner'",
            args: [caller.principalId],
          })
        ).rows.length === 1
      ) {
        const conversationId = stringColumn(conversationRow, "id");
        await tx.execute({
          sql: "UPDATE conversations SET principal_id = ? WHERE id = ?",
          args: [caller.principalId, conversationId],
        });
        conversationRow = (
          await tx.execute({
            sql: "SELECT * FROM conversations WHERE id = ?",
            args: [conversationId],
          })
        ).rows[0];
      }
      if (!conversationRow) {
        const id = randomUUID();
        const resourceId = `conversation:${id}`;
        const persistedScopeKey = remapPrivateLocation
          ? JSON.stringify([convKey, caller.principalId])
          : convKey;
        await tx.execute({
          sql: "INSERT INTO resources(id, kind, visibility, owner_id) VALUES (?, 'conversation', ?, ?)",
          args: [
            resourceId,
            input.scope.chatType === "private" ? "private" : "public",
            caller.principalId,
          ],
        });
        await tx.execute({
          sql: "INSERT INTO conversations(id, agent_id, principal_id, scope_key, scope_json, resource_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          args: [
            id,
            input.agentId,
            caller.principalId,
            persistedScopeKey,
            JSON.stringify(input.scope),
            resourceId,
            now,
          ],
        });
        await tx.execute({
          sql: `INSERT INTO conversation_locations(agent_id, location_key, conversation_id, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(agent_id, location_key) DO UPDATE SET conversation_id = excluded.conversation_id`,
          args: [input.agentId, convKey, id, now],
        });
        const created = await tx.execute({
          sql: "SELECT * FROM conversations WHERE id = ?",
          args: [id],
        });
        conversationRow = created.rows[0];
      } else if (remapPrivateLocation) {
        await tx.execute({
          sql: "UPDATE conversation_locations SET conversation_id = ? WHERE agent_id = ? AND location_key = ?",
          args: [stringColumn(conversationRow, "id"), input.agentId, convKey],
        });
      } else if (!locRow.rows[0]) {
        await tx.execute({
          sql: "INSERT INTO conversation_locations(agent_id, location_key, conversation_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id, location_key) DO NOTHING",
          args: [input.agentId, convKey, stringColumn(conversationRow, "id"), now],
        });
      }
      if (!conversationRow) throw new Error("Conversation persistence failed");
      const conversation = conversationRecord(conversationRow, input.scope);
      const messageId = randomUUID();
      const runId = randomUUID();
      await tx.execute({
        sql: "INSERT INTO messages(id, conversation_id, scope_key, external_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        args: [messageId, conversation.id, key, input.messageId, input.text, now],
      });
      await tx.execute({
        sql: "INSERT INTO runs(id, conversation_id, message_id, principal_id, scope_json, execution_ref, channel_default_execution_ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)",
        args: [
          runId,
          conversation.id,
          messageId,
          caller.principalId,
          JSON.stringify(caller.scope),
          input.executionRef,
          input.channelDefaultExecutionRef ?? null,
          now,
          now,
        ],
      });
      if (input.imageFailureCode) {
        await tx.execute({
          sql: "INSERT INTO message_attachments(message_id, ordinal, status, failure_code) VALUES (?, 0, 'failed', ?)",
          args: [messageId, input.imageFailureCode],
        });
      } else {
        for (const [ordinal, image] of images.entries()) {
          await tx.execute({
            sql: "INSERT INTO message_attachments(message_id, ordinal, status, mime_type, image_bytes, size_bytes) VALUES (?, ?, 'ready', ?, ?, ?)",
            args: [messageId, ordinal, image.mimeType, image.data, image.data.length],
          });
        }
      }
      const run: RunRecord = {
        id: runId,
        conversationId: conversation.id,
        messageId,
        principalId: caller.principalId,
        executionRef: input.executionRef,
        ...(input.channelDefaultExecutionRef === undefined
          ? {}
          : { channelDefaultExecutionRef: input.channelDefaultExecutionRef }),
        status: "queued",
        source: "external",
        resultText: null,
        createdAt: now,
        updatedAt: now,
      };
      await this.linkDecision(tx, decision, run);
      return { value: { conversation, run, duplicate: false, caller } };
    });
    return authorizedValue(outcome);
  }

  /** Creates the durable Run for one already-authorized Model or Tool Task Step. The
   * required messages row is an empty internal key and is never ingress text. */
  async createInternalStepRun(input: InternalStepRunInput): Promise<RunRecord> {
    for (const value of [input.taskId, input.stepId, input.attemptId, input.executionRef])
      requireIdentifier(value);
    const modelExecution = /^(?:model|pi):.+$/u.test(input.executionRef);
    const toolExecution =
      parseTaskGetSpec(input.executionRef) !== null ||
      parseCheckpointWriteSpec(input.executionRef) !== null;
    if (!modelExecution && !toolExecution)
      throw new Error("Unsupported internal Run execution reference");
    const result = await this.db.transaction<AuthorizedResult<RunRecord>>(async (tx) => {
      const taskAuthorization = await evaluate(tx, {
        caller: input.caller,
        resourceId: `task-${input.taskId}`,
        action: "task:read",
        delegatedTaskId: input.taskId,
      });
      if (taskAuthorization.decision !== "ALLOW") return { denied: taskAuthorization };

      const taskContinueAuthorization = await evaluate(tx, {
        caller: input.caller,
        resourceId: `task-${input.taskId}`,
        action: "task:continue",
        delegatedTaskId: input.taskId,
      });
      if (taskContinueAuthorization.decision !== "ALLOW")
        return { denied: taskContinueAuthorization };

      const taskRows = await tx.execute({
        sql: "SELECT conversation_id, creator_principal_id, origin_scope_key, status, orchestration_mode, cancellation_state FROM tasks WHERE id = ?",
        args: [input.taskId],
      });
      const task = taskRows.rows[0];
      const conversationId = task ? optionalString(task, "conversation_id") : null;
      if (
        !task ||
        !conversationId ||
        stringColumn(task, "creator_principal_id") !== input.caller.principalId ||
        optionalString(task, "origin_scope_key") !== scopeKey(input.caller.scope) ||
        stringColumn(task, "status") !== "RUNNING" ||
        stringColumn(task, "orchestration_mode") !== "durable" ||
        stringColumn(task, "cancellation_state") !== "none"
      ) {
        return {
          denied: await recordDecision(
            tx,
            { caller: input.caller, resourceId: `task-${input.taskId}`, action: "run:create" },
            "DENY",
            "scope_mismatch",
          ),
        };
      }
      const conversationAuthorization = await authorizeConversation(
        tx,
        input.caller,
        conversationId,
        "run:create",
        undefined,
        input.taskId,
      );
      if ("denied" in conversationAuthorization) return conversationAuthorization;

      const runCreate = await evaluate(tx, {
        caller: input.caller,
        resourceId: agentResourceId(conversationAuthorization.value.agentId),
        action: "run:create",
        conversationId,
        delegatedTaskId: input.taskId,
      });
      if (runCreate.decision !== "ALLOW") return { denied: runCreate };
      const conversationRead = await evaluate(tx, {
        caller: input.caller,
        resourceId: agentResourceId(conversationAuthorization.value.agentId),
        action: "conversation:read",
        conversationId,
        delegatedTaskId: input.taskId,
      });
      if (conversationRead.decision !== "ALLOW") return { denied: conversationRead };
      const runControl = await evaluate(tx, {
        caller: input.caller,
        resourceId: agentResourceId(conversationAuthorization.value.agentId),
        action: "run:control",
        conversationId,
        delegatedTaskId: input.taskId,
      });
      if (runControl.decision !== "ALLOW") return { denied: runControl };

      const stepRows = await tx.execute({
        sql: `SELECT s.instructions, s.spec_ref, s.kind, s.status, a.status AS attempt_status,
                     a.task_id AS attempt_task_id, a.step_id AS attempt_step_id
              FROM task_steps s JOIN task_attempts a ON a.id = ?
              WHERE s.id = ? AND s.task_id = ?
                AND EXISTS (SELECT 1 FROM task_step_leases l WHERE l.task_id = s.task_id
                  AND l.step_id = s.id AND l.attempt_id = a.id AND l.state = 'active' AND l.expires_at > ?)`,
        args: [input.attemptId, input.stepId, input.taskId, new Date().toISOString()],
      });
      const step = stepRows.rows[0];
      if (
        !step ||
        !(
          (modelExecution &&
            stringColumn(step, "kind") === "model" &&
            typeof step.instructions === "string" &&
            !!step.instructions.trim() &&
            step.instructions.length <= 4096) ||
          (toolExecution &&
            stringColumn(step, "kind") === "tool" &&
            optionalString(step, "spec_ref") === input.executionRef)
        ) ||
        stringColumn(step, "status") !== "running" ||
        stringColumn(step, "attempt_status") !== "running" ||
        stringColumn(step, "attempt_task_id") !== input.taskId ||
        optionalString(step, "attempt_step_id") !== input.stepId
      ) {
        return {
          denied: await recordDecision(
            tx,
            { caller: input.caller, resourceId: `task-${input.taskId}`, action: "run:create" },
            "DENY",
            "scope_mismatch",
          ),
        };
      }

      const existing = await tx.execute({
        sql: `SELECT r.* FROM task_attempt_runs ar JOIN runs r ON r.id = ar.run_id
              WHERE ar.attempt_id = ? AND ar.task_id = ? AND ar.step_id = ?`,
        args: [input.attemptId, input.taskId, input.stepId],
      });
      if (existing.rows[0]) {
        if (
          stringColumn(existing.rows[0], "source") !== "task_step" ||
          stringColumn(existing.rows[0], "conversation_id") !== conversationId ||
          stringColumn(existing.rows[0], "principal_id") !== input.caller.principalId ||
          stringColumn(existing.rows[0], "execution_ref") !== input.executionRef
        ) {
          return {
            denied: await recordDecision(
              tx,
              { caller: input.caller, resourceId: `task-${input.taskId}`, action: "run:create" },
              "DENY",
              "scope_mismatch",
            ),
          };
        }
        return { value: runRecord(existing.rows[0]) };
      }

      const now = new Date().toISOString();
      const runId = randomUUID();
      const messageId = randomUUID();
      const conversationRows = await tx.execute({
        sql: "SELECT scope_key, scope_json FROM conversations WHERE id = ?",
        args: [conversationId],
      });
      const conversation = conversationRows.rows[0];
      if (!conversation) throw new Error("Conversation persistence failed");
      await tx.execute({
        sql: "INSERT INTO messages(id, conversation_id, scope_key, external_id, text, created_at) VALUES (?, ?, ?, ?, '', ?)",
        args: [
          messageId,
          conversationId,
          `task-step-internal:${input.taskId}`,
          `internal:${input.attemptId}`,
          now,
        ],
      });
      await tx.execute({
        sql: "INSERT INTO runs(id, conversation_id, message_id, principal_id, scope_json, execution_ref, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', 'task_step', ?, ?)",
        args: [
          runId,
          conversationId,
          messageId,
          input.caller.principalId,
          stringColumn(conversation, "scope_json"),
          input.executionRef,
          now,
          now,
        ],
      });
      await tx.execute({
        sql: "INSERT INTO task_attempt_runs(attempt_id, run_id, task_id, step_id) VALUES (?, ?, ?, ?)",
        args: [input.attemptId, runId, input.taskId, input.stepId],
      });
      await this.linkDecision(tx, runCreate, {
        id: runId,
        conversationId,
        messageId,
        principalId: input.caller.principalId,
        executionRef: input.executionRef,
        status: "queued",
        source: "task_step",
        resultText: null,
        createdAt: now,
        updatedAt: now,
      });
      await tx.execute({
        sql: "UPDATE authorization_decisions SET conversation_id = ?, run_id = ? WHERE id IN (?, ?, ?, ?)",
        args: [
          conversationId,
          runId,
          taskAuthorization.id,
          taskContinueAuthorization.id,
          conversationRead.id,
          runControl.id,
        ],
      });
      return {
        value: {
          id: runId,
          conversationId,
          messageId,
          principalId: input.caller.principalId,
          executionRef: input.executionRef,
          status: "queued",
          source: "task_step",
          resultText: null,
          createdAt: now,
          updatedAt: now,
        },
      };
    });
    return authorizedValue(result);
  }

  private async linkDecision(
    tx: Transaction,
    decision: AuthorizationDecision,
    run: RunRecord,
  ): Promise<void> {
    // Link the decision made in this same transaction, without changing its facts.
    await tx.execute({
      sql: "UPDATE authorization_decisions SET conversation_id = ?, run_id = ? WHERE id = ?",
      args: [run.conversationId, run.id, decision.id],
    });
  }

  async listConversations(
    caller: CallerContext,
    agentId: string,
    options: PageOptions = {},
  ): Promise<Page<ConversationRecord>> {
    const page = pageParameters(options);
    const outcome = await this.db.transaction<AuthorizedResult<Page<ConversationRecord>>>(
      async (tx) => {
        const decision = await evaluate(tx, {
          caller,
          resourceId: agentResourceId(agentId),
          action: "conversation:read",
        });
        if (decision.decision !== "ALLOW") return { denied: decision };
        const convKey = conversationScopeKey(caller.scope);
        const rows = await tx.execute({
          sql: `SELECT DISTINCT c.* FROM conversations c
                LEFT JOIN conversation_locations cl ON cl.conversation_id = c.id
                WHERE c.agent_id = ? AND (cl.location_key = ? OR c.scope_key = ?)
                AND (c.created_at, c.id) > (?, ?)
                ORDER BY c.created_at, c.id LIMIT ?`,
          args: [agentId, convKey, convKey, page.afterTime, page.afterId, page.limit + 1],
        });
        const items = [];
        for (const row of rows.rows) {
          const auth = await authorizeConversation(
            tx,
            caller,
            stringColumn(row, "id"),
            "conversation:read",
          );
          if (!("denied" in auth)) items.push(row);
        }
        return {
          value: makePage(items, page.limit, (row) => conversationRecord(row, caller.scope)),
        };
      },
    );
    return authorizedValue(outcome);
  }

  async getConversation(caller: CallerContext, id: string): Promise<ConversationRecord> {
    return authorizedValue(
      await this.db.transaction<AuthorizedResult<ConversationRecord>>(async (tx) => {
        const decision = await authorizeConversation(tx, caller, id, "conversation:read");
        if ("denied" in decision) return decision;
        const rows = await tx.execute({
          sql: "SELECT * FROM conversations WHERE id = ?",
          args: [id],
        });
        return { value: conversationRecord(rows.rows[0]!, caller.scope) };
      }),
    );
  }

  async getRun(caller: CallerContext, id: string): Promise<RunRecord> {
    return authorizedValue(
      await this.db.transaction<AuthorizedResult<RunRecord>>(async (tx) => {
        const decision = await authorizeRun(tx, caller, id, "conversation:read");
        if ("denied" in decision) return decision;
        const rows = await tx.execute({ sql: "SELECT * FROM runs WHERE id = ?", args: [id] });
        return { value: runRecord(rows.rows[0]!) };
      }),
    );
  }

  /** Reconnect lookup for a durable Model Step Activity. The attempt is the
   * idempotency key; current Task and Conversation read grants still apply. */
  async getInternalStepRun(caller: CallerContext, attemptId: string): Promise<RunRecord | null> {
    requireIdentifier(attemptId);
    return authorizedValue(
      await this.db.transaction<AuthorizedResult<RunRecord | null>>(async (tx) => {
        const linked = await tx.execute({
          sql: "SELECT run_id FROM task_attempt_runs WHERE attempt_id = ?",
          args: [attemptId],
        });
        if (!linked.rows[0]) return { value: null };
        const runId = stringColumn(linked.rows[0], "run_id");
        const authorization = await authorizeRun(tx, caller, runId, "conversation:read");
        if ("denied" in authorization) return authorization;
        const rows = await tx.execute({ sql: "SELECT * FROM runs WHERE id = ?", args: [runId] });
        if (!rows.rows[0] || stringColumn(rows.rows[0], "source") !== "task_step")
          return { value: null };
        return { value: runRecord(rows.rows[0]) };
      }),
    );
  }

  async listRuns(
    caller: CallerContext,
    conversationId: string,
    options: PageOptions = {},
  ): Promise<Page<RunRecord>> {
    const page = pageParameters(options);
    return authorizedValue(
      await this.db.transaction<AuthorizedResult<Page<RunRecord>>>(async (tx) => {
        const decision = await authorizeConversation(
          tx,
          caller,
          conversationId,
          "conversation:read",
        );
        if ("denied" in decision) return decision;
        const rows = await tx.execute({
          sql: "SELECT * FROM runs WHERE conversation_id = ? AND principal_id = ? AND source = 'external' AND (created_at, id) > (?, ?) ORDER BY created_at, id LIMIT ?",
          args: [conversationId, caller.principalId, page.afterTime, page.afterId, page.limit + 1],
        });
        return { value: makePage(rows.rows, page.limit, runRecord) };
      }),
    );
  }

  async listMessages(
    caller: CallerContext,
    conversationId: string,
    options: PageOptions = {},
  ): Promise<Page<{ id: string; text: string; createdAt: string }>> {
    const page = pageParameters(options);
    return authorizedValue(
      await this.db.transaction<
        AuthorizedResult<Page<{ id: string; text: string; createdAt: string }>>
      >(async (tx) => {
        const decision = await authorizeConversation(
          tx,
          caller,
          conversationId,
          "conversation:read",
        );
        if ("denied" in decision) return decision;
        const rows = await tx.execute({
          sql: "SELECT id, text, created_at FROM messages WHERE conversation_id = ? AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.message_id = messages.id AND runs.source = 'task_step') AND (created_at, id) > (?, ?) ORDER BY created_at, id LIMIT ?",
          args: [conversationId, page.afterTime, page.afterId, page.limit + 1],
        });
        return {
          value: makePage(rows.rows, page.limit, (row) => ({
            id: stringColumn(row, "id"),
            text: stringColumn(row, "text"),
            createdAt: stringColumn(row, "created_at"),
          })),
        };
      }),
    );
  }

  /** Explicit incident response. Preserve the original record and append the
   * exclusion decision; excluded exchanges cannot be reused by any Principal. */
  async excludeRunFromContext(caller: CallerContext, runId: string): Promise<boolean> {
    return authorizedValue(
      await this.db.transaction<AuthorizedResult<boolean>>(async (tx) => {
        const authorization = await authorizeRun(tx, caller, runId, "run:control");
        if ("denied" in authorization) return authorization;
        const prior = await tx.execute({
          sql: "SELECT event_id FROM ops_trace_events WHERE run_id = ? AND type = 'context.excluded' LIMIT 1",
          args: [runId],
        });
        if (prior.rows.length) return { value: false };
        await tx.execute({
          sql: "INSERT INTO ops_trace_events(event_id, ts, type, run_id, principal_id, data_json) VALUES (?, ?, 'context.excluded', ?, ?, ?)",
          args: [
            randomUUID(),
            new Date().toISOString(),
            runId,
            caller.principalId,
            JSON.stringify({ action: "Exclude Run Context", reason: "unsafe_runtime_context" }),
          ],
        });
        return { value: true };
      }),
    );
  }

  /** Load only this Run's input and earlier completed exchanges. Later queued
   * messages cannot become context before their own Run reaches execution. */
  async loadRunInput(caller: CallerContext, runId: string): Promise<RunInputRecord> {
    return authorizedValue(
      await this.db.transaction<AuthorizedResult<RunInputRecord>>(async (tx) => {
        const authorization = await authorizeRun(tx, caller, runId, "conversation:read");
        if ("denied" in authorization) return authorization;
        const rows = await tx.execute({
          sql: `SELECT runs.*, CASE WHEN runs.source = 'task_step' AND runs.execution_ref LIKE 'tool:%'
                    THEN ''
                    WHEN runs.source = 'task_step'
                    THEN (SELECT CASE WHEN s.kind = 'model' THEN s.instructions ELSE '' END FROM task_attempt_runs ar JOIN task_steps s ON s.id = ar.step_id AND s.task_id = ar.task_id WHERE ar.run_id = runs.id)
                    ELSE messages.text END AS input_text
                  FROM runs JOIN messages ON messages.id = runs.message_id WHERE runs.id = ?`,
          args: [runId],
        });
        const row = rows.rows[0]!;
        const run = runRecord(row);
        const attachmentRows = await tx.execute({
          sql: "SELECT status, mime_type, image_bytes, failure_code FROM message_attachments WHERE message_id = ? ORDER BY ordinal",
          args: [run.messageId],
        });
        const imageFailureCode = attachmentRows.rows.find(
          (attachment) => attachment.status === "failed",
        )?.failure_code;
        const images =
          imageFailureCode === undefined
            ? attachmentRows.rows.map((attachment) => {
                const mimeType = attachment.mime_type as IncomingImageMimeType;
                const imageBytes = attachment.image_bytes;
                const bytes =
                  imageBytes instanceof Uint8Array
                    ? imageBytes
                    : imageBytes instanceof ArrayBuffer
                      ? new Uint8Array(imageBytes)
                      : undefined;
                if (
                  attachment.status !== "ready" ||
                  (mimeType !== "image/png" &&
                    mimeType !== "image/jpeg" &&
                    mimeType !== "image/webp") ||
                  bytes === undefined
                )
                  throw new Error("Invalid persisted image attachment");
                return { mimeType, data: Buffer.from(bytes).toString("base64") };
              })
            : [];
        const conversations = await tx.execute({
          sql: "SELECT * FROM conversations WHERE id = ?",
          args: [run.conversationId],
        });
        const conversation = conversationRecord(conversations.rows[0]!, caller.scope);
        // The QQ number each turn came from. It is already persisted on the Run as its scope, so
        // attribution needs no second source: a group's principal id names who spoke only for
        // visitors, and an Owner's does not name the account at all.
        const senderIdFor = (prior: Row): string | undefined => {
          try {
            const scope = JSON.parse(stringColumn(prior, "scope_json")) as { senderId?: unknown };
            return typeof scope.senderId === "string" ? scope.senderId : undefined;
          } catch {
            return undefined;
          }
        };
        // A group is one Conversation shared by everyone in it, so a turn's author has to be
        // named for the reader. A private Conversation has one speaker by construction, and the
        // two scope keys differ there only because they are different tuple lengths — comparing
        // them would report every private chat as shared.
        const sharedConversation = caller.scope.chatType === "group";
        let taskStepBinding: RunInputRecord["taskStepBinding"];
        let stepResults: RunInputRecord["stepResults"];
        if (run.source === "task_step") {
          const bindingRows = await tx.execute({
            sql: `SELECT ar.task_id, ar.step_id, ar.attempt_id
                  FROM task_attempt_runs ar
                  JOIN tasks t ON t.id = ar.task_id AND t.status = 'RUNNING' AND t.orchestration_mode = 'durable' AND t.cancellation_state = 'none'
                  JOIN task_attempts a ON a.id = ar.attempt_id AND a.task_id = ar.task_id AND a.step_id = ar.step_id
                  JOIN task_steps s ON s.id = ar.step_id AND s.task_id = ar.task_id
                  JOIN task_step_leases l ON l.task_id = ar.task_id AND l.step_id = ar.step_id AND l.attempt_id = ar.attempt_id AND l.state = 'active' AND l.expires_at > ?
                  WHERE ar.run_id = ? AND a.status = 'running' AND s.status = 'running'`,
            args: [new Date().toISOString(), runId],
          });
          if (!bindingRows.rows[0]) {
            return {
              denied: await recordDecision(
                tx,
                {
                  caller,
                  resourceId: "run",
                  action: "conversation:read",
                  runId,
                  conversationId: run.conversationId,
                },
                "DENY",
                "scope_mismatch",
              ),
            };
          }
          taskStepBinding = {
            taskId: stringColumn(bindingRows.rows[0], "task_id"),
            stepId: stringColumn(bindingRows.rows[0], "step_id"),
            attemptId: stringColumn(bindingRows.rows[0], "attempt_id"),
          };
          const originSources = await reauthorizeSourceRows(
            tx,
            caller,
            await readTaskSourceRows(tx, taskStepBinding.taskId),
            { conversationId: run.conversationId, runId },
          );
          if ("denied" in originSources) return originSources;
          if (!run.executionRef.startsWith("tool:")) {
            const dependencies = await tx.execute({
              sql: `SELECT s.id, s.kind, s.status, s.output_ref, s.spec_ref, s.delegated_permissions_json
                FROM task_step_dependencies d
                JOIN task_steps s ON s.id = d.dependency_id AND s.task_id = d.task_id
                WHERE d.task_id = ? AND d.step_id = ? ORDER BY s.id`,
              args: [taskStepBinding.taskId, taskStepBinding.stepId],
            });
            stepResults = [];
            const currentTaskId = taskStepBinding.taskId;
            const loadWorkerResult = async (
              sourceTaskId: string,
              sourceStepId: string,
              outputRef: string,
            ): Promise<{ result: StepResultRecord } | { denied: AuthorizationDecision }> => {
              if (!outputRef.startsWith("worker-result:"))
                throw new Error("Accepted Worker result reference is unavailable");
              const attemptId = outputRef.slice("worker-result:".length);
              requireIdentifier(attemptId);
              const candidateRows = await tx.execute({
                sql: `SELECT candidate.task_id,candidate.step_id,candidate.attempt_id,
                    candidate.worker_binding_id,candidate.output_excerpt,candidate.truncated,
                    step.delegated_permissions_json,step.spec_ref
                  FROM worker_candidate_outputs candidate
                  JOIN task_attempts attempt ON attempt.id = candidate.attempt_id
                    AND attempt.task_id = candidate.task_id AND attempt.step_id = candidate.step_id
                  JOIN worker_bindings binding ON binding.id = candidate.worker_binding_id
                    AND binding.task_attempt_id = candidate.attempt_id
                  JOIN task_steps step ON step.id = candidate.step_id AND step.task_id = candidate.task_id
                  WHERE candidate.task_id = ? AND candidate.step_id = ? AND candidate.attempt_id = ?
                    AND step.kind = 'herdr_worker' AND step.status = 'succeeded'
                    AND attempt.status = 'succeeded'`,
                args: [sourceTaskId, sourceStepId, attemptId],
              });
              const candidate = candidateRows.rows[0];
              if (!candidate) throw new Error("Accepted Worker result is unavailable");
              if (
                stringColumn(candidate, "task_id") !== sourceTaskId ||
                stringColumn(candidate, "step_id") !== sourceStepId ||
                stringColumn(candidate, "attempt_id") !== attemptId
              )
                throw new Error("Worker result binding is unavailable");
              let permissions: unknown;
              try {
                permissions = JSON.parse(stringColumn(candidate, "delegated_permissions_json"));
              } catch {
                throw new Error("Worker result permissions are unavailable");
              }
              if (!Array.isArray(permissions))
                throw new Error("Worker result permissions are unavailable");
              const delegatedTaskId = sourceTaskId === currentTaskId ? sourceTaskId : undefined;
              const decisions: AuthorizationDecision[] = [];
              for (const action of ["task:read", "worker:read"]) {
                const decision = await evaluate(tx, {
                  caller,
                  resourceId: `task-${sourceTaskId}`,
                  action,
                  conversationId: run.conversationId,
                  runId,
                  ...(delegatedTaskId ? { delegatedTaskId } : {}),
                });
                if (decision.decision !== "ALLOW") return { denied: decision };
                decisions.push(decision);
              }
              for (const permission of permissions) {
                if (
                  !permission ||
                  typeof permission !== "object" ||
                  typeof permission.resourceId !== "string" ||
                  typeof permission.action !== "string"
                )
                  throw new Error("Worker result permissions are unavailable");
                let readAction: string;
                if (
                  permission.action === "worker:file:read" ||
                  permission.action === "worker:file:write"
                ) {
                  readAction = "worker:file:read";
                } else if (
                  permission.action === "workspace:read" ||
                  permission.action === "workspace:write"
                ) {
                  if (!permission.resourceId.startsWith("workspace:"))
                    throw new Error("Worker result permissions are unavailable");
                  readAction = "workspace:read";
                } else {
                  throw new Error("Worker result has an unsupported content source");
                }
                const decision = await evaluate(tx, {
                  caller,
                  resourceId: permission.resourceId,
                  action: readAction,
                  conversationId: run.conversationId,
                  runId,
                  ...(delegatedTaskId ? { delegatedTaskId } : {}),
                });
                if (decision.decision !== "ALLOW") return { denied: decision };
                decisions.push(decision);
              }
              const inherited = await reauthorizeSourceRows(
                tx,
                caller,
                await readTaskSourceRows(tx, sourceTaskId),
                {
                  conversationId: run.conversationId,
                  runId,
                  ...(delegatedTaskId ? { delegatedTaskId } : {}),
                },
              );
              if ("denied" in inherited) return inherited;
              for (const decision of decisions)
                await tx.execute({
                  sql: "UPDATE authorization_decisions SET delivery_source = 'content_source' WHERE id = ?",
                  args: [decision.id],
                });
              const specRef = optionalString(candidate, "spec_ref");
              if (specRef) {
                const spec = parseWorkerTextFileSpec(specRef);
                if (!spec) throw new Error("Accepted Worker file specification is unavailable");
                const artifactRows = await tx.execute({
                  sql: `SELECT artifact.relative_path,artifact.content_text
                    FROM worker_file_artifacts artifact
                    WHERE artifact.task_id = ? AND artifact.step_id = ? AND artifact.attempt_id = ?
                      AND artifact.worker_binding_id = ?`,
                  args: [
                    sourceTaskId,
                    sourceStepId,
                    attemptId,
                    stringColumn(candidate, "worker_binding_id"),
                  ],
                });
                const artifact = artifactRows.rows[0];
                if (!artifact || stringColumn(artifact, "relative_path") !== spec.relativePath)
                  throw new Error("Accepted Worker file artifact is unavailable");
                const fileText = stringColumn(artifact, "content_text");
                return {
                  result: {
                    stepId: sourceStepId,
                    sourceRef: `worker-file:${attemptId}`,
                    text: fileText.slice(0, 2_048),
                    truncated: fileText.length > 2_048,
                  },
                };
              }
              const text = stringColumn(candidate, "output_excerpt");
              return {
                result: {
                  stepId: sourceStepId,
                  sourceRef: outputRef,
                  text: text.slice(0, 2_048),
                  truncated: Number(candidate.truncated) === 1 || text.length > 2_048,
                },
              };
            };
            for (const dependency of dependencies.rows) {
              const outputRef = optionalString(dependency, "output_ref");
              if (dependency.kind === "herdr_worker" && dependency.status === "succeeded") {
                const candidate = await loadWorkerResult(
                  taskStepBinding.taskId,
                  stringColumn(dependency, "id"),
                  outputRef ?? "",
                );
                if ("denied" in candidate) return candidate;
                stepResults.push(candidate.result);
                continue;
              }
              if (
                dependency.kind === "child_task" &&
                dependency.status === "succeeded" &&
                outputRef?.startsWith("task:")
              ) {
                const childTaskId = outputRef.slice(5);
                requireIdentifier(childTaskId);
                const childDecision = await evaluate(tx, {
                  caller,
                  resourceId: `task-${childTaskId}`,
                  action: "task:read",
                  conversationId: run.conversationId,
                  runId,
                });
                if (childDecision.decision !== "ALLOW") return { denied: childDecision };
                const childRoot = await tx.execute({
                  sql: `SELECT root.id,root.kind,root.status,root.output_ref
                    FROM task_child_links link
                    JOIN tasks child ON child.id = link.child_task_id
                    JOIN task_steps root ON root.task_id = child.id AND root.id = child.root_step_id
                    WHERE link.child_task_id = ? AND link.parent_task_id = ?
                      AND link.parent_step_id = ? AND link.result_ref = ?
                      AND child.orchestration_mode = 'durable' AND child.status = 'DONE'
                      AND EXISTS (SELECT 1 FROM task_events e
                        WHERE e.task_id = child.id AND e.type = 'TASK_ACCEPTED')`,
                  args: [
                    childTaskId,
                    taskStepBinding.taskId,
                    stringColumn(dependency, "id"),
                    outputRef,
                  ],
                });
                const root = childRoot.rows[0];
                const rootRef = root ? optionalString(root, "output_ref") : null;
                if (root?.kind === "herdr_worker" && root.status === "succeeded") {
                  const candidate = await loadWorkerResult(
                    childTaskId,
                    stringColumn(root, "id"),
                    rootRef ?? "",
                  );
                  if ("denied" in candidate) return candidate;
                  stepResults.push({ ...candidate.result, stepId: stringColumn(dependency, "id") });
                  continue;
                }
                if (
                  root?.kind !== "model" ||
                  root.status !== "succeeded" ||
                  !rootRef?.startsWith("run:")
                )
                  continue;
                const childRunId = rootRef.slice(4);
                requireIdentifier(childRunId);
                const sourceAuthorization = await authorizeRun(
                  tx,
                  caller,
                  childRunId,
                  "conversation:read",
                );
                if ("denied" in sourceAuthorization) return sourceAuthorization;
                const inherited = await reauthorizeSourceRows(
                  tx,
                  caller,
                  await readRunSourceRows(tx, [childRunId]),
                  { conversationId: run.conversationId, runId },
                );
                if ("denied" in inherited) return inherited;
                await tx.execute({
                  sql: "UPDATE authorization_decisions SET delivery_source = 'content_source' WHERE id = ?",
                  args: [childDecision.id],
                });
                const result = await tx.execute({
                  sql: `SELECT r.result_text FROM task_attempt_runs ar
                    JOIN runs r ON r.id = ar.run_id
                    WHERE ar.run_id = ? AND ar.task_id = ? AND ar.step_id = ?
                      AND r.source = 'task_step' AND r.status = 'succeeded'`,
                  args: [childRunId, childTaskId, stringColumn(root, "id")],
                });
                const resultText = result.rows[0]
                  ? optionalString(result.rows[0], "result_text")
                  : null;
                if (resultText === null) throw new Error("Accepted child result is unavailable");
                stepResults.push({
                  stepId: stringColumn(dependency, "id"),
                  runId: childRunId,
                  text: resultText.slice(0, 2_048),
                  truncated: resultText.length > 2_048,
                });
                continue;
              }
              if (
                dependency.kind === "tool" &&
                dependency.status === "succeeded" &&
                outputRef?.startsWith("checkpoint:")
              ) {
                const spec = parseCheckpointWriteSpec(optionalString(dependency, "spec_ref") ?? "");
                if (!spec) throw new Error("Accepted checkpoint dependency spec is unavailable");
                const checkpointId = outputRef.slice("checkpoint:".length);
                requireIdentifier(checkpointId);
                const checkpoint = await tx.execute({
                  sql: `SELECT state_ref FROM task_checkpoints
                    WHERE id = ? AND task_id = ? AND step_id = ?
                      AND checkpoint_type = 'tool_checkpoint_write'`,
                  args: [checkpointId, taskStepBinding.taskId, stringColumn(dependency, "id")],
                });
                if (checkpoint.rows[0]?.state_ref !== spec.stateRef)
                  throw new Error("Accepted checkpoint dependency is unavailable");
                const contentDecision = await evaluate(tx, {
                  caller,
                  resourceId: `task-${taskStepBinding.taskId}`,
                  action: "task:read",
                  conversationId: run.conversationId,
                  runId,
                });
                if (contentDecision.decision !== "ALLOW") return { denied: contentDecision };
                await tx.execute({
                  sql: "UPDATE authorization_decisions SET delivery_source = 'content_source' WHERE id = ?",
                  args: [contentDecision.id],
                });
                stepResults.push({
                  stepId: stringColumn(dependency, "id"),
                  sourceRef: outputRef,
                  text: JSON.stringify({ checkpointStateRef: spec.stateRef }),
                  truncated: false,
                });
                continue;
              }
              if (
                !["model", "tool"].includes(stringColumn(dependency, "kind")) ||
                dependency.status !== "succeeded" ||
                !outputRef?.startsWith("run:")
              )
                continue;
              const sourceRunId = outputRef.slice(4);
              requireIdentifier(sourceRunId);
              const sourceAuthorization = await authorizeRun(
                tx,
                caller,
                sourceRunId,
                "conversation:read",
              );
              if ("denied" in sourceAuthorization) return sourceAuthorization;
              if (dependency.kind === "tool") {
                const specRef = optionalString(dependency, "spec_ref") ?? "";
                const readSpec = parseTaskGetSpec(specRef);
                if (!readSpec && !parseCheckpointWriteSpec(specRef))
                  throw new Error("Accepted Tool dependency spec is unavailable");
                if (readSpec) {
                  const targetDecision = await evaluate(tx, {
                    caller,
                    resourceId: `task-${readSpec.targetTaskId}`,
                    action: "task:read",
                    conversationId: run.conversationId,
                    runId,
                  });
                  if (targetDecision.decision !== "ALLOW") return { denied: targetDecision };
                  await tx.execute({
                    sql: "UPDATE authorization_decisions SET delivery_source = 'content_source' WHERE id = ?",
                    args: [targetDecision.id],
                  });
                }
              }
              const inherited = await reauthorizeSourceRows(
                tx,
                caller,
                await readRunSourceRows(tx, [sourceRunId]),
                { conversationId: run.conversationId, runId },
              );
              if ("denied" in inherited) return inherited;
              const contentDecision = await evaluate(tx, {
                caller,
                resourceId: `task-${taskStepBinding.taskId}`,
                action: "task:read",
                conversationId: run.conversationId,
                runId,
              });
              if (contentDecision.decision !== "ALLOW") return { denied: contentDecision };
              await tx.execute({
                sql: "UPDATE authorization_decisions SET delivery_source = 'content_source' WHERE id = ?",
                args: [contentDecision.id],
              });
              const source = await tx.execute({
                sql: `SELECT r.result_text FROM task_attempt_runs ar
                  JOIN runs r ON r.id = ar.run_id
                  WHERE ar.run_id = ? AND ar.task_id = ? AND ar.step_id = ?
                    AND r.source = 'task_step' AND r.status = 'succeeded'`,
                args: [sourceRunId, taskStepBinding.taskId, stringColumn(dependency, "id")],
              });
              if (!source.rows[0] || typeof source.rows[0].result_text !== "string")
                throw new Error("Accepted dependency result is unavailable");
              const text = stringColumn(source.rows[0], "result_text");
              stepResults.push({
                stepId: stringColumn(dependency, "id"),
                runId: sourceRunId,
                text: text.slice(0, 2_048),
                truncated: text.length > 2_048,
              });
            }
          }
        }
        // Only a Run the channel delivered externally contributes projected history: an internal
        // task_step Run belongs to a task graph, not to this Conversation's turns, and it reads its
        // dependencies through stepResults instead.
        const earlier =
          run.source === "external"
            ? await tx.execute({
                sql: "SELECT runs.id, runs.principal_id, runs.sequence, runs.status, runs.scope_json, runs.result_text, (SELECT text FROM messages WHERE id = runs.message_id) AS input_text FROM runs WHERE runs.conversation_id = ? AND runs.sequence < ? AND runs.source = 'external' AND runs.status IN ('succeeded', 'failed') AND runs.result_text IS NOT NULL AND (runs.status = 'succeeded' OR EXISTS (SELECT 1 FROM deliveries d WHERE d.run_id = runs.id AND d.status = 'sent' AND d.payload_kind IN ('text', 'result'))) AND NOT EXISTS (SELECT 1 FROM ops_trace_events e WHERE e.run_id = runs.id AND e.type = 'context.excluded') ORDER BY runs.sequence DESC LIMIT 257",
                args: [run.conversationId, row.sequence!],
              })
            : { rows: [] };
        const callerLocationKey = conversationScopeKey(caller.scope);
        const exchanges: Array<HistoryActor & { runId: string; user: string; assistant: string }> =
          [];
        const omittedRunIds: string[] = [];
        let loadedChars = 0;
        let historyScanTruncated = earlier.rows.length > 256;
        const priorRows = earlier.rows.slice(0, 256);
        const priorIds = priorRows.map((prior) => stringColumn(prior, "id"));
        const grantByRun = new Map<string, Row[]>();
        const sourcesByRun = new Map<string, Row[]>();
        const deliveriesByRun = new Map<string, Row[]>();
        if (priorIds.length) {
          const placeholders = priorIds.map(() => "?").join(",");
          const grants = await tx.execute({
            sql: `SELECT d.run_id, d.grant_id, g.revoked_at FROM authorization_decisions_all d JOIN grants g ON g.id = d.grant_id WHERE d.run_id IN (${placeholders}) AND d.decision = 'ALLOW'`,
            args: priorIds,
          });
          const sources = await tx.execute({
            sql: `SELECT DISTINCT run_id, resource_id, action, delivery_source, policy_condition_json FROM authorization_decisions_all WHERE run_id IN (${placeholders}) AND decision = 'ALLOW' AND delivery_source IS NOT NULL`,
            args: priorIds,
          });
          const deliveries = await tx.execute({
            sql: `SELECT run_id, payload_text, destination_scope_key FROM deliveries WHERE run_id IN (${placeholders}) AND status = 'sent' AND payload_kind IN ('text', 'result') ORDER BY run_id, created_at DESC`,
            args: priorIds,
          });
          for (const row of grants.rows) {
            const id = stringColumn(row, "run_id");
            grantByRun.set(id, [...(grantByRun.get(id) ?? []), row]);
          }
          for (const row of sources.rows) {
            const id = stringColumn(row, "run_id");
            sourcesByRun.set(id, [...(sourcesByRun.get(id) ?? []), row]);
          }
          for (const row of deliveries.rows) {
            const id = stringColumn(row, "run_id");
            deliveriesByRun.set(id, [...(deliveriesByRun.get(id) ?? []), row]);
          }
        }
        for (const prior of priorRows) {
          const priorPrincipalId = stringColumn(prior, "principal_id");
          const priorRunId = stringColumn(prior, "id");
          let user: string;
          let assistant: string;

          const grantRows = grantByRun.get(priorRunId) ?? [];
          if (grantRows.length === 0 || grantRows.some((r) => r.revoked_at !== null)) {
            continue;
          }

          const sources = sourcesByRun.get(priorRunId) ?? [];
          let permitted = true;
          const currentSourceDecisions: Array<{
            id: string;
            source: "content_source" | "access_gate";
          }> = [];
          for (const source of sources) {
            const decision = await evaluate(tx, {
              caller,
              resourceId: stringColumn(source, "resource_id"),
              action: stringColumn(source, "action"),
              policyCondition: readPolicyCondition(source),
              conversationId: run.conversationId,
              runId,
            });
            if (decision.decision !== "ALLOW") {
              await recordFilteredDecision(tx, caller, { runId }, decision, "conversation-history");
              permitted = false;
              break;
            }
            currentSourceDecisions.push({
              id: decision.id,
              source: sourceClassification(source),
            });
          }
          if (!permitted) continue;

          const matchingDelivery = (deliveriesByRun.get(priorRunId) ?? []).find((dRow) =>
            matchesDestinationLocation(
              stringColumn(dRow, "destination_scope_key"),
              callerLocationKey,
            ),
          );
          if (stringColumn(prior, "status") === "failed" && !matchingDelivery) continue;
          if (matchingDelivery) assistant = stringColumn(matchingDelivery, "payload_text");
          else if (priorPrincipalId === caller.principalId) {
            const result = prior.result_text;
            if (typeof result !== "string" || !result) continue;
            assistant = result;
          } else continue;
          if (typeof prior.input_text !== "string") continue;
          user = stringColumn(prior, "input_text");

          if (loadedChars + user.length + assistant.length > 1_000_000) {
            omittedRunIds.push(priorRunId);
            historyScanTruncated = true;
            continue;
          }
          loadedChars += user.length + assistant.length;
          // The recheck above is only half of the source contract: a decision that was made
          // because a source was a content source stays marked that way for the next Run that
          // re-reads this turn, so a later reader is not re-adjudicated against a stricter
          // access gate it never had to pass. Marked here, after the turn is admitted, because
          // a turn whose delivery is dropped leaves no reason to carry its marker forward.
          for (const source of currentSourceDecisions) {
            await tx.execute({
              sql: "UPDATE authorization_decisions SET delivery_source = ? WHERE id = ? AND decision = 'ALLOW' AND delivery_source IS NULL",
              args: [source.source, source.id],
            });
          }
          exchanges.push({
            runId: priorRunId,
            user,
            assistant,
            principalId: priorPrincipalId,
            ...(senderIdFor(prior) === undefined ? {} : { senderId: senderIdFor(prior) }),
          });
        }
        exchanges.reverse();
        const history = exchanges.flatMap(({ user, assistant }) => [
          { role: "user" as const, text: user },
          { role: "assistant" as const, text: assistant },
        ]);
        const sessionPrincipal = conversation.providerSessionPrincipalId;
        const providerSessionId =
          conversation.providerKind === run.executionRef && sessionPrincipal === caller.principalId
            ? conversation.providerSessionId
            : null;
        const inputRecord: RunInputRecord = {
          run,
          conversation: {
            ...conversation,
            providerKind: providerSessionId ? run.executionRef : null,
            providerSessionId,
            providerSessionPrincipalId: providerSessionId ? caller.principalId : null,
          },
          text: stringColumn(row, "input_text"),
          ...(images.length ? { images } : {}),
          ...(typeof imageFailureCode === "string"
            ? { imageFailureCode: imageFailureCode as IncomingImageFailure }
            : {}),
          history,
          // Only a Conversation that several senders share needs per-turn attribution. A private
          // Conversation has one speaker by construction, so the field stays absent rather than
          // repeating the same principal on every line.
          ...(sharedConversation
            ? {
                historyActors: history.map((_, index) => {
                  const exchange = exchanges[Math.floor(index / 2)]!;
                  return {
                    principalId: exchange.principalId,
                    ...(exchange.senderId === undefined ? {} : { senderId: exchange.senderId }),
                  };
                }),
              }
            : {}),
          historyRunIds: exchanges.map((exchange) => exchange.runId),
          historyScanTruncated,
          historyOmittedRunIds: omittedRunIds,
          providerSessionId,
          ...(taskStepBinding ? { taskStepBinding } : {}),
          ...(stepResults?.length ? { stepResults } : {}),
        };
        return { value: inputRecord };
      }),
    );
  }

  async setProviderSession(
    caller: CallerContext,
    conversationId: string,
    providerKind: string,
    providerSessionId: string,
  ): Promise<void> {
    requireIdentifier(providerKind);
    requireIdentifier(providerSessionId);
    authorizedValue(
      await this.db.transaction<AuthorizedResult<void>>(async (tx) => {
        const decision = await authorizeConversation(tx, caller, conversationId, "run:control");
        if ("denied" in decision) return decision;
        const used = await tx.execute({
          sql: "SELECT id FROM conversations WHERE provider_kind = ? AND provider_session_id = ? AND id <> ?",
          args: [providerKind, providerSessionId, conversationId],
        });
        if (used.rows.length)
          throw new Error("Provider Session already belongs to a different Conversation");
        await tx.execute({
          sql: "UPDATE conversations SET provider_kind = ?, provider_session_id = ?, provider_session_principal_id = ? WHERE id = ?",
          args: [providerKind, providerSessionId, caller.principalId, conversationId],
        });
        return { value: undefined };
      }),
    );
  }
}
