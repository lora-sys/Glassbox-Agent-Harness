import type { Transaction } from "@libsql/client";
import { DomainDatabase, stringColumn } from "../persistence/database.js";
import {
  identityKey,
  requireIdentifier,
  validateScope,
  type TrustedChannelScope,
  type CallerContext,
} from "./scope.js";

export async function resolveIdentity(
  tx: Transaction,
  scope: TrustedChannelScope,
): Promise<string | null> {
  validateScope(scope);
  const result = await tx.execute({
    sql: "SELECT principal_id FROM channel_identities WHERE identity_key = ?",
    args: [identityKey(scope)],
  });
  return result.rows[0] ? stringColumn(result.rows[0], "principal_id") : null;
}

export class IdentityService {
  constructor(private readonly db: DomainDatabase) {}

  async isOwner(principalId: string): Promise<boolean> {
    requireIdentifier(principalId);
    return this.db.transaction(async (tx) => {
      const result = await tx.execute({
        sql: "SELECT 1 FROM principals WHERE id = ? AND kind = 'owner'",
        args: [principalId],
      });
      return result.rows.length === 1;
    });
  }

  /** Management-only operations. The HTTP boundary must authenticate management
   * before exposing these methods; incoming channel text must never reach them. */
  async createPrincipal(id: string, kind: "owner" | "visitor"): Promise<void> {
    requireIdentifier(id);
    if (kind !== "owner" && kind !== "visitor") throw new Error("Invalid principal kind");
    await this.db.transaction(async (tx) => {
      await tx.execute({
        sql: "INSERT INTO principals(id, kind, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING",
        args: [id, kind, new Date().toISOString()],
      });
      const stored = await tx.execute({
        sql: "SELECT kind FROM principals WHERE id = ?",
        args: [id],
      });
      if (!stored.rows[0] || stringColumn(stored.rows[0], "kind") !== kind)
        throw new Error("Principal kind mismatch");
    });
  }

  async bindPrincipal(
    principalId: string,
    identity: Pick<TrustedChannelScope, "connectionId" | "botId" | "senderId">,
  ): Promise<void> {
    requireIdentifier(principalId);
    await this.db.transaction(async (tx) => {
      await tx.execute({
        sql: "INSERT INTO channel_identities(identity_key, principal_id, created_at) VALUES (?, ?, ?) ON CONFLICT(identity_key) DO UPDATE SET principal_id = excluded.principal_id",
        args: [identityKey(identity), principalId, new Date().toISOString()],
      });
    });
  }

  async bindOwner(
    principalId: string,
    identity: Pick<TrustedChannelScope, "connectionId" | "botId" | "senderId">,
  ): Promise<void> {
    requireIdentifier(principalId);
    await this.db.transaction(async (tx) => {
      const existing = await tx.execute({
        sql: "SELECT kind FROM principals WHERE id = ?",
        args: [principalId],
      });
      if (existing.rows[0] && stringColumn(existing.rows[0], "kind") !== "owner")
        throw new Error("Principal is not an Owner");
      await tx.execute({
        sql: "INSERT INTO principals(id, kind, created_at) VALUES (?, 'owner', ?) ON CONFLICT(id) DO NOTHING",
        args: [principalId, new Date().toISOString()],
      });
      await tx.execute({
        sql: "INSERT INTO channel_identities(identity_key, principal_id, created_at) VALUES (?, ?, ?) ON CONFLICT(identity_key) DO UPDATE SET principal_id = excluded.principal_id",
        args: [identityKey(identity), principalId, new Date().toISOString()],
      });
    });
  }

  async unbind(
    identity: Pick<TrustedChannelScope, "connectionId" | "botId" | "senderId">,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute({
        sql: "DELETE FROM channel_identities WHERE identity_key = ?",
        args: [identityKey(identity)],
      });
    });
  }

  async resolve(scope: TrustedChannelScope): Promise<CallerContext | null> {
    return this.db.transaction(async (tx) => {
      const principalId = await resolveIdentity(tx, scope);
      return principalId === null ? null : { principalId, scope: { ...scope } };
    });
  }
}
