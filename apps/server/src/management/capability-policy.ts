import { QQ_SOURCE_CLASSES, type QqSourceClass } from "@glassbox/contracts";
import {
  QQ_CAPABILITY_CATEGORIES,
  type QqCapabilityCategory,
} from "../channels/onebot/capabilities.js";
import { DomainDatabase, stringColumn } from "../persistence/database.js";

/**
 * Durable Owner-configured capability policy for one managed QQ group.
 *
 * Policy is product intent, not authority. It decides which domain Tools a group exposes
 * and which P4A source classes may generate candidates. It never replaces the protected
 * Action check on the concrete Resource at execution time.
 */
export interface GroupCapabilityPolicy {
  categories: Partial<Record<QqCapabilityCategory, boolean>>;
  memorySources: Partial<Record<QqSourceClass, boolean>>;
}

/** Nothing is enabled until the Owner enables it. */
export const DEFAULT_GROUP_CAPABILITY_POLICY: GroupCapabilityPolicy = {
  categories: {},
  memorySources: {},
};

const CATEGORIES = new Set<string>(QQ_CAPABILITY_CATEGORIES);
const SOURCE_CLASSES = new Set<string>(QQ_SOURCE_CLASSES);

export function isCategoryEnabled(
  policy: GroupCapabilityPolicy,
  category: QqCapabilityCategory,
): boolean {
  return policy.categories[category] === true;
}

export function isMemorySourceEnabled(
  policy: GroupCapabilityPolicy,
  sourceClass: QqSourceClass,
): boolean {
  return policy.memorySources[sourceClass] === true;
}

export interface StoredGroupCapabilityPolicy {
  connectionId: string;
  groupId: string;
  policy: GroupCapabilityPolicy;
  version: number;
  updatedByPrincipalId: string;
  updatedAt: string;
}

/**
 * The category bundle a Run starts with: every category the Owner has enabled for any
 * managed group. This is a bootstrap for Tool discovery only. It never confers authority:
 * the per-group protected Action is still checked on the concrete Resource at call time,
 * so a category enabled for group A never lets a call reach group B.
 */
export function enabledCategoriesFor(
  policies: readonly StoredGroupCapabilityPolicy[],
): QqCapabilityCategory[] {
  const enabled = new Set<QqCapabilityCategory>();
  for (const stored of policies) {
    for (const [category, on] of Object.entries(stored.policy.categories)) {
      if (on) enabled.add(category as QqCapabilityCategory);
    }
  }
  return [...enabled];
}

/** The categories one group's own policy enables. Binds a group Run to that group's policy. */
export function enabledCategories(
  policy: GroupCapabilityPolicy | undefined,
): QqCapabilityCategory[] {
  const enabled: QqCapabilityCategory[] = [];
  for (const [category, on] of Object.entries(policy?.categories ?? {})) {
    if (on) enabled.push(category as QqCapabilityCategory);
  }
  return enabled;
}

/** Rejects a policy that names a category or source class Glassbox does not implement.
 * A provider upgrade or a typo can never silently widen the Tool or source surface. */
function validatedPolicy(input: unknown): GroupCapabilityPolicy {
  const record = (input ?? {}) as {
    categories?: Record<string, unknown>;
    memorySources?: Record<string, unknown>;
  };
  const categories: Partial<Record<QqCapabilityCategory, boolean>> = {};
  for (const [category, enabled] of Object.entries(record.categories ?? {})) {
    if (!CATEGORIES.has(category)) throw new Error("invalid_capability_category");
    if (typeof enabled !== "boolean") throw new Error("invalid_capability_category");
    categories[category as QqCapabilityCategory] = enabled;
  }
  const memorySources: Partial<Record<QqSourceClass, boolean>> = {};
  for (const [sourceClass, enabled] of Object.entries(record.memorySources ?? {})) {
    if (!SOURCE_CLASSES.has(sourceClass)) throw new Error("invalid_memory_source_class");
    if (typeof enabled !== "boolean") throw new Error("invalid_memory_source_class");
    memorySources[sourceClass as QqSourceClass] = enabled;
  }
  return { categories, memorySources };
}

function requireIdentifier(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128)
    throw new Error(message);
  return value;
}

const UPSERT_POLICY_SQL = `INSERT INTO group_capability_policies(connection_id, group_id, policy_json, version, updated_by_principal_id, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(connection_id, group_id) DO UPDATE SET policy_json = excluded.policy_json, version = excluded.version, updated_by_principal_id = excluded.updated_by_principal_id, updated_at = excluded.updated_at`;

export class CapabilityPolicyStore {
  constructor(private readonly db: DomainDatabase) {}

  async read(
    connectionId: string,
    groupId: string,
  ): Promise<StoredGroupCapabilityPolicy | undefined> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute({
        sql: "SELECT connection_id, group_id, policy_json, version, updated_by_principal_id, updated_at FROM group_capability_policies WHERE connection_id = ? AND group_id = ?",
        args: [connectionId, groupId],
      });
      const row = rows.rows[0];
      if (!row) return undefined;
      return {
        connectionId: stringColumn(row, "connection_id"),
        groupId: stringColumn(row, "group_id"),
        policy: validatedPolicy(JSON.parse(stringColumn(row, "policy_json"))),
        version: Number(row.version),
        updatedByPrincipalId: stringColumn(row, "updated_by_principal_id"),
        updatedAt: stringColumn(row, "updated_at"),
      };
    });
  }

  async list(connectionId: string): Promise<StoredGroupCapabilityPolicy[]> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute({
        sql: "SELECT connection_id, group_id, policy_json, version, updated_by_principal_id, updated_at FROM group_capability_policies WHERE connection_id = ? ORDER BY group_id",
        args: [connectionId],
      });
      return rows.rows.map((row) => ({
        connectionId: stringColumn(row, "connection_id"),
        groupId: stringColumn(row, "group_id"),
        policy: validatedPolicy(JSON.parse(stringColumn(row, "policy_json"))),
        version: Number(row.version),
        updatedByPrincipalId: stringColumn(row, "updated_by_principal_id"),
        updatedAt: stringColumn(row, "updated_at"),
      }));
    });
  }

  /** Writes the whole policy for a group. The version always increases so a Run can
   * tell whether the policy moved since it started. */
  async write(input: {
    connectionId: string;
    groupId: string;
    principalId: string;
    policy: GroupCapabilityPolicy;
  }): Promise<{ version: number }> {
    const policy = validatedPolicy(input.policy);
    return this.applyChange(input, (target) => {
      target.categories = policy.categories;
      target.memorySources = policy.memorySources;
    });
  }

  /**
   * Enables or disables one capability category without clobbering the group's other
   * policy fields. Read-modify-write happens inside one transaction so two concurrent
   * Owner actions cannot lose each other's change.
   */
  async setCategory(input: {
    connectionId: string;
    groupId: string;
    principalId: string;
    category: QqCapabilityCategory;
    enabled: boolean;
  }): Promise<{ version: number }> {
    if (!CATEGORIES.has(input.category)) throw new Error("invalid_capability_category");
    return this.applyChange(input, (target) => {
      target.categories = { ...target.categories, [input.category]: input.enabled };
    });
  }

  /** Enables or disables one P4A source class for a group. */
  async setMemorySource(input: {
    connectionId: string;
    groupId: string;
    principalId: string;
    sourceClass: QqSourceClass;
    enabled: boolean;
  }): Promise<{ version: number }> {
    if (!SOURCE_CLASSES.has(input.sourceClass)) throw new Error("invalid_memory_source_class");
    return this.applyChange(input, (target) => {
      target.memorySources = { ...target.memorySources, [input.sourceClass]: input.enabled };
    });
  }

  /** Change both history gates in one policy transaction and one version step. */
  async setHistory(input: {
    connectionId: string;
    groupId: string;
    principalId: string;
    enabled: boolean;
  }): Promise<{ version: number }> {
    return this.applyChange(input, (target) => {
      target.categories = { ...target.categories, "group.history": input.enabled };
      target.memorySources = { ...target.memorySources, history: input.enabled };
    });
  }

  private async applyChange(
    input: { connectionId: string; groupId: string; principalId: string },
    change: (policy: GroupCapabilityPolicy) => void,
  ): Promise<{ version: number }> {
    const connectionId = requireIdentifier(input.connectionId, "invalid_connection");
    const groupId = requireIdentifier(input.groupId, "invalid_group");
    const principalId = requireIdentifier(input.principalId, "invalid_principal");
    return this.db.transaction(async (tx) => {
      const current = await tx.execute({
        sql: "SELECT policy_json, version FROM group_capability_policies WHERE connection_id = ? AND group_id = ?",
        args: [connectionId, groupId],
      });
      const row = current.rows[0];
      const policy = row
        ? validatedPolicy(JSON.parse(stringColumn(row, "policy_json")))
        : { categories: {}, memorySources: {} };
      change(policy);
      const version = row ? Number(row.version) + 1 : 1;
      await tx.execute({
        sql: UPSERT_POLICY_SQL,
        args: [
          connectionId,
          groupId,
          JSON.stringify(policy),
          version,
          principalId,
          new Date().toISOString(),
        ],
      });
      return { version };
    });
  }
}
