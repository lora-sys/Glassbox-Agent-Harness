import { ManagementApiError } from "./errors";

export const RUN_STATUSES = [
  "queued",
  "running",
  "cancelling",
  "cancelled",
  "succeeded",
  "failed",
  "interrupted",
  "unknown",
] as const;
export type ManagedRunStatus = (typeof RUN_STATUSES)[number];
export interface ManagedScope {
  connectionId: string;
  botId: string;
  chatType: "private" | "group";
  chatId: string;
  senderId: string;
  threadId?: string;
}
export interface ManagedConversation {
  id: string;
  agentId: string;
  principalId: string;
  scope: ManagedScope;
  createdAt: string;
}
export interface ManagedRun {
  id: string;
  conversationId: string;
  messageId: string;
  executionRef: string;
  status: ManagedRunStatus;
  resultText: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ManagedRunListItem extends ManagedRun {
  scope: ManagedScope;
}
export interface RecordPage<T> {
  items: T[];
  nextCursor: string | null;
}
export interface ManagedDelivery {
  id: string;
  runId: string;
  dedupKey: string;
  destinationScopeKey: string;
  payloadText: string;
  payloadKind: "text" | "result" | "ack";
  status: "pending" | "sending" | "sent" | "failed" | "unknown";
  externalId: string | null;
}
export interface ManagedTraceEntry {
  seq: number;
  ts: string;
  event: unknown;
  provenance: string;
}
export interface ManagedTracePage {
  records: ManagedTraceEntry[];
  nextCursor: string | null;
  indexed: { runId: string; traceRef: string; byteOffset: number; eventCount: number } | null;
}

function invalid(): never {
  throw new ManagementApiError("INVALID_RESPONSE");
}
export function recordsObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function keys(input: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(input).some((key) => !allowed.includes(key))) invalid();
}
export function recordText(value: unknown, max = 512): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    return invalid();
  return value;
}
function content(value: unknown, max = 64000): string {
  if (typeof value !== "string" || value.length > max) return invalid();
  return value;
}
export function recordCounter(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalid();
  return value;
}
export function recordTime(value: unknown): string {
  const time = recordText(value, 40);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(time) ||
    Number.isNaN(Date.parse(time))
  )
    return invalid();
  return time;
}
export function recordCursor(value: unknown): string | null {
  if (value === null) return null;
  const cursor = recordText(value, 4096);
  if (!/^[A-Za-z0-9_-]+$/u.test(cursor)) return invalid();
  return cursor;
}

export function decodeManagedScope(value: unknown): ManagedScope {
  const input = recordsObject(value);
  keys(input, ["connectionId", "botId", "chatType", "chatId", "senderId", "threadId"]);
  if (input.chatType !== "private" && input.chatType !== "group") return invalid();
  return {
    connectionId: recordText(input.connectionId),
    botId: recordText(input.botId),
    chatType: input.chatType,
    chatId: recordText(input.chatId),
    senderId: recordText(input.senderId),
    ...(input.threadId === undefined ? {} : { threadId: recordText(input.threadId) }),
  };
}

function decodeConversation(value: unknown): ManagedConversation {
  const input = recordsObject(value);
  keys(input, ["id", "agentId", "principalId", "scope", "createdAt"]);
  return {
    id: recordText(input.id),
    agentId: recordText(input.agentId),
    principalId: recordText(input.principalId),
    scope: decodeManagedScope(input.scope),
    createdAt: recordTime(input.createdAt),
  };
}

export function decodeManagedRun(value: unknown): ManagedRun {
  const input = recordsObject(value);
  keys(input, [
    "id",
    "conversationId",
    "messageId",
    "executionRef",
    "status",
    "resultText",
    "createdAt",
    "updatedAt",
    "scope",
  ]);
  if (!RUN_STATUSES.some((status) => status === input.status)) return invalid();
  return {
    id: recordText(input.id),
    conversationId: recordText(input.conversationId),
    messageId: recordText(input.messageId),
    executionRef: recordText(input.executionRef),
    status: input.status as ManagedRunStatus,
    resultText: input.resultText === null ? null : content(input.resultText),
    createdAt: recordTime(input.createdAt),
    updatedAt: recordTime(input.updatedAt),
  };
}

export function decodeRecordPage<T>(
  value: unknown,
  decode: (item: unknown) => T & { id: string },
): RecordPage<T> {
  const input = recordsObject(value);
  keys(input, ["items", "nextCursor"]);
  if (!Array.isArray(input.items) || input.items.length > 100) return invalid();
  const items = input.items.map(decode);
  if (new Set(items.map((item) => item.id)).size !== items.length) return invalid();
  return { items, nextCursor: recordCursor(input.nextCursor) };
}

export function decodeConversations(value: unknown): RecordPage<ManagedConversation> {
  return decodeRecordPage(value, decodeConversation);
}
export function decodeRuns(value: unknown): RecordPage<ManagedRunListItem> {
  return decodeRecordPage(value, (item) => ({
    ...decodeManagedRun(item),
    scope: decodeManagedScope(recordsObject(item).scope),
  }));
}
export function decodeRunResult(value: unknown, expectedId: string): ManagedRun {
  const input = recordsObject(value);
  keys(input, ["run"]);
  const run = decodeManagedRun(input.run);
  if (run.id !== expectedId) return invalid();
  return run;
}

export function decodeDeliveries(
  value: unknown,
  expectedRunId: string,
): RecordPage<ManagedDelivery> {
  return decodeRecordPage(value, (item): ManagedDelivery => {
    const input = recordsObject(item);
    keys(input, [
      "id",
      "runId",
      "dedupKey",
      "destinationScopeKey",
      "payloadText",
      "payloadKind",
      "status",
      "externalId",
    ]);
    if (
      input.runId !== expectedRunId ||
      !["text", "result", "ack"].includes(String(input.payloadKind)) ||
      !["pending", "sending", "sent", "failed", "unknown"].includes(String(input.status))
    )
      return invalid();
    return {
      id: recordText(input.id),
      runId: expectedRunId,
      dedupKey: recordText(input.dedupKey),
      destinationScopeKey: recordText(input.destinationScopeKey, 4096),
      payloadText: content(input.payloadText),
      payloadKind: input.payloadKind as ManagedDelivery["payloadKind"],
      status: input.status as ManagedDelivery["status"],
      externalId: input.externalId === null ? null : recordText(input.externalId),
    };
  });
}

export function decodeTrace(value: unknown, expectedRunId: string): ManagedTracePage {
  const input = recordsObject(value);
  // Older servers also return the same records as items. The UI never duplicates them.
  keys(input, ["records", "items", "nextCursor", "indexed"]);
  if (!Array.isArray(input.records) || input.records.length > 1000) return invalid();
  const records = input.records.map((value): ManagedTraceEntry => {
    const entry = recordsObject(value);
    keys(entry, ["seq", "ts", "event", "provenance"]);
    const seq = recordCounter(entry.seq);
    if (seq === 0 || !Object.hasOwn(entry, "event")) return invalid();
    return {
      seq,
      ts: recordTime(entry.ts),
      event: entry.event,
      provenance: recordText(entry.provenance),
    };
  });
  if (records.some((entry, index) => index > 0 && entry.seq !== records[index - 1]!.seq + 1))
    return invalid();
  let indexed: ManagedTracePage["indexed"] = null;
  if (input.indexed !== null) {
    const index = recordsObject(input.indexed);
    keys(index, ["runId", "traceRef", "byteOffset", "eventCount"]);
    if (index.runId !== expectedRunId) return invalid();
    indexed = {
      runId: expectedRunId,
      traceRef: recordText(index.traceRef),
      byteOffset: recordCounter(index.byteOffset),
      eventCount: recordCounter(index.eventCount),
    };
  }
  if (indexed === null && records.length > 0) return invalid();
  return { records, nextCursor: recordCursor(input.nextCursor), indexed };
}
