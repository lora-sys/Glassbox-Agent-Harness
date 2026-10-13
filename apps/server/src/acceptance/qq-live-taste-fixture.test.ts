import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vite-plus/test";
import {
  agentResourceId,
  openDomainStore,
  type DomainStore,
  type TrustedChannelScope,
} from "../persistence/index.js";
import {
  MEMORY_GOVERN_ACTION,
  MEMORY_READ_ACTION,
  MEMORY_WRITE_ACTION,
  OWNER_MEMORY_RESOURCE,
} from "../learning/store.js";

const privateScope: TrustedChannelScope = {
  connectionId: "qq",
  botId: "taste-fixture-bot",
  chatType: "private",
  chatId: "owner",
  senderId: "owner",
};
const stores: DomainStore[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

it("observes the Taste lifecycle written by LearningStore from its persisted SQLite database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-live-taste-store-"));
  directories.push(directory);
  const databasePath = join(directory, "glassbox.db");
  const store = await openDomainStore({ databasePath });
  stores.push(store);

  await store.conversations.createAgent("personal");
  await store.identities.bindOwner("owner", privateScope);
  await store.authorization.registerResource({
    id: OWNER_MEMORY_RESOURCE,
    kind: "owner-memory",
    visibility: "private",
    ownerId: "owner",
  });
  for (const action of [MEMORY_READ_ACTION, MEMORY_WRITE_ACTION, MEMORY_GOVERN_ACTION])
    await store.authorization.grant({
      principalId: "owner",
      resourceId: OWNER_MEMORY_RESOURCE,
      action,
      scope: privateScope,
      effect: "allow",
    });
  await store.authorization.grant({
    principalId: "owner",
    resourceId: agentResourceId("personal"),
    action: "run:create",
    scope: privateScope,
    effect: "allow",
  });

  const nonce = crypto.randomUUID().replaceAll("-", "");
  const projectId = `qqtest-${nonce}`;
  const statement = `qqtest-taste-${nonce}`;
  const run = async (messageId: string) => {
    const accepted = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: privateScope,
      messageId: `${nonce}-${messageId}`,
      text: `Taste fixture ${messageId} ${nonce}`,
      executionRef: "qq-live-taste-fixture-test",
    });
    return {
      runId: accepted.run.id,
      conversationId: accepted.conversation.id,
      context: {
        caller: { principalId: "owner", scope: privateScope },
        runId: accepted.run.id,
        conversationId: accepted.conversation.id,
      },
    };
  };

  const creation = await run("feedback");
  const positive = await store.learning.recordFeedback(creation.context, {
    signalType: "explicit_positive",
    scope: { type: "project", projectId },
    statement,
    conversationId: creation.conversationId,
    runId: creation.runId,
  });
  expect(positive.candidate.candidateKind).toBe("assertion");

  const promotion = await run("promote");
  const memory = await store.learning.promoteCandidate(
    promotion.context,
    positive.candidate.candidateId,
  );

  const negative = await run("negative");
  const correction = await store.learning.recordFeedback(negative.context, {
    signalType: "explicit_negative",
    scope: { type: "project", projectId },
    statement,
    conversationId: negative.conversationId,
    runId: negative.runId,
  });
  expect(correction.candidate.candidateKind).toBe("correction");
  expect((await store.learning.getMemory(creation.context, memory.memoryId))?.lifecycleState).toBe(
    "active",
  );

  const retirement = await run("retire");
  const retired = await store.learning.promoteCandidate(
    retirement.context,
    correction.candidate.candidateId,
  );
  expect(retired.memoryId).toBe(memory.memoryId);
  expect(retired.lifecycleState).toBe("retired");

  const { observeTasteFixture } = await import(
    pathToFileURL(resolve(process.cwd(), "tools/qq-live/lib/taste-fixture.mjs")).href
  );
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    expect(
      observeTasteFixture(db, {
        stage: "retire",
        fixtureNonce: nonce,
        creationRunId: creation.runId,
        promotionRunId: promotion.runId,
        negativeRunId: negative.runId,
        stepRunId: retirement.runId,
        principalId: "owner",
        candidateId: positive.candidate.candidateId,
        memoryId: memory.memoryId,
        correctionCandidateId: correction.candidate.candidateId,
      }),
    ).toMatchObject({
      principalKind: "owner",
      principalId: "owner",
      projectId,
      stepRunId: retirement.runId,
      creationRunId: creation.runId,
      promotionRunId: promotion.runId,
      negativeRunId: negative.runId,
      cleanupRunId: retirement.runId,
      candidateId: positive.candidate.candidateId,
      memoryId: memory.memoryId,
      correctionCandidateId: correction.candidate.candidateId,
      correctionStatus: "promoted",
      lifecycleState: "retired",
      activeCount: 0,
      pendingCount: 0,
    });
  } finally {
    db.close();
  }
});
