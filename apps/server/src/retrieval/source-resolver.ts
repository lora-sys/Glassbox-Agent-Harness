import type { CallerContext } from "../identity/scope.js";
import { scopeKey } from "../identity/scope.js";
import type { DomainStore } from "../persistence/index.js";
import { stringColumn } from "../persistence/database.js";

/**
 * Derives the canonical resource ID for a QQ group.
 */
export function groupResourceId(groupId: string): string {
  return `group:${groupId}`;
}

/**
 * Resolves the group IDs the caller is *assigned* to as a managed group.
 *
 * Assignment is the `group:manage` grant on a group Resource in the caller's own private
 * scope. It is per Principal: one Owner enabling a group never assigns another Owner, and
 * one Owner revoking never removes another Owner's assignment. It is read back from the
 * grants table rather than from the connection-wide configured list, so a Principal's
 * managed inventory is exactly what that Principal assigned.
 *
 * Assignment is not authority. Reading a group's history still needs its own
 * `history:read` grant; see `resolveAuthorizedHistorySources`.
 */
export async function resolveAssignedGroupIds(
  store: DomainStore,
  caller: CallerContext,
): Promise<string[]> {
  if (caller.scope.chatType !== "private") return [];
  const key = scopeKey(caller.scope);
  return store.db.transaction(async (tx) => {
    const res = await tx.execute({
      sql: `SELECT resource_id FROM grants
            WHERE principal_id = ?
              AND action = 'group:manage'
              AND scope_key = ?
              AND effect = 'allow'
              AND revoked_at IS NULL`,
      args: [caller.principalId, key],
    });
    const groupIds: string[] = [];
    for (const row of res.rows) {
      const resourceId = stringColumn(row, "resource_id");
      if (resourceId.startsWith("group:")) groupIds.push(resourceId.slice(6));
    }
    // Deterministic order: the resolved set is recorded as evidence, so the same grants
    // must always produce the same sequence.
    return groupIds.sort();
  });
}

/**
 * Resolves the list of group IDs where the caller currently has an active `history:read` grant.
 *
 * Security invariants:
 * - Group runs are strictly confined to the current group (`chatId`), and only if granted.
 * - Owner private runs can query across granted groups in the caller's private scope.
 * - Requested group filters are ALWAYS intersected with the granted set before content is loaded.
 * - Unauthorized sources NEVER enter the candidate set.
 */
export async function resolveAuthorizedHistorySources(
  store: DomainStore,
  caller: CallerContext,
  requestedGroupIds?: readonly string[],
): Promise<string[]> {
  const scope = caller.scope;

  if (scope.chatType === "group") {
    // Current group can only ever search itself.
    const currentGroupId = scope.chatId;
    const decision = await store.authorization.check({
      caller,
      resourceId: groupResourceId(currentGroupId),
      action: "history:read",
    });

    if (decision.decision !== "ALLOW") {
      return [];
    }

    if (
      requestedGroupIds &&
      requestedGroupIds.length > 0 &&
      !requestedGroupIds.includes(currentGroupId)
    ) {
      return [];
    }

    return [currentGroupId];
  }

  // Private chat scope: query active history:read grants in this scope
  const key = scopeKey(scope);
  const authorizedGroupIds = await store.db.transaction(async (tx) => {
    const res = await tx.execute({
      sql: `SELECT resource_id FROM grants
            WHERE principal_id = ?
              AND action = 'history:read'
              AND scope_key = ?
              AND effect = 'allow'
              AND revoked_at IS NULL`,
      args: [caller.principalId, key],
    });

    const groupIds: string[] = [];
    for (const row of res.rows) {
      const resourceId = stringColumn(row, "resource_id");
      if (resourceId.startsWith("group:")) {
        groupIds.push(resourceId.slice(6));
      }
    }
    return groupIds.sort();
  });

  if (requestedGroupIds && requestedGroupIds.length > 0) {
    const requestedSet = new Set(requestedGroupIds);
    return authorizedGroupIds.filter((gid) => requestedSet.has(gid));
  }

  return authorizedGroupIds;
}
