import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { expect, it } from "vite-plus/test";
import { DomainDatabase, localDatabaseUrl } from "./database.js";
import { baseSchema, learningSchema, schemaV7Statements, schemaV8Migration } from "./schema.js";

it("migrates a P3 Task to durable-capable schema without changing its identity or attempt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-long-work-v11-"));
  const path = join(directory, "glassbox.db");
  try {
    const legacy = createClient({ url: localDatabaseUrl(path) });
    await legacy.execute("PRAGMA foreign_keys = ON");
    await legacy.batch([
      ...baseSchema,
      ...schemaV7Statements,
      ...schemaV8Migration,
      ...learningSchema,
    ]);
    await legacy.execute(
      "INSERT INTO principals(id,kind,created_at) VALUES ('owner','owner','2026-09-27T00:00:00Z')",
    );
    await legacy.execute(
      "INSERT INTO tasks(id,title,status,priority,creator_principal_id,created_at,updated_at) VALUES ('task-1','old work','REVIEW','normal','owner','2026-09-27T00:00:00Z','2026-09-27T00:00:00Z')",
    );
    await legacy.execute(
      "INSERT INTO task_attempts(id,task_id,attempt_number,status,started_at) VALUES ('attempt-1','task-1',1,'review','2026-09-27T00:00:00Z')",
    );
    await legacy.execute("PRAGMA user_version = 11");
    legacy.close();

    const db = await DomainDatabase.open(path);
    try {
      await db.transaction(async (tx) => {
        expect((await tx.execute("PRAGMA user_version")).rows[0]?.user_version).toBe(13);
        expect((await tx.execute("SELECT source FROM runs")).rows).toEqual([]);
        expect(
          (
            await tx.execute(
              "SELECT id,status,orchestration_mode,policy_revision,active_step_ids_json FROM tasks WHERE id = 'task-1'",
            )
          ).rows[0],
        ).toMatchObject({
          id: "task-1",
          status: "REVIEW",
          orchestration_mode: "legacy",
          policy_revision: 1,
          active_step_ids_json: "[]",
        });
        expect(
          (await tx.execute("SELECT id,step_id FROM task_attempts WHERE id = 'attempt-1'")).rows[0],
        ).toMatchObject({
          id: "attempt-1",
          step_id: null,
        });
        await tx.execute(
          "INSERT INTO task_steps(id,task_id,kind,title,status,dependency_policy_json,max_attempts,required_capabilities_json,delegated_permissions_json,version,created_at,updated_at) VALUES ('step-1','task-1','join','Join','pending','{}',1,'[]','[]',1,'2026-09-27T00:00:00Z','2026-09-27T00:00:00Z')",
        );
        await tx.execute(
          "INSERT INTO task_events(id,task_id,step_id,type,metadata_json,created_at) VALUES ('event-1','task-1','step-1','STEP_ADDED','{}','2026-09-27T00:00:00Z')",
        );
        await expect(
          tx.execute("UPDATE task_events SET type = 'TASK_ACCEPTED' WHERE id = 'event-1'"),
        ).rejects.toThrow();
        await tx.execute(
          "INSERT INTO task_step_leases(id,task_id,step_id,owner_instance_id,state,version,acquired_at,heartbeat_at,expires_at) VALUES ('lease-1','task-1','step-1','instance-1','active',1,'2026-09-27T00:00:00Z','2026-09-27T00:00:00Z','2026-09-27T00:01:00Z')",
        );
        await expect(
          tx.execute(
            "INSERT INTO task_step_leases(id,task_id,step_id,owner_instance_id,state,version,acquired_at,heartbeat_at,expires_at) VALUES ('lease-2','task-1','step-1','instance-2','active',1,'2026-09-27T00:00:00Z','2026-09-27T00:00:00Z','2026-09-27T00:01:00Z')",
          ),
        ).rejects.toThrow();
      });
    } finally {
      await db.close();
    }
    const reopened = await DomainDatabase.open(path);
    try {
      await reopened.transaction(async (tx) => {
        expect(
          (await tx.execute("SELECT id FROM task_attempts WHERE task_id = 'task-1'")).rows[0]?.id,
        ).toBe("attempt-1");
        expect(
          (await tx.execute("SELECT COUNT(*) AS count FROM task_events WHERE task_id = 'task-1'"))
            .rows[0]?.count,
        ).toBe(1);
      });
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
      },
    );
  }
});
