import { toolOutcomeFromFailure, type ToolExecutionOutcome } from "../runtime/pi/tool-plane.js";
import type { TraceEntry } from "../trace/store.js";

export const GROUP_ROLE_AUDIT_RECORD_CAP = 200;
const ROLE_TOOLS = ["qq_group_moderation", "qq_group_local_settings", "qq_group_settings"] as const;
const ROLE_OPERATIONS = new Set([
  "set_group_ban",
  "set_group_kick",
  "set_group_whole_ban",
  "set_group_name",
  "set_group_card",
  "set_group_admin",
]);
const ROLE_SET = new Set(["qq_group_owner", "qq_group_admin", "qq_group_member"]);
const VERIFICATION_SET = new Set(["verified", "mismatch", "unknown", "unavailable", "failed"]);
const AUTHORIZATION_SET = new Set(["ALLOW", "DENY", "REQUIRES_APPROVAL"]);
const SURFACE_REASONS = new Set([
  "disabled_by_host",
  "scope_not_permitted",
  "policy_disabled",
  "discovery_denied",
  "no_caller_context",
  "unclassified",
]);
const RUN_STATUSES = new Set([
  "queued",
  "running",
  "cancelling",
  "cancelled",
  "succeeded",
  "failed",
  "interrupted",
  "unknown",
]);
const DELIVERY_STATUSES = new Set(["pending", "sending", "sent", "failed", "blocked", "cancelled"]);

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<string>): T | undefined {
  return typeof value === "string" && allowed.has(value) ? (value as T) : undefined;
}

function roleTool(value: unknown): (typeof ROLE_TOOLS)[number] | undefined {
  return typeof value === "string" && ROLE_TOOLS.some((name) => name === value)
    ? (value as (typeof ROLE_TOOLS)[number])
    : undefined;
}

/** A content-free projection for the authenticated local Owner, limited to one managed group. */
export function projectGroupRoleAudit(input: {
  runId: string;
  groupId: string;
  createdAt: string;
  principalKind: "owner" | "visitor";
  records: readonly TraceEntry<unknown>[];
  complete: boolean;
}) {
  let ingressRole: string | undefined;
  let roleSource: string | undefined;
  let verification:
    | {
        observedRole?: string;
        verifiedRole?: string | null;
        status?: string;
        tool?: (typeof ROLE_TOOLS)[number];
        operation?: string;
        authorizationDecision?: string;
      }
    | undefined;
  const surfaces = new Map<
    (typeof ROLE_TOOLS)[number],
    { state: "selected" | "excluded"; reason?: string; providerReadiness?: string }
  >();
  const calls = new Map<string, { name: (typeof ROLE_TOOLS)[number]; at: string }>();
  const toolCalls: Array<{
    name: (typeof ROLE_TOOLS)[number];
    at: string;
    outcome: ToolExecutionOutcome;
  }> = [];
  let runStatus: string | undefined;
  let deliveryStatus: string | undefined;

  for (const record of input.records.slice(0, GROUP_ROLE_AUDIT_RECORD_CAP)) {
    const event = object(record.event);
    if (!event) continue;

    if (event.type === "native_group_role_observed" && event.groupId === input.groupId) {
      ingressRole = enumValue(event.observedRole, ROLE_SET);
      roleSource = event.roleSource === "onebot_message_sender" ? event.roleSource : undefined;
      continue;
    }

    if (
      event.type === "native_group_role_verification" &&
      event.groupId === input.groupId &&
      event.resourceId === `group:${input.groupId}`
    ) {
      const tool = roleTool(event.requestedTool);
      const operation =
        typeof event.requestedOperation === "string" &&
        ROLE_OPERATIONS.has(event.requestedOperation)
          ? event.requestedOperation
          : undefined;
      verification = {
        ...(enumValue(event.observedRole, ROLE_SET)
          ? { observedRole: enumValue(event.observedRole, ROLE_SET) }
          : {}),
        ...(event.verifiedRole === null
          ? { verifiedRole: null }
          : enumValue(event.verifiedRole, ROLE_SET)
            ? { verifiedRole: enumValue(event.verifiedRole, ROLE_SET) }
            : {}),
        ...(enumValue(event.verificationStatus, VERIFICATION_SET)
          ? { status: enumValue(event.verificationStatus, VERIFICATION_SET) }
          : {}),
        ...(tool ? { tool } : {}),
        ...(operation ? { operation } : {}),
        ...(enumValue(event.authorizationDecision, AUTHORIZATION_SET)
          ? { authorizationDecision: enumValue(event.authorizationDecision, AUTHORIZATION_SET) }
          : {}),
      };
      continue;
    }

    const data = object(event.data);
    if (event.type === "session_start") {
      const toolSurface = object(data?.toolSurface);
      const selected = Array.isArray(toolSurface?.selected) ? toolSurface.selected : [];
      const excluded = Array.isArray(toolSurface?.excluded) ? toolSurface.excluded : [];
      for (const raw of selected) {
        const entry = object(raw);
        const name = roleTool(entry?.name);
        if (!name) continue;
        const providerReadiness =
          entry?.providerReadiness === "ready" || entry?.providerReadiness === "unavailable"
            ? entry.providerReadiness
            : "unknown";
        surfaces.set(name, { state: "selected", providerReadiness });
      }
      for (const raw of excluded) {
        const entry = object(raw);
        const name = roleTool(entry?.name);
        if (!name || surfaces.has(name)) continue;
        const reason = enumValue(entry?.reason, SURFACE_REASONS);
        surfaces.set(name, {
          state: "excluded",
          ...(reason ? { reason } : {}),
          providerReadiness:
            entry?.providerReadiness === "ready" || entry?.providerReadiness === "unavailable"
              ? entry.providerReadiness
              : "unknown",
        });
      }
      continue;
    }

    if (event.type === "tool_call") {
      const name = roleTool(data?.name);
      if (name && typeof data?.toolCallId === "string")
        calls.set(data.toolCallId, { name, at: record.ts });
      continue;
    }

    if (event.type === "tool_result" && typeof data?.toolCallId === "string") {
      const call = calls.get(data.toolCallId);
      if (!call) continue;
      const failureCode = typeof data.failureCode === "string" ? data.failureCode : undefined;
      const outcome =
        data.isError === false
          ? "success"
          : data.isError === true && failureCode
            ? toolOutcomeFromFailure(failureCode)
            : "unknown";
      toolCalls.push({ name: call.name, at: call.at, outcome });
      continue;
    }

    if (event.type === "run_finished") runStatus = enumValue(event.status, RUN_STATUSES);
    else if (event.type === "delivery_changed")
      deliveryStatus = enumValue(event.status, DELIVERY_STATUSES);
  }

  return {
    runId: input.runId,
    groupId: input.groupId,
    createdAt: input.createdAt,
    principalKind: input.principalKind,
    trace: {
      complete: input.complete,
      recordsRead: Math.min(input.records.length, GROUP_ROLE_AUDIT_RECORD_CAP),
      recordCap: GROUP_ROLE_AUDIT_RECORD_CAP,
    },
    ingress: {
      role: ingressRole ?? null,
      ...(roleSource ? { source: roleSource } : {}),
    },
    surface: ROLE_TOOLS.map((name) => {
      const entry = surfaces.get(name);
      return {
        name,
        state: entry?.state ?? "not_observed",
        ...(entry?.reason ? { exclusionReason: entry.reason } : {}),
        ...(entry?.providerReadiness ? { providerReadiness: entry.providerReadiness } : {}),
      };
    }),
    verification: verification ?? null,
    toolCalls: toolCalls.slice(-20),
    runStatus: runStatus ?? null,
    deliveryStatus: deliveryStatus ?? null,
  };
}
