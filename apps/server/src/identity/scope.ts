/** QQ's native role for one sender in one group. It is never a Glassbox global role. */
export type QqNativeGroupRole = "qq_group_owner" | "qq_group_admin" | "qq_group_member";

/** Trusted observation carried by one QQ group message and therefore by one Run. */
export interface QqNativeGroupRoleObservation {
  role: QqNativeGroupRole;
  source: "onebot_message_sender";
  observedAt: string;
}

function isQqNativeGroupRole(value: unknown): value is QqNativeGroupRole {
  return value === "qq_group_owner" || value === "qq_group_admin" || value === "qq_group_member";
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

/** Adapter-created routing data. Never construct this from message text or nicknames. */
export interface TrustedChannelScope {
  connectionId: string;
  botId: string;
  chatType: "private" | "group";
  chatId: string;
  senderId: string;
  threadId?: string;
  /** One Run's provider observation. It is not identity, a grant, or durable role truth. */
  nativeGroupRole?: QqNativeGroupRoleObservation;
}

export function requireIdentifier(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new Error("Invalid identifier");
  }
}

export function validateScope(scope: TrustedChannelScope): void {
  if (!scope || (scope.chatType !== "private" && scope.chatType !== "group"))
    throw new Error("Invalid channel scope");
  for (const value of [scope.connectionId, scope.botId, scope.chatId, scope.senderId])
    requireIdentifier(value);
  if (scope.threadId !== undefined) requireIdentifier(scope.threadId);
  if (scope.nativeGroupRole !== undefined) {
    if (
      scope.chatType !== "group" ||
      !isQqNativeGroupRole(scope.nativeGroupRole.role) ||
      scope.nativeGroupRole.source !== "onebot_message_sender" ||
      !isCanonicalTimestamp(scope.nativeGroupRole.observedAt)
    )
      throw new Error("Invalid native group role observation");
  }
}

// Adapted from OpenHarness gateway/router.py. JSON tuples preserve every namespace
// without delimiter collisions. Even private conversations include sender identity.
export function scopeKey(scope: TrustedChannelScope): string {
  validateScope(scope);
  return JSON.stringify([
    scope.connectionId,
    scope.botId,
    scope.chatType,
    scope.chatId,
    scope.senderId,
    scope.threadId ?? null,
  ]);
}

/** Durable conversation location key. In groups, senders share the conversation location. */
export function conversationScopeKey(scope: TrustedChannelScope): string {
  validateScope(scope);
  return JSON.stringify([
    scope.connectionId,
    scope.botId,
    scope.chatType,
    scope.chatId,
    scope.threadId ?? null,
  ]);
}

export function identityKey(
  scope: Pick<TrustedChannelScope, "connectionId" | "botId" | "senderId">,
): string {
  for (const value of [scope.connectionId, scope.botId, scope.senderId]) requireIdentifier(value);
  return JSON.stringify([scope.connectionId, scope.botId, scope.senderId]);
}

export interface CallerContext {
  principalId: string;
  scope: TrustedChannelScope;
}
