import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  agentResourceId,
  openDomainStore,
  type TrustedChannelScope,
} from "../persistence/index.js";
import {
  MEMORY_GOVERN_ACTION,
  MEMORY_READ_ACTION,
  MEMORY_WRITE_ACTION,
  OWNER_MEMORY_RESOURCE,
} from "../learning/store.js";

export const qqLiveTasteFixtureScript = new URL(import.meta.url);

const privateScope: TrustedChannelScope = {
  connectionId: "qq",
  botId: "taste-fixture-bot",
  chatType: "private",
  chatId: "owner",
  senderId: "owner",
};

async function runFixture() {
  const databasePath = process.argv[2];
  assert.ok(databasePath);
  const store = await openDomainStore({ databasePath });
  try {
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

    const nonce = randomUUID().replaceAll("-", "");
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
    assert.equal(positive.candidate.candidateKind, "assertion");

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
    assert.equal(correction.candidate.candidateKind, "correction");
    assert.equal(
      (await store.learning.getMemory(creation.context, memory.memoryId))?.lifecycleState,
      "active",
    );

    const retirement = await run("retire");
    const retired = await store.learning.promoteCandidate(
      retirement.context,
      correction.candidate.candidateId,
    );
    assert.equal(retired.memoryId, memory.memoryId);
    assert.equal(retired.lifecycleState, "retired");

    const { observeTasteFixture } = await import(
      pathToFileURL(resolve(process.cwd(), "tools/qq-live/lib/taste-fixture.mjs")).href
    );
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.partialDeepStrictEqual(
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
        {
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
        },
      );
    } finally {
      db.close();
    }
  } finally {
    await store.close();
  }
  console.log(JSON.stringify({ completed: true }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await runFixture();
