import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type Client, type Transaction, type Row } from "@libsql/client";
import {
  schema,
  schemaV2Migration,
  schemaV3Migration,
  applySchemaV4Migration,
  schemaV5Migration,
  schemaV6Migration,
  schemaV7Migration,
  schemaV8Migration,
  schemaV9Migration,
  schemaV10Migration,
  schemaV11Migration,
  schemaV12Migration,
  schemaV13Migration,
  applySchemaV14Migration,
  applySchemaV15Migration,
  CURRENT_SCHEMA_VERSION,
  applySchemaV16Migration,
  applySchemaV17Migration,
  applySchemaV18Migration,
  schemaV19Migration,
  schemaV20Migration,
  schemaV21Migration,
  applySchemaV22Migration,
  schemaV23Migration,
  applySchemaV24Migration,
  schemaV25Migration,
  applySchemaV26Migration,
  applySchemaV27Migration,
  applySchemaV28Migration,
} from "./schema.js";

export function localDatabaseUrl(databasePath: string): string {
  if (databasePath === ":memory:") return "file::memory:";
  if (
    !databasePath ||
    /^(?:[a-z][a-z\d+.-]*:)/iu.test(databasePath.replace(/^[a-z]:[\\/]/iu, "")) ||
    /^(?:\\\\|\/\/)/u.test(databasePath)
  ) {
    throw new Error("An explicit local database path is required");
  }
  return pathToFileURL(resolve(databasePath)).href;
}

export function stringColumn(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error("Invalid persisted record");
  return value;
}

export function optionalString(row: Row, key: string): string | null {
  return row[key] === null ? null : stringColumn(row, key);
}

/** Internal driver. Services serialize operations so overlapping local transactions
 * cannot share uncommitted state. This is not a SQL interface for adapters or models. */
export class DomainDatabase {
  private tail: Promise<unknown> = Promise.resolve();
  private closing = false;

  private constructor(private readonly client: Client) {}

  static async open(databasePath: string): Promise<DomainDatabase> {
    const url = localDatabaseUrl(databasePath);
    if (databasePath !== ":memory:")
      await mkdir(dirname(resolve(databasePath)), { recursive: true });
    const client = createClient({ url });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await client.execute("PRAGMA busy_timeout = 5000");
      const db = new DomainDatabase(client);
      await db.transaction(async (tx) => {
        const version = Number(
          (await tx.execute("PRAGMA user_version")).rows[0]?.user_version ?? 0,
        );
        if (version > CURRENT_SCHEMA_VERSION)
          throw new Error("Unsupported database schema version");
        if (version === 0) {
          await tx.batch(schema);
          // V24 is a guarded function rather than a statement batch, so it is the one rung the
          // `schema` array cannot carry. Running it here is what keeps a fresh installation at
          // the same shape an upgraded one reaches — the `task_child_links` notification policy,
          // the `task_notifications` routing parent and the wider immutable-payload trigger
          // included.
          await applySchemaV24Migration(tx);
          await applySchemaV26Migration(tx);
          await applySchemaV27Migration(tx);
          await applySchemaV28Migration(tx);
          await tx.execute(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
        } else {
          if (version < 2) {
            await tx.batch(schemaV2Migration);
          }
          if (version < 3) {
            await tx.batch(schemaV3Migration);
          }
          if (version < 4) {
            await applySchemaV4Migration(tx);
          }
          if (version < 5) await tx.batch(schemaV5Migration);
          if (version < 6) await tx.batch(schemaV6Migration);
          if (version < 7) await tx.batch(schemaV7Migration);
          if (version < 8) await tx.batch(schemaV8Migration);
          if (version < 9) await tx.batch(schemaV9Migration);
          if (version < 10) await tx.batch(schemaV10Migration);
          if (version < 11) await tx.batch(schemaV11Migration);
          if (version < 12) await tx.batch(schemaV12Migration);
          if (version < 13) await tx.batch(schemaV13Migration);
          if (version < 14) await applySchemaV14Migration(tx);
          if (version < 15) await applySchemaV15Migration(tx);
          if (version < 16) await applySchemaV16Migration(tx);
          if (version < 17) await applySchemaV17Migration(tx);
          if (version < 18) await applySchemaV18Migration(tx);
          if (version < 19) await tx.batch(schemaV19Migration);
          if (version < 20) await tx.batch(schemaV20Migration);
          if (version < 21) await tx.batch(schemaV21Migration);
          if (version < 22) await applySchemaV22Migration(tx);
          if (version < 23) await tx.batch(schemaV23Migration);
          if (version < 24) await applySchemaV24Migration(tx);
          if (version < 25) await tx.batch(schemaV25Migration);
          if (version < 26) await applySchemaV26Migration(tx);
          if (version < 27) await applySchemaV27Migration(tx);
          if (version < 28) await applySchemaV28Migration(tx);
          await tx.execute(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
        }
      });
      return db;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  transaction<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("Database is closed"));
    const task = this.tail.then(async () => {
      const tx = await this.client.transaction("write");
      try {
        const result = await operation(tx);
        await tx.commit();
        return result;
      } catch (error) {
        if (!tx.closed) await tx.rollback();
        throw error;
      } finally {
        tx.close();
      }
    });
    this.tail = task.catch(() => undefined);
    return task;
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.tail;
    this.client.close();
  }
}
