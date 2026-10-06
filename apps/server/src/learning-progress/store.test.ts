import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallerContext, TrustedChannelScope } from "../identity/scope.js";
import { openDomainStore, type DomainStore } from "../application/domain-store.js";
import { conversationScopeKey, scopeKey } from "../identity/scope.js";
import { learningProgressResourceId } from "./policy.js";
import { classifyLearningProgress, repeatedQuestionCue } from "./classifier.js";

const base: TrustedChannelScope = {
  connectionId: "qq-progress",
  botId: "bot-progress",
  chatType: "group",
  chatId: "group-a",
  senderId: "sender-a",
};
const groupCaller: CallerContext = { principalId: "person-a", scope: base };
const privateCaller: CallerContext = {
  principalId: "person-a",
  scope: { ...base, chatType: "private", chatId: "sender-a" },
};
const stores: DomainStore[] = [];
const tempDirectories: string[] = [];

async function fixture(databasePath = ":memory:") {
  const store = await openDomainStore({ databasePath });
  stores.push(store);
  await store.conversations.createAgent("personal");
  await store.identities.createPrincipal("person-a", "visitor");
  await store.identities.createPrincipal("person-b", "visitor");
  for (const caller of [groupCaller, privateCaller]) {
    await store.identities.bindPrincipal(caller.principalId, caller.scope);
    await store.authorization.registerResource({
      id: learningProgressResourceId(caller),
      kind: "learning-progress",
      visibility: "public",
      ownerId: caller.principalId,
      ifAbsent: true,
    });
    for (const action of ["progress:read", "progress:write", "progress:manage", "delivery:send"])
      await store.authorization.grant({
        principalId: caller.principalId,
        resourceId: learningProgressResourceId(caller),
        action,
        scope: caller.scope,
        effect: "allow",
      });
  }
  await store.authorization.registerResource({
    id: "group:group-a",
    kind: "qq_group",
    visibility: "public",
  });
  const sourceGrant = await store.authorization.grant({
    principalId: "person-a",
    resourceId: "group:group-a",
    action: "history:read",
    scope: groupCaller.scope,
    effect: "allow",
  });
  await store.db.transaction((tx) =>
    tx.execute({
      sql: `INSERT INTO group_capability_policies(connection_id,group_id,policy_json,version,updated_by_principal_id,updated_at)
          VALUES (?,?,?,1,?,?)`,
      args: [
        "qq-progress",
        "group-a",
        JSON.stringify({
          categories: { "group.history": true },
          memorySources: { history: true },
          webCapabilities: {},
        }),
        "person-a",
        new Date().toISOString(),
      ],
    }),
  );
  return { store, sourceGrant };
}

let runNumber = 0;
async function persistedRun(store: DomainStore, caller: CallerContext, text: string) {
  const suffix = String(++runNumber);
  const locationKey = conversationScopeKey(caller.scope);
  const conversationId = `progress-conversation-${Buffer.from(locationKey).toString("hex")}`;
  const messageId = `progress-message-${suffix}`;
  const runId = `progress-run-${suffix}`;
  const now = new Date().toISOString();
  const serializedScope = JSON.stringify(caller.scope);
  const resourceId = `conversation:${conversationId}`;
  await store.db.transaction(async (tx) => {
    const prior = await tx.execute({
      sql: "SELECT id FROM conversations WHERE agent_id = 'personal' AND scope_key = ?",
      args: [locationKey],
    });
    if (!prior.rows[0]) {
      await tx.execute({
        sql: "INSERT INTO resources(id,kind,visibility) VALUES (?,'conversation','private')",
        args: [resourceId],
      });
      await tx.execute({
        sql: `INSERT INTO conversations(id,agent_id,principal_id,scope_key,scope_json,resource_id,created_at)
              VALUES (?,'personal',?,?,?,?,?)`,
        args: [conversationId, caller.principalId, locationKey, serializedScope, resourceId, now],
      });
    }
    await tx.execute({
      sql: "INSERT INTO messages(id,conversation_id,scope_key,external_id,text,created_at) VALUES (?,?,?,?,?,?)",
      args: [messageId, conversationId, scopeKey(caller.scope), messageId, text, now],
    });
    await tx.execute({
      sql: `INSERT INTO runs(id,conversation_id,message_id,principal_id,scope_json,execution_ref,status,source,created_at,updated_at)
            VALUES (?,?,?,?,?,?,'queued','external',?,?)`,
      args: [
        runId,
        conversationId,
        messageId,
        caller.principalId,
        serializedScope,
        "test-executor",
        now,
        now,
      ],
    });
  });
  return { runId, conversationId };
}

function context(caller: CallerContext, run?: { runId: string; conversationId: string }) {
  return { caller, ...(run ? { runId: run.runId, conversationId: run.conversationId } : {}) };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const directory of tempDirectories.splice(0)) {
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (error) {
      if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EBUSY")
        throw error;
    }
  }
});

describe("per-person learning progress", () => {
  it("accepts only clear self-authored goals and makes repeated questions weak cues", async () => {
    expect(classifyLearningProgress("I want to learn Rust async")).toMatchObject({
      kind: "goal",
      statement: "Rust async",
      confidence: 0.85,
    });
    expect(classifyLearningProgress("我想学 Rust 异步")).toMatchObject({
      kind: "goal",
      statement: "Rust 异步",
    });
    expect(classifyLearningProgress("我需要学 TypeScript")).toMatchObject({
      kind: "goal",
      statement: "TypeScript",
    });
    expect(classifyLearningProgress("朋友说我想学 Rust")).toBeNull();
    expect(classifyLearningProgress("> I want to learn Rust async")).toBeNull();
    expect(classifyLearningProgress("I want to learn `Rust async`")).toBeNull();
    expect(classifyLearningProgress("I want to learn from https://example.com")).toBeNull();
    expect(classifyLearningProgress("my friend wants to learn Rust")).toBeNull();
    expect(classifyLearningProgress("I want to remember api_key=secret-value")).toBeNull();
    expect(repeatedQuestionCue("How do I compile Rust? ")).toBe("compile Rust");

    const { store } = await fixture();
    const firstRun = await persistedRun(store, groupCaller, "How do I compile Rust?");
    expect(await store.progress.captureCurrentRun(context(groupCaller, firstRun))).toBeNull();
    // Retrying the same Run is idempotent and cannot count as another question.
    expect(await store.progress.captureCurrentRun(context(groupCaller, firstRun))).toBeNull();
    const secondRun = await persistedRun(store, groupCaller, "How do I compile Rust?");
    const cue = await store.progress.captureCurrentRun(context(groupCaller, secondRun));
    expect(cue).toMatchObject({ kind: "question_cue", confidence: 0.25, state: "observed" });
    expect(await store.progress.list(context(groupCaller))).toContainEqual(
      expect.objectContaining({ id: cue!.id }),
    );

    const rememberRun = await persistedRun(store, groupCaller, "/progress remember Rust 并发");
    expect(
      await store.progress.executeCommandFromCurrentRun(context(groupCaller, rememberRun)),
    ).toMatchObject({
      action: "capture",
      record: { kind: "goal", state: "observed", statement: "Rust 并发" },
    });
  });

  it("rechecks exact source grants and confines group progress to its sender and group", async () => {
    const { store, sourceGrant } = await fixture();
    const origin = await persistedRun(store, groupCaller, "I want to learn TypeScript inference");
    const record = await store.progress.captureCurrentRun(context(groupCaller, origin));
    expect(record).toMatchObject({
      source: { chatType: "group", chatId: "group-a", senderId: "sender-a" },
    });
    const privateRecords = await store.progress.list(context(privateCaller));
    expect(privateRecords.map((item) => item.id)).toContain(record!.id);

    const otherGroup: CallerContext = { ...groupCaller, scope: { ...base, chatId: "group-b" } };
    await store.identities.bindPrincipal("person-a", otherGroup.scope);
    await store.authorization.grant({
      principalId: "person-a",
      resourceId: learningProgressResourceId(otherGroup),
      action: "progress:read",
      scope: otherGroup.scope,
      effect: "allow",
    });
    await expect(store.progress.list(context(otherGroup))).resolves.toEqual([]);

    const oldContext = context(privateCaller);
    await store.progress.authorizeContext(oldContext, privateRecords);
    await store.authorization.revoke(sourceGrant);
    await expect(store.progress.authorizeContext(oldContext, privateRecords)).rejects.toMatchObject(
      { decision: { decision: "DENY" } },
    );

    await store.identities.bindPrincipal("person-b", base);
    const remapped: CallerContext = { principalId: "person-b", scope: base };
    await store.authorization.registerResource({
      id: learningProgressResourceId(remapped),
      kind: "learning-progress",
      visibility: "public",
      ownerId: remapped.principalId,
      ifAbsent: true,
    });
    await store.authorization.grant({
      principalId: remapped.principalId,
      resourceId: learningProgressResourceId(remapped),
      action: "progress:read",
      scope: remapped.scope,
      effect: "allow",
    });
    await expect(store.progress.list(context(groupCaller))).rejects.toMatchObject({
      decision: { reason: "identity_mismatch" },
    });
    expect(await store.progress.list(context(remapped))).toEqual([]);
  });

  it("corrects, confirms, and deletes only from deterministic persisted commands", async () => {
    const { store } = await fixture();
    const origin = await persistedRun(store, groupCaller, "I am learning Rust async");
    const record = await store.progress.captureCurrentRun(context(groupCaller, origin));
    const stale = await store.progress.list(context(groupCaller));
    const correctedRun = await persistedRun(
      store,
      groupCaller,
      `/progress correct ${record!.id} | I am learning Rust concurrency`,
    );
    const corrected = await store.progress.executeCommandFromCurrentRun(
      context(groupCaller, correctedRun),
    );
    expect(corrected).toMatchObject({ action: "correct" });
    expect(await store.progress.list(context(groupCaller))).toContainEqual(
      expect.objectContaining({
        id: record!.id,
        statement: "I am learning Rust concurrency",
        state: "observed",
      }),
    );
    await expect(
      store.progress.authorizeContext(context(groupCaller), stale),
    ).rejects.toMatchObject({ decision: { decision: "DENY" } });

    const confirmedRun = await persistedRun(store, groupCaller, `/progress confirm ${record!.id}`);
    expect(
      await store.progress.executeCommandFromCurrentRun(context(groupCaller, confirmedRun)),
    ).toMatchObject({ action: "confirm" });
    const confirmed = await store.progress.list(context(groupCaller));
    expect(confirmed).toContainEqual(
      expect.objectContaining({ id: record!.id, state: "confirmed" }),
    );
    const deletedRun = await persistedRun(store, groupCaller, `/progress delete ${record!.id}`);
    expect(
      await store.progress.executeCommandFromCurrentRun(context(groupCaller, deletedRun)),
    ).toMatchObject({ action: "delete" });
    expect(await store.progress.list(context(groupCaller))).toEqual([]);
    await expect(
      store.progress.authorizeContext(context(groupCaller), confirmed),
    ).rejects.toMatchObject({ decision: { decision: "DENY" } });
  });

  it("keeps sender records separate and denies an unbound identity", async () => {
    const { store } = await fixture();
    const origin = await persistedRun(store, groupCaller, "I want to learn TypeScript inference");
    expect(await store.progress.captureCurrentRun(context(groupCaller, origin))).toBeTruthy();

    const other: CallerContext = {
      principalId: "person-b",
      scope: { ...base, senderId: "sender-b" },
    };
    await store.identities.bindPrincipal(other.principalId, other.scope);
    await store.authorization.registerResource({
      id: learningProgressResourceId(other),
      kind: "learning-progress",
      visibility: "public",
      ownerId: other.principalId,
    });
    for (const action of ["progress:read", "delivery:send"])
      await store.authorization.grant({
        principalId: other.principalId,
        resourceId: learningProgressResourceId(other),
        action,
        scope: other.scope,
        effect: "allow",
      });
    expect(await store.progress.list(context(other))).toEqual([]);

    await store.identities.unbind({
      connectionId: base.connectionId,
      botId: base.botId,
      senderId: base.senderId,
    });
    await expect(store.progress.list(context(groupCaller))).rejects.toMatchObject({
      decision: { reason: "identity_unbound" },
    });
  });

  it("keeps deletion durable across database reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "glassbox-learning-progress-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "progress.db");
    const { store } = await fixture(databasePath);
    const origin = await persistedRun(store, groupCaller, "I want to learn Rust async");
    const record = await store.progress.captureCurrentRun(context(groupCaller, origin));
    const deleteRun = await persistedRun(store, groupCaller, `/progress delete ${record!.id}`);
    await store.progress.executeCommandFromCurrentRun(context(groupCaller, deleteRun));
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = await openDomainStore({ databasePath });
    stores.push(reopened);
    expect(await reopened.progress.list(context(groupCaller))).toEqual([]);
    const persisted = await reopened.db.transaction((tx) =>
      tx.execute({
        sql: "SELECT state,statement FROM learning_progress_records WHERE id = ?",
        args: [record!.id],
      }),
    );
    expect(persisted.rows[0]).toMatchObject({ state: "deleted", statement: "" });
  });
});
