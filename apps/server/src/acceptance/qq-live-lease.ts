import { createHash, randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { scopeKey, validateScope, type TrustedChannelScope } from "../identity/scope.js";

export const QQ_LIVE_ACCEPTANCE_MARKER = "GLASSBOX_ACCEPTANCE_V1";
export const QQ_LIVE_ACCEPTANCE_MAX_TTL_MS = 30 * 60 * 1_000;
export const QQ_LIVE_ACCEPTANCE_MAX_LEASES = 64;
export const QQ_LIVE_ACCEPTANCE_MAX_TOMBSTONES = 4_096;

const MARKER_LINE = /^GLASSBOX_ACCEPTANCE_V1 ([a-f0-9]{32})$/iu;
const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export type JsonPrimitive = string | number | boolean | null;
export type JsonConstraint = JsonPrimitive | JsonConstraint[] | { [key: string]: JsonConstraint };

export interface QqLiveLeaseOperation {
  action: string;
  resourceId: string;
  inputConstraint: { [key: string]: JsonConstraint };
}

export interface QqLiveLeaseTool {
  name: string;
  operations: QqLiveLeaseOperation[];
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (plainRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function canonicalQqLiveToolsSha256(tools: readonly QqLiveLeaseTool[]): string {
  return createHash("sha256").update(canonicalJson(tools), "utf8").digest("hex");
}

export interface RegisterQqLiveLeaseInput {
  principalId: string;
  scope: TrustedChannelScope;
  marker: string;
  textSha256: string;
  ttlMs: number;
  expiresAt: number;
  tools: QqLiveLeaseTool[];
}

export interface QqLiveLeaseBinding {
  leaseId: string;
  principalId: string;
  scope: TrustedChannelScope;
  messageId: string;
  runId: string;
}

export type QqLiveInboundResolution =
  | { kind: "ordinary" }
  | { kind: "denied"; reason: "lease_unavailable" | "lease_expired" | "binding_mismatch" }
  | { kind: "acceptance"; leaseId: string; marker: string; toolsSha256: string };

export interface QqLiveLeaseClock {
  now(): number;
}

interface LeaseRecord {
  id: string;
  principalId: string;
  scope: TrustedChannelScope;
  scopeKey: string;
  marker: string;
  textSha256: string;
  expiresAt: number;
  tools: QqLiveLeaseTool[];
  toolsSha256: string;
  messageId?: string;
  runId?: string;
  revoked: boolean;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value: unknown, depth = 0): JsonConstraint {
  if (depth > 32) throw new Error("invalid_lease_constraint");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => cloneJson(item, depth + 1));
  if (!plainRecord(value)) throw new Error("invalid_lease_constraint");
  const result: Record<string, JsonConstraint> = Object.create(null) as Record<
    string,
    JsonConstraint
  >;
  for (const [key, item] of Object.entries(value)) {
    if (BLOCKED_KEYS.has(key)) throw new Error("invalid_lease_constraint");
    result[key] = cloneJson(item, depth + 1);
  }
  return result;
}

function cloneScope(scope: TrustedChannelScope): TrustedChannelScope {
  validateScope(scope);
  return {
    connectionId: scope.connectionId,
    botId: scope.botId,
    chatType: scope.chatType,
    chatId: scope.chatId,
    senderId: scope.senderId,
    ...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
    ...(scope.nativeGroupRole === undefined
      ? {}
      : { nativeGroupRole: { ...scope.nativeGroupRole } }),
  };
}

function cloneTools(input: readonly QqLiveLeaseTool[]): QqLiveLeaseTool[] {
  if (!Array.isArray(input) || input.length > 64) throw new Error("invalid_lease_tools");
  const names = new Set<string>();
  return input.map((tool) => {
    if (
      !plainRecord(tool) ||
      typeof tool.name !== "string" ||
      !/^[a-z][a-z0-9_]{0,63}$/u.test(tool.name) ||
      names.has(tool.name) ||
      !Array.isArray(tool.operations) ||
      tool.operations.length === 0 ||
      tool.operations.length > 64
    )
      throw new Error("invalid_lease_tools");
    names.add(tool.name);
    const operations = tool.operations.map((operation) => {
      if (
        !plainRecord(operation) ||
        typeof operation.action !== "string" ||
        operation.action.length === 0 ||
        operation.action.length > 128 ||
        typeof operation.resourceId !== "string" ||
        operation.resourceId.length === 0 ||
        operation.resourceId.length > 256 ||
        !plainRecord(operation.inputConstraint)
      )
        throw new Error("invalid_lease_operation");
      return {
        action: operation.action,
        resourceId: operation.resourceId,
        inputConstraint: cloneJson(operation.inputConstraint) as { [key: string]: JsonConstraint },
      };
    });
    return { name: tool.name, operations };
  });
}

function markerStatus(
  text: string,
): { kind: "ordinary" } | { kind: "invalid_marker" } | { kind: "marker"; marker: string } {
  const firstLine = text.split(/\r\n|\n|\r/u, 1)[0] ?? "";
  const match = MARKER_LINE.exec(firstLine);
  if (match) return { kind: "marker", marker: match[1]!.toLowerCase() };
  if (firstLine.startsWith(QQ_LIVE_ACCEPTANCE_MARKER)) return { kind: "invalid_marker" };
  return { kind: "ordinary" };
}

/** True when a Run must fail closed if its in-memory lease binding is unavailable. */
export function hasQqLiveAcceptanceMarker(text: string): boolean {
  return markerStatus(text).kind !== "ordinary";
}

export function canonicalQqLiveTextSha256(text: string): string {
  const canonical = text.replace(/\r\n?/gu, "\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Append safe, payload-free evidence for marker messages denied before a Run exists. */
export async function appendQqLiveAcceptanceAudit(
  dataDirectory: string,
  input: {
    event: "message_denied" | "lease_registered" | "lease_revoked" | "run_bound";
    messageId?: string;
    scope?: TrustedChannelScope;
    principalId?: string;
    leaseId?: string;
    reason?: string;
    marker?: string;
    expiresAt?: number;
    toolsSha256?: string;
    runId?: string;
    textSha256?: string;
    at?: string;
  },
): Promise<void> {
  const event = {
    at: input.at ?? new Date().toISOString(),
    event: input.event,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
    ...(input.principalId === undefined ? {} : { principalId: input.principalId }),
    ...(input.leaseId === undefined ? {} : { leaseId: input.leaseId }),
    ...(input.marker === undefined ? {} : { marker: input.marker }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    ...(input.toolsSha256 === undefined ? {} : { toolsSha256: input.toolsSha256 }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.textSha256 === undefined ? {} : { textSha256: input.textSha256 }),
    ...(input.scope === undefined
      ? {}
      : { scopeSha256: createHash("sha256").update(scopeKey(input.scope), "utf8").digest("hex") }),
  };
  await appendFile(
    join(dataDirectory, "qq-live-acceptance-audit.jsonl"),
    `${JSON.stringify(event)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function exactJsonEqual(actual: unknown, expected: JsonConstraint): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => exactJsonEqual(actual[index], item))
    );
  }
  if (plainRecord(expected)) {
    if (!plainRecord(actual) || Object.keys(actual).length !== Object.keys(expected).length)
      return false;
    return Object.entries(expected).every(
      ([key, value]) => Object.hasOwn(actual, key) && exactJsonEqual(actual[key], value),
    );
  }
  return Object.is(actual, expected);
}

function jsonSubset(actual: unknown, expected: JsonConstraint): boolean {
  if (Array.isArray(expected)) return exactJsonEqual(actual, expected);
  if (plainRecord(expected)) {
    if (!plainRecord(actual)) return false;
    return Object.entries(expected).every(
      ([key, value]) => Object.hasOwn(actual, key) && jsonSubset(actual[key], value),
    );
  }
  return Object.is(actual, expected);
}

function matchesConstraint(
  constraint: Readonly<Record<string, JsonConstraint>>,
  input: Readonly<Record<string, unknown>>,
): boolean {
  if (!plainRecord(input)) return false;
  return Object.entries(constraint).every(
    ([key, expected]) => Object.hasOwn(input, key) && jsonSubset(input[key], expected),
  );
}

/**
 * In-memory restrictions for one explicitly prepared QQ acceptance message.
 * This registry narrows a Run and never replaces normal AuthorizationService checks.
 */
export class QqLiveLeaseRegistry {
  private readonly leases = new Map<string, LeaseRecord>();
  private readonly markers = new Map<string, string>();
  private readonly cancelledMarkers = new Map<string, number>();
  private registrationsBlockedUntil = 0;
  private readonly now: () => number;

  constructor(clock: QqLiveLeaseClock = { now: () => Date.now() }) {
    this.now = () => clock.now();
  }

  register(input: RegisterQqLiveLeaseInput): {
    leaseId: string;
    marker: string;
    expiresAt: number;
    toolsSha256: string;
  } {
    if (
      typeof input.principalId !== "string" ||
      input.principalId.length === 0 ||
      input.principalId.length > 512 ||
      !/^[a-f0-9]{32}$/iu.test(input.marker) ||
      !/^[a-f0-9]{64}$/u.test(input.textSha256) ||
      !Number.isSafeInteger(input.ttlMs) ||
      input.ttlMs <= 0 ||
      input.ttlMs > QQ_LIVE_ACCEPTANCE_MAX_TTL_MS ||
      !Number.isSafeInteger(input.expiresAt)
    )
      throw new Error("invalid_lease");
    this.prune();
    const marker = input.marker.toLowerCase();
    const now = this.now();
    if (
      now < this.registrationsBlockedUntil ||
      input.expiresAt <= now ||
      input.expiresAt > now + input.ttlMs ||
      this.cancelledMarkers.has(marker) ||
      this.leases.size >= QQ_LIVE_ACCEPTANCE_MAX_LEASES ||
      this.markers.has(marker)
    )
      throw new Error("lease_capacity_or_marker_conflict");
    const scope = cloneScope(input.scope);
    const id = randomUUID();
    const expiresAt = input.expiresAt;
    const clonedTools = cloneTools(input.tools);
    const toolsSha256 = canonicalQqLiveToolsSha256(clonedTools);
    const record: LeaseRecord = {
      id,
      principalId: input.principalId,
      scope,
      scopeKey: scopeKey(scope),
      marker,
      textSha256: input.textSha256,
      expiresAt,
      tools: clonedTools,
      toolsSha256,
      revoked: false,
    };
    this.leases.set(id, record);
    this.markers.set(marker, id);
    return { leaseId: id, marker, expiresAt, toolsSha256 };
  }

  revoke(leaseId: string): boolean {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.revoked) return false;
    lease.revoked = true;
    this.markers.delete(lease.marker);
    this.cancelMarker(lease.marker);
    return true;
  }

  revokeMarker(marker: string): { leaseId?: string; revoked: boolean } | undefined {
    if (!/^[a-f0-9]{32}$/iu.test(marker)) return undefined;
    const normalizedMarker = marker.toLowerCase();
    const leaseId = this.markers.get(normalizedMarker);
    if (leaseId) {
      const revoked = this.revoke(leaseId);
      this.cancelMarker(normalizedMarker);
      return { leaseId, revoked };
    }
    this.cancelMarker(normalizedMarker);
    return { revoked: false };
  }

  resolveInbound(input: {
    principalId: string;
    scope: TrustedChannelScope;
    messageId: string;
    text: string;
  }): QqLiveInboundResolution {
    const parsed = markerStatus(input.text);
    if (parsed.kind === "ordinary") return { kind: "ordinary" };
    if (parsed.kind === "invalid_marker") return { kind: "denied", reason: "lease_unavailable" };
    const leaseId = this.markers.get(parsed.marker);
    const lease = leaseId ? this.leases.get(leaseId) : undefined;
    if (!lease || lease.revoked) return { kind: "denied", reason: "lease_unavailable" };
    if (this.now() >= lease.expiresAt) return { kind: "denied", reason: "lease_expired" };
    if (
      lease.principalId !== input.principalId ||
      lease.scopeKey !== safeScopeKey(input.scope) ||
      lease.textSha256 !== canonicalQqLiveTextSha256(input.text) ||
      typeof input.messageId !== "string" ||
      input.messageId.length === 0 ||
      input.messageId.length > 128
    )
      return { kind: "denied", reason: "binding_mismatch" };
    if (lease.messageId !== undefined && lease.messageId !== input.messageId)
      return { kind: "denied", reason: "binding_mismatch" };
    lease.messageId ??= input.messageId;
    return {
      kind: "acceptance",
      leaseId: lease.id,
      marker: lease.marker,
      toolsSha256: lease.toolsSha256,
    };
  }

  bindRun(input: QqLiveLeaseBinding): boolean {
    const lease = this.getBoundMessage(input);
    if (!lease || this.now() >= lease.expiresAt) return false;
    if (lease.runId !== undefined) return lease.runId === input.runId;
    if (!input.runId || input.runId.length > 128) return false;
    lease.runId = input.runId;
    return true;
  }

  isActive(input: QqLiveLeaseBinding): boolean {
    const lease = this.getBoundRun(input);
    return Boolean(lease && this.now() < lease.expiresAt);
  }

  filterToolNames(input: QqLiveLeaseBinding & { availableToolNames: readonly string[] }): string[] {
    const lease = this.getBoundRun(input);
    if (!lease || this.now() >= lease.expiresAt) return [];
    const permitted = new Set(lease.tools.map((tool) => tool.name));
    return [...new Set(input.availableToolNames.filter((name) => permitted.has(name)))];
  }

  /** Checks only the lease restriction. The caller must still perform normal authorization. */
  checkToolCall(
    input: QqLiveLeaseBinding & {
      toolName: string;
      action: string;
      resourceId: string;
      toolInput: Readonly<Record<string, unknown>>;
    },
  ): {
    allowed: boolean;
    reason: "allowed_by_lease" | "lease_unavailable" | "lease_expired" | "capability_mismatch";
  } {
    const lease = this.getBoundRun(input);
    if (!lease) return { allowed: false, reason: "lease_unavailable" };
    if (this.now() >= lease.expiresAt) return { allowed: false, reason: "lease_expired" };
    const tool = lease.tools.find((entry) => entry.name === input.toolName);
    const operation = tool?.operations.find(
      (entry) => entry.action === input.action && entry.resourceId === input.resourceId,
    );
    if (!operation || !matchesConstraint(operation.inputConstraint, input.toolInput))
      return { allowed: false, reason: "capability_mismatch" };
    return { allowed: true, reason: "allowed_by_lease" };
  }

  private getBoundMessage(input: QqLiveLeaseBinding): LeaseRecord | undefined {
    const lease = this.leases.get(input.leaseId);
    if (
      !lease ||
      lease.revoked ||
      lease.principalId !== input.principalId ||
      lease.scopeKey !== safeScopeKey(input.scope) ||
      lease.messageId !== input.messageId
    )
      return undefined;
    return lease;
  }

  private getBoundRun(input: QqLiveLeaseBinding): LeaseRecord | undefined {
    const lease = this.getBoundMessage(input);
    return lease && lease.runId === input.runId ? lease : undefined;
  }

  private prune(): void {
    const now = this.now();
    for (const [marker, expiresAt] of this.cancelledMarkers) {
      if (now >= expiresAt) this.cancelledMarkers.delete(marker);
    }
    if (now >= this.registrationsBlockedUntil) this.registrationsBlockedUntil = 0;
    for (const [id, lease] of this.leases) {
      if (lease.revoked || now >= lease.expiresAt) {
        this.leases.delete(id);
        this.markers.delete(lease.marker);
      }
    }
  }

  private cancelMarker(marker: string): void {
    if (this.cancelledMarkers.has(marker)) return;
    const expiresAt = this.now() + QQ_LIVE_ACCEPTANCE_MAX_TTL_MS;
    if (this.cancelledMarkers.size >= QQ_LIVE_ACCEPTANCE_MAX_TOMBSTONES) {
      // Losing a cancellation record could allow a delayed registration to restore authority.
      // Block registration through the maximum possible lifetime of that delayed request.
      this.registrationsBlockedUntil = Math.max(this.registrationsBlockedUntil, expiresAt);
      return;
    }
    this.cancelledMarkers.set(marker, expiresAt);
    if (this.cancelledMarkers.size >= QQ_LIVE_ACCEPTANCE_MAX_TOMBSTONES)
      this.registrationsBlockedUntil = Math.max(this.registrationsBlockedUntil, expiresAt);
  }
}

function safeScopeKey(scope: TrustedChannelScope): string | undefined {
  try {
    return scopeKey(scope);
  } catch {
    return undefined;
  }
}
