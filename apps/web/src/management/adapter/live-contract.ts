/** The current server-owned /manage record contract. Design fixtures use separate projections. */
export type LivePage<T> = { items: T[]; nextCursor: string | null };
export type LiveScope = {
  connectionId: string;
  botId: string;
  chatType: "private" | "group";
  chatId: string;
  senderId: string;
};
export type LiveConversation = {
  id: string;
  agentId: string;
  principalId: string;
  scope: LiveScope;
  createdAt: string;
};
export type LiveRunStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "cancelled"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "unknown";
export type LiveRun = {
  id: string;
  conversationId: string;
  principalId: string;
  executionRef: string;
  status: LiveRunStatus;
  resultText: string | null;
  createdAt: string;
  updatedAt: string;
  scope: LiveScope;
};
export type LiveTraceRecord = {
  seq: number;
  ts: string;
  provenance: string;
  event: unknown;
};

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${name} response`);
  return value as Record<string, unknown>;
}
function string(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${name} response`);
  return value;
}
function scope(value: unknown): LiveScope {
  const raw = object(value, "scope");
  const chatType = string(raw.chatType, "scope.chatType");
  if (chatType !== "private" && chatType !== "group")
    throw new Error("Invalid scope.chatType response");
  return {
    connectionId: string(raw.connectionId, "scope.connectionId"),
    botId: string(raw.botId, "scope.botId"),
    chatType,
    chatId: string(raw.chatId, "scope.chatId"),
    senderId: string(raw.senderId, "scope.senderId"),
  };
}
function page<T>(value: unknown, item: (value: unknown) => T): LivePage<T> {
  const raw = object(value, "page");
  if (!Array.isArray(raw.items) || (raw.nextCursor !== null && typeof raw.nextCursor !== "string"))
    throw new Error("Invalid server page response");
  return { items: raw.items.map(item), nextCursor: raw.nextCursor };
}
export function parseLiveConversations(value: unknown): LivePage<LiveConversation> {
  return page(value, (entry) => {
    const raw = object(entry, "conversation");
    return {
      id: string(raw.id, "conversation.id"),
      agentId: string(raw.agentId, "conversation.agentId"),
      principalId: string(raw.principalId, "conversation.principalId"),
      scope: scope(raw.scope),
      createdAt: string(raw.createdAt, "conversation.createdAt"),
    };
  });
}
export function parseLiveRuns(value: unknown): LivePage<LiveRun> {
  const statuses: readonly string[] = [
    "queued",
    "running",
    "cancelling",
    "cancelled",
    "succeeded",
    "failed",
    "interrupted",
    "unknown",
  ];
  return page(value, (entry) => {
    const raw = object(entry, "run");
    const status = string(raw.status, "run.status");
    if (!statuses.includes(status)) throw new Error("Invalid run.status response");
    if (raw.resultText !== null && typeof raw.resultText !== "string")
      throw new Error("Invalid run.resultText response");
    return {
      id: string(raw.id, "run.id"),
      conversationId: string(raw.conversationId, "run.conversationId"),
      principalId: string(raw.principalId, "run.principalId"),
      executionRef: string(raw.executionRef, "run.executionRef"),
      status: status as LiveRunStatus,
      resultText: raw.resultText,
      createdAt: string(raw.createdAt, "run.createdAt"),
      updatedAt: string(raw.updatedAt, "run.updatedAt"),
      scope: scope(raw.scope),
    };
  });
}
export function parseLiveTrace(value: unknown): LivePage<LiveTraceRecord> {
  const raw = object(value, "trace");
  return page({ items: raw.records, nextCursor: raw.nextCursor }, (entry) => {
    const record = object(entry, "trace record");
    if (!Number.isInteger(record.seq) || (record.seq as number) < 1)
      throw new Error("Invalid trace sequence response");
    return {
      seq: record.seq as number,
      ts: string(record.ts, "trace timestamp"),
      provenance: string(record.provenance, "trace provenance"),
      event: record.event,
    };
  });
}
