import type { Row, Transaction } from "@libsql/client";
import { QQ_SOURCE_CLASSES, type QqSourceClass } from "@glassbox/contracts";
import { QQ_CAPABILITIES, type QqCapabilityCategory } from "../channels/onebot/capabilities.js";
import { requireIdentifier, type CallerContext } from "../identity/scope.js";

/** Server-owned provenance. NULL means unknown legacy provenance, never explicit none. */
export type AuthorizationPolicyCondition =
  | { version: 1; kind: "none" }
  | {
      version: 1;
      kind: "qq_category";
      connectionId: string;
      groupId: string;
      category: QqCapabilityCategory;
    }
  | {
      version: 1;
      kind: "qq_memory_source";
      connectionId: string;
      groupId: string;
      sourceClass: QqSourceClass;
    };

export const SOURCE_CLASS_AUTHORITY: Record<
  QqSourceClass,
  { category: QqCapabilityCategory; action: string }
> = {
  history: { category: "group.history", action: "history:read" },
  notice: { category: "group.content", action: "group:content:read" },
  essence: { category: "group.content", action: "group:content:read" },
  album: { category: "group.content", action: "group:content:read" },
  metadata: { category: "group.read", action: "group:read" },
  file: { category: "group.files.read", action: "group:files:read" },
};

export function qqCategoryCondition(
  caller: CallerContext,
  groupId: string,
  category: QqCapabilityCategory,
): AuthorizationPolicyCondition {
  requireIdentifier(groupId);
  if (caller.scope.chatType === "group" && caller.scope.chatId !== groupId)
    throw new Error("policy_scope_mismatch");
  return {
    version: 1,
    kind: "qq_category",
    connectionId: caller.scope.connectionId,
    groupId,
    category,
  };
}

export function qqMemorySourceCondition(
  caller: CallerContext,
  connectionId: string,
  groupId: string,
  sourceClass: QqSourceClass,
): AuthorizationPolicyCondition {
  requireIdentifier(groupId);
  if (
    caller.scope.connectionId !== connectionId ||
    (caller.scope.chatType === "group" && caller.scope.chatId !== groupId)
  )
    throw new Error("policy_scope_mismatch");
  return { version: 1, kind: "qq_memory_source", connectionId, groupId, sourceClass };
}

function isCondition(value: unknown): value is AuthorizationPolicyCondition {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  if (c.version !== 1) return false;
  if (c.kind === "none") return Object.keys(c).length === 2;
  if (typeof c.connectionId !== "string" || typeof c.groupId !== "string") return false;
  try {
    requireIdentifier(c.connectionId);
    requireIdentifier(c.groupId);
  } catch {
    return false;
  }
  if (Object.keys(c).length !== 5) return false;
  if (c.kind === "qq_category")
    return QQ_CAPABILITIES.some(
      (entry) => entry.resource === "group" && entry.category === c.category,
    );
  return (
    c.kind === "qq_memory_source" && QQ_SOURCE_CLASSES.includes(c.sourceClass as QqSourceClass)
  );
}

/** Malformed persisted provenance remains a denial, including for ordinary resources. */
export function readPolicyCondition(row: Row): AuthorizationPolicyCondition | null {
  const raw = row.policy_condition_json;
  if (raw === null) return null;
  if (typeof raw !== "string") throw new Error("Invalid source policy condition");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Invalid source policy condition");
  }
  if (!isCondition(value)) throw new Error("Invalid source policy condition");
  return value;
}

export function policyConditionJson(
  condition: AuthorizationPolicyCondition | null | undefined,
): string | null {
  if (condition === null) return null;
  if (condition === undefined) return JSON.stringify({ version: 1, kind: "none" });
  if (!isCondition(condition)) return null;
  return JSON.stringify(condition);
}

export async function policyConditionAllows(
  tx: Transaction,
  input: {
    resourceId: string;
    resourceKind: string;
    action: string;
    policyCondition?: AuthorizationPolicyCondition | null;
  },
): Promise<boolean> {
  const condition = input.policyCondition;
  if (condition === undefined) return true;
  if (condition === null) {
    // Legacy QQ source routes cannot be reconstructed from Resource + Action.
    return !(
      input.resourceKind === "qq_group" &&
      input.resourceId.startsWith("group:") &&
      QQ_CAPABILITIES.some((entry) => entry.resource === "group" && entry.action === input.action)
    );
  }
  if (!isCondition(condition)) return false;
  if (condition.kind === "none") return true;
  if (input.resourceKind !== "qq_group" || input.resourceId !== `group:${condition.groupId}`)
    return false;
  const matchesAction =
    condition.kind === "qq_category"
      ? QQ_CAPABILITIES.some(
          (entry) =>
            entry.resource === "group" &&
            entry.category === condition.category &&
            entry.action === input.action,
        )
      : SOURCE_CLASS_AUTHORITY[condition.sourceClass].action === input.action;
  if (!matchesAction) return false;
  const rows = await tx.execute({
    sql: "SELECT policy_json FROM group_capability_policies WHERE connection_id = ? AND group_id = ?",
    args: [condition.connectionId, condition.groupId],
  });
  const raw = rows.rows[0]?.policy_json;
  if (typeof raw !== "string") return false;
  try {
    const policy = JSON.parse(raw);
    return (
      (condition.kind === "qq_category"
        ? policy?.categories?.[condition.category]
        : policy?.memorySources?.[condition.sourceClass]) === true
    );
  } catch {
    return false;
  }
}

/** Only this server-recorded gate protects access without reclassifying public group content. */
export function isPublicGroupCollectionGate(input: {
  resourceId: string;
  action: string;
  source: string;
  policyCondition: AuthorizationPolicyCondition | null;
}): boolean {
  return (
    input.resourceId === "owner-memory" &&
    input.action === "memory:read" &&
    input.source === "access_gate" &&
    input.policyCondition?.kind === "none"
  );
}
