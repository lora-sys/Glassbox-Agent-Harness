import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { DomainDatabase, localDatabaseUrl } from "./database.js";
import { openDomainStore } from "./index.js";
import { CURRENT_SCHEMA_VERSION } from "./schema.js";

export const ownerRoutingReopenFixtureScript = new URL(import.meta.url);

async function runFixture() {
  const [path, scenario] = process.argv.slice(2);
  assert.ok(path);
  if (scenario === "upgrade") {
    const initial = await DomainDatabase.open(path);
    await initial.close();
    const legacy = createClient({ url: localDatabaseUrl(path) });
    await legacy.execute("ALTER TABLE runs DROP COLUMN channel_default_execution_ref");
    await legacy.execute("INSERT INTO agents(id, created_at) VALUES ('agent', '2026-09-28')");
    await legacy.execute(
      "INSERT INTO principals(id, kind, created_at) VALUES ('owner', 'owner', '2026-09-28')",
    );
    await legacy.execute(
      "INSERT INTO resources(id, kind, visibility, owner_id) VALUES ('conversation:1', 'conversation', 'private', 'owner')",
    );
    await legacy.execute(
      "INSERT INTO conversations(id, agent_id, principal_id, scope_key, scope_json, resource_id, created_at) VALUES ('conversation-1', 'agent', 'owner', 'scope', '{}', 'conversation:1', '2026-09-28')",
    );
    await legacy.execute(
      "INSERT INTO messages(id, conversation_id, scope_key, external_id, text, created_at) VALUES ('message-1', 'conversation-1', 'scope', 'external-1', 'hello', '2026-09-28')",
    );
    await legacy.execute(
      "INSERT INTO runs(id, conversation_id, message_id, principal_id, scope_json, execution_ref, status, result_text, created_at, updated_at) VALUES ('run-1', 'conversation-1', 'message-1', 'owner', '{}', 'pi:p3-minimax', 'succeeded', 'the real answer', '2026-09-28', '2026-09-28')",
    );
    await legacy.execute("PRAGMA user_version = 28");
    legacy.close();
    const db = await DomainDatabase.open(path);
    try {
      await db.transaction(async (tx) => {
        assert.equal(
          (await tx.execute("PRAGMA user_version")).rows[0]?.user_version,
          CURRENT_SCHEMA_VERSION,
        );
        assert.deepEqual(
          (
            await tx.execute(
              "SELECT channel_default_execution_ref, execution_ref, status, result_text FROM runs WHERE id = 'run-1'",
            )
          ).rows[0],
          {
            channel_default_execution_ref: null,
            execution_ref: "pi:p3-minimax",
            status: "succeeded",
            result_text: "the real answer",
          },
        );
        assert.equal((await tx.execute("PRAGMA integrity_check")).rows[0]?.integrity_check, "ok");
        assert.deepEqual((await tx.execute("PRAGMA foreign_key_check")).rows, []);
      });
    } finally {
      await db.close();
    }
  } else if (scenario === "missing-runs") {
    const client = createClient({ url: localDatabaseUrl(path) });
    try {
      await client.execute("CREATE TABLE sentinel (value TEXT)");
      await client.execute("INSERT INTO sentinel VALUES ('untouched')");
      await client.execute("PRAGMA user_version = 28");
      await assert.rejects(
        DomainDatabase.open(path),
        /Run routing provenance migration requires runs table/u,
      );
      assert.equal((await client.execute("PRAGMA user_version")).rows[0]?.user_version, 28);
      assert.equal(
        (await client.execute("SELECT value FROM sentinel")).rows[0]?.value,
        "untouched",
      );
    } finally {
      client.close();
    }
  } else if (scenario === "reopen") {
    const scope = {
      connectionId: "fixture",
      botId: "bot",
      chatType: "private" as const,
      chatId: "owner",
      senderId: "owner",
    };
    const store = await openDomainStore({ databasePath: path });
    await store.conversations.createAgent("personal");
    await store.identities.bindOwner("owner", scope);
    for (const action of ["run:create", "conversation:read", "run:control"])
      await store.authorization.grant({
        principalId: "owner",
        resourceId: "agent:personal",
        action,
        scope,
        effect: "allow",
      });
    const base = {
      agentId: "personal",
      scope,
      text: "Fixture input",
      executionRef: "pi:preferred",
    };
    const preferred = await store.conversations.acceptIncoming({
      ...base,
      messageId: "preference",
      channelDefaultExecutionRef: "pi:default",
    });
    const explicit = await store.conversations.acceptIncoming({
      ...base,
      messageId: "explicit",
      executionRef: "pi:default",
    });
    await store.close();
    const reopened = await openDomainStore({ databasePath: path });
    try {
      const loaded = await reopened.conversations.loadRunInput(preferred.caller, preferred.run.id);
      assert.equal(loaded.run.executionRef, "pi:preferred");
      assert.equal(loaded.run.channelDefaultExecutionRef, "pi:default");
      assert.equal(loaded.text, "Fixture input");
      const explicitRun = await reopened.conversations.loadRunInput(
        explicit.caller,
        explicit.run.id,
      );
      assert.equal(explicitRun.run.executionRef, "pi:default");
      assert.equal(Object.hasOwn(explicitRun.run, "channelDefaultExecutionRef"), false);
      const duplicate = await reopened.conversations.acceptIncoming({
        ...base,
        messageId: "preference",
        channelDefaultExecutionRef: "pi:untrusted-new-value",
      });
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.run.channelDefaultExecutionRef, "pi:default");
    } finally {
      await reopened.close();
    }
  } else assert.fail(`Unknown fixture scenario: ${scenario}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await runFixture();
