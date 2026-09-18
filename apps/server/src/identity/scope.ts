/** Adapter-created routing data. Never construct this from message text or nicknames. */
export interface TrustedChannelScope {
  connectionId: string;
  botId: string;
  chatType: "private" | "group";
  chatId: string;
  senderId: string;
  threadId?: string;
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
