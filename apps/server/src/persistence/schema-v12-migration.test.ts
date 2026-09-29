import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { expect, it } from "vite-plus/test";
import { DomainDatabase, localDatabaseUrl } from "./database.js";

it("migrates v11 to constrained message image attachments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-schema-v12-"));
  const path = join(directory, "glassbox.db");
  try {
    const initial = await DomainDatabase.open(path);
    await initial.close();

    const legacy = createClient({ url: localDatabaseUrl(path) });
    await legacy.execute("DROP TABLE message_attachments");
    await legacy.execute("PRAGMA user_version = 11");
    legacy.close();

    const db = await DomainDatabase.open(path);
    try {
      await db.transaction(async (tx) => {
        expect((await tx.execute("PRAGMA user_version")).rows[0]?.user_version).toBe(12);
        await tx.execute("INSERT INTO agents(id, created_at) VALUES ('agent', 'now')");
        await tx.execute(
          "INSERT INTO principals(id, kind, created_at) VALUES ('owner', 'owner', 'now')",
        );
        await tx.execute(
          "INSERT INTO resources(id, kind, visibility, owner_id) VALUES ('conversation:1', 'conversation', 'private', 'owner')",
        );
        await tx.execute(
          "INSERT INTO conversations(id, agent_id, principal_id, scope_key, scope_json, resource_id, created_at) VALUES ('conversation-1', 'agent', 'owner', 'scope', '{}', 'conversation:1', 'now')",
        );
        await tx.execute(
          "INSERT INTO messages(id, conversation_id, scope_key, external_id, text, created_at) VALUES ('message-1', 'conversation-1', 'scope', 'external-1', '', 'now')",
        );
        await tx.execute({
          sql: "INSERT INTO message_attachments(message_id, ordinal, status, mime_type, image_bytes, size_bytes, failure_code) VALUES (?, ?, ?, ?, ?, ?, ?)",
          args: ["message-1", 0, "ready", "image/png", Buffer.from([1, 2, 3]), 3, null],
        });
        await tx.execute({
          sql: "INSERT INTO message_attachments(message_id, ordinal, status, mime_type, image_bytes, size_bytes, failure_code) VALUES (?, ?, ?, ?, ?, ?, ?)",
          args: ["message-1", 1, "failed", null, null, null, "image_invalid"],
        });
        const attachment = (
          await tx.execute(
            "SELECT ordinal, status, mime_type, image_bytes, size_bytes, failure_code FROM message_attachments WHERE message_id = 'message-1' AND ordinal = 0",
          )
        ).rows[0]!;
        expect(attachment).toMatchObject({
          ordinal: 0,
          status: "ready",
          mime_type: "image/png",
          size_bytes: 3,
          failure_code: null,
        });
        expect(Array.from(new Uint8Array(attachment.image_bytes as ArrayBuffer))).toEqual([
          1, 2, 3,
        ]);
        expect(
          (
            await tx.execute(
              "SELECT status, image_bytes, failure_code FROM message_attachments WHERE message_id = 'message-1' AND ordinal = 1",
            )
          ).rows[0],
        ).toMatchObject({ status: "failed", image_bytes: null, failure_code: "image_invalid" });
      });

      const rejectsAttachment = (args: Array<string | number | Buffer | null>) =>
        expect(
          db.transaction((tx) =>
            tx.execute({
              sql: "INSERT INTO message_attachments(message_id, ordinal, status, mime_type, image_bytes, size_bytes, failure_code) VALUES (?, ?, ?, ?, ?, ?, ?)",
              args,
            }),
          ),
        ).rejects.toThrow();

      await rejectsAttachment(["message-1", 0, "ready", "image/jpeg", Buffer.from([4]), 1, null]);
      await rejectsAttachment(["message-1", 2, "ready", "image/gif", Buffer.from([4]), 1, null]);
      await rejectsAttachment(["message-1", -1, "ready", "image/jpeg", Buffer.from([4]), 1, null]);
      await rejectsAttachment([
        "missing-message",
        0,
        "ready",
        "image/jpeg",
        Buffer.from([4]),
        1,
        null,
      ]);
      await rejectsAttachment(["message-1", 2, "ready", "image/jpeg", Buffer.from([4]), 2, null]);
      await rejectsAttachment(["message-1", 2, "ready", "image/webp", Buffer.alloc(0), 1, null]);
      await rejectsAttachment(["message-1", 2, "ready", "image/png", null, null, null]);
      await rejectsAttachment([
        "message-1",
        2,
        "failed",
        null,
        Buffer.from([4]),
        1,
        "image_invalid",
      ]);
      await rejectsAttachment(["message-1", 2, "failed", null, null, null, "provider_error"]);
      await rejectsAttachment([
        "message-1",
        2,
        "ready",
        "image/png",
        Buffer.from([4]),
        1,
        "image_invalid",
      ]);
    } finally {
      await db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
      },
    );
  }
});
