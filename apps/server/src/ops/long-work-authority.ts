import type { CallerContext, TrustedChannelScope } from "../identity/scope.js";
import { scopeKey, validateScope } from "../identity/scope.js";
import type { DomainStore } from "../application/domain-store.js";
import { AccessDeniedError } from "../auth/service.js";
import { stringColumn } from "../persistence/database.js";

function parseStoredScope(value: string): TrustedChannelScope {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid stored Task origin scope");
  const raw = parsed as Record<string, unknown>;
  const scope: TrustedChannelScope = {
    connectionId: raw.connectionId as string,
    botId: raw.botId as string,
    chatType: raw.chatType as TrustedChannelScope["chatType"],
    chatId: raw.chatId as string,
    senderId: raw.senderId as string,
    ...(raw.threadId === undefined ? {} : { threadId: raw.threadId as string }),
  };
  validateScope(scope);
  return scope;
}

function scopeFromLegacyKey(key: string): TrustedChannelScope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(key);
  } catch {
    throw new Error("Invalid legacy Task origin scope key");
  }
  if (!Array.isArray(parsed) || parsed.length !== 6)
    throw new Error("Invalid legacy Task origin scope key");
  const [connectionId, botId, chatType, chatId, senderId, threadId] = parsed;
  if (
    typeof connectionId !== "string" ||
    typeof botId !== "string" ||
    (chatType !== "private" && chatType !== "group") ||
    typeof chatId !== "string" ||
    typeof senderId !== "string" ||
    (threadId !== null && typeof threadId !== "string")
  )
    throw new Error("Invalid legacy Task origin scope key");
  const scope: TrustedChannelScope = {
    connectionId,
    botId,
    chatType,
    chatId,
    senderId,
    ...(threadId === null ? {} : { threadId }),
  };
  validateScope(scope);
  if (scopeKey(scope) !== key) throw new Error("Non-canonical legacy Task origin scope key");
  return scope;
}

/** Rechecks current identity and grants before a resumed Task performs protected work. */
export async function authorizeLongWorkAction(
  store: Pick<DomainStore, "db" | "authorization">,
  input: {
    taskId: string;
    caller?: CallerContext;
    resourceId: string;
    action: string;
  },
): Promise<string> {
  const row = await store.db.transaction(async (tx) => {
    const result = await tx.execute({
      sql: "SELECT creator_principal_id, origin_scope_key, origin_scope_json FROM tasks WHERE id = ?",
      args: [input.taskId],
    });
    return result.rows[0] ?? null;
  });
  if (!row) throw new Error("Task not found");
  const creatorPrincipalId = stringColumn(row, "creator_principal_id");
  const originScopeKey = stringColumn(row, "origin_scope_key");
  const storedScopeJson = row.origin_scope_json;
  const storedScope =
    typeof storedScopeJson === "string"
      ? parseStoredScope(storedScopeJson)
      : scopeFromLegacyKey(originScopeKey);

  if (input.caller && input.caller.principalId !== creatorPrincipalId)
    throw new Error("Long-work caller does not match Task creator");
  if (
    scopeKey(storedScope) !== originScopeKey ||
    (input.caller && scopeKey(input.caller.scope) !== originScopeKey)
  )
    throw new Error("Long-work caller scope does not match Task origin");

  const decision = await store.authorization.check({
    caller: { principalId: creatorPrincipalId, scope: storedScope },
    resourceId: input.resourceId,
    action: input.action,
    delegatedTaskId: input.taskId,
  });
  if (decision.decision !== "ALLOW") throw new AccessDeniedError(decision);
  return decision.id;
}

/** Reconstructs the trusted origin identity for server-owned Task continuation. */
export async function getLongWorkCaller(
  store: Pick<DomainStore, "db">,
  taskId: string,
): Promise<CallerContext> {
  const row = await store.db.transaction(async (tx) => {
    const result = await tx.execute({
      sql: "SELECT creator_principal_id, origin_scope_key, origin_scope_json FROM tasks WHERE id = ?",
      args: [taskId],
    });
    return result.rows[0] ?? null;
  });
  if (!row) throw new Error("Task not found");
  const originScopeKey = stringColumn(row, "origin_scope_key");
  const storedScopeJson = row.origin_scope_json;
  const scope =
    typeof storedScopeJson === "string"
      ? parseStoredScope(storedScopeJson)
      : scopeFromLegacyKey(originScopeKey);
  if (scopeKey(scope) !== originScopeKey) throw new Error("Invalid stored Task origin scope");
  return { principalId: stringColumn(row, "creator_principal_id"), scope };
}
