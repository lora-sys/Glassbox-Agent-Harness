import { expect, it } from "vite-plus/test";
import {
  MEMORY_GOVERN_ACTION,
  MEMORY_READ_ACTION,
  MEMORY_WRITE_ACTION,
  OWNER_MEMORY_RESOURCE,
} from "../../learning/store.js";
import { openDomainStore } from "../../persistence/index.js";
import { ChannelArchiveStore } from "../../retrieval/channel-archive.js";
import { groupResourceId } from "../../retrieval/source-resolver.js";
import { createOwnerMemoryTools, OWNER_MEMORY_ADMIN_TOOL } from "./owner-memory-tools.js";

it("reviews multiple pending candidates from one exact Owner-private command", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  const caller = {
    principalId: "owner",
    scope: {
      connectionId: "qq",
      botId: "bot",
      chatType: "private" as const,
      chatId: "owner",
      senderId: "owner",
    },
  };
  try {
    await store.identities.bindOwner("owner", caller.scope);
    await store.conversations.createAgent("personal");
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "agent:personal",
      action: "run:create",
      scope: caller.scope,
      effect: "allow",
    });
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
        scope: caller.scope,
        effect: "allow",
      });
    const initial = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: caller.scope,
      messageId: "batch-start",
      text: "开始候选审核",
      executionRef: "pi:test",
    });
    const create = async (statement: string, sourceRunId = initial.run.id) =>
      store.learning.createCandidate(
        { caller, conversationId: initial.conversation.id, runId: sourceRunId },
        {
          candidateKind: "assertion",
          subject: { kind: "user", id: "owner" },
          scope: { type: "global" },
          proposedType: "semantic_fact",
          statement,
          content: { statement },
          source: { kind: "system", ref: `run:${sourceRunId}` },
          sourceEvidence: [],
          confidence: 0.9,
          mergeHint: { strategy: "manual_review_required" },
          extensions: {},
        },
      );
    const promoteIds = [(await create("Fact A")).candidateId, (await create("Fact B")).candidateId];
    const rejectIds = [(await create("Fact C")).candidateId, (await create("Fact D")).candidateId];
    let currentRunId = initial.run.id;
    const [tool] = createOwnerMemoryTools({
      store,
      getContext: () => ({
        caller,
        runId: currentRunId,
        conversationId: initial.conversation.id,
      }),
    });
    const promoteRun = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: caller.scope,
      messageId: "batch-promote",
      text: `/memory promote ${promoteIds.join(" ")}`,
      executionRef: "pi:test",
    });
    currentRunId = promoteRun.run.id;
    const promoted = await tool!.execute(
      "batch-promote",
      { action: "promote", candidateIds: promoteIds },
      undefined,
      undefined,
      {} as never,
    );
    expect(promoted.details).toMatchObject({
      results: promoteIds.map((candidateId) => ({ candidateId, status: "promoted" })),
    });

    const rejectRun = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: caller.scope,
      messageId: "batch-reject",
      text: `/memory reject ${rejectIds.join(" ")}`,
      executionRef: "pi:test",
    });
    currentRunId = rejectRun.run.id;
    const rejected = await tool!.execute(
      "batch-reject",
      { action: "reject", candidateIds: rejectIds },
      undefined,
      undefined,
      {} as never,
    );
    expect(rejected.details).toMatchObject({
      results: rejectIds.map((candidateId) => ({ candidateId, status: "rejected" })),
    });
    expect(await store.learning.listMemories({ caller })).toHaveLength(2);

    const latestIds = [(await create("Fact E")).candidateId, (await create("Fact F")).candidateId];
    const prose = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: caller.scope,
      messageId: "ok-prose",
      text: "这两条都可以",
      executionRef: "pi:test",
    });
    currentRunId = prose.run.id;
    await expect(
      tool!.execute("ok-prose", { action: "confirm" }, undefined, undefined, {} as never),
    ).rejects.toThrow("owner_confirmation_required");
    const confirmation = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: caller.scope,
      messageId: "ok-command",
      text: "/memory ok",
      executionRef: "pi:test",
    });
    currentRunId = confirmation.run.id;
    const confirmed = await tool!.execute(
      "ok-command",
      { action: "confirm" },
      undefined,
      undefined,
      {} as never,
    );
    const confirmedResults = (
      confirmed.details as { results: Array<{ candidateId: string; status: string }> }
    ).results;
    expect(confirmedResults.map((result) => result.candidateId).sort()).toEqual(latestIds.sort());
    expect(confirmedResults.every((result) => result.status === "promoted")).toBe(true);
    const lastId = (await create("Fact G")).candidateId;
    const last = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: caller.scope,
      messageId: "last-command",
      text: "/memory promote last",
      executionRef: "pi:test",
    });
    currentRunId = last.run.id;
    const promotedLast = await tool!.execute(
      "last-command",
      { action: "promote", id: "last" },
      undefined,
      undefined,
      {} as never,
    );
    expect(promotedLast.details).toMatchObject({ lifecycleState: "active" });
    expect((await store.learning.getCandidate({ caller }, lastId))?.status).toBe("promoted");
    const sameRun = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: caller.scope,
      messageId: "same-run-command",
      text: "/memory ok",
      executionRef: "pi:test",
    });
    currentRunId = sameRun.run.id;
    const currentCandidate = await create("Fact H", currentRunId);
    await expect(
      tool!.execute("same-run-command", { action: "confirm" }, undefined, undefined, {} as never),
    ).rejects.toThrow("no_pending_conversation_candidates");
    expect(
      (await store.learning.getCandidate({ caller }, currentCandidate.candidateId))?.status,
    ).toBe("pending");
  } finally {
    await store.close();
  }
});

it("exposes Owner-only governed Memory operations and rechecks revoked write authority", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  const caller = {
    principalId: "owner",
    scope: {
      connectionId: "qq",
      botId: "bot",
      chatType: "private" as const,
      chatId: "owner",
      senderId: "owner",
    },
  };
  try {
    await store.identities.bindOwner("owner", caller.scope);
    await store.conversations.createAgent("personal");
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "agent:personal",
      action: "run:create",
      scope: caller.scope,
      effect: "allow",
    });
    const accepted = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: caller.scope,
      messageId: "message",
      text: "记住这个项目事实",
      executionRef: "pi:test",
    });
    await store.authorization.registerResource({
      id: OWNER_MEMORY_RESOURCE,
      kind: "owner-memory",
      visibility: "private",
      ownerId: "owner",
    });
    let writeGrant = "";
    let governGrant = "";
    for (const action of [MEMORY_READ_ACTION, MEMORY_WRITE_ACTION, MEMORY_GOVERN_ACTION]) {
      const grantId = await store.authorization.grant({
        principalId: "owner",
        resourceId: OWNER_MEMORY_RESOURCE,
        action,
        scope: caller.scope,
        effect: "allow",
      });
      if (action === MEMORY_WRITE_ACTION) writeGrant = grantId;
      if (action === MEMORY_GOVERN_ACTION) governGrant = grantId;
    }
    let currentRunId = accepted.run.id;
    let requiredToolInput: Record<string, unknown> | undefined;
    const [tool] = createOwnerMemoryTools({
      store,
      getContext: () => ({
        caller,
        runId: currentRunId,
        conversationId: accepted.conversation.id,
        ...(requiredToolInput
          ? { requiredToolName: OWNER_MEMORY_ADMIN_TOOL, requiredToolInput }
          : {}),
      }),
    });
    expect(tool?.name).toBe(OWNER_MEMORY_ADMIN_TOOL);
    expect(tool?.parameters).toMatchObject({ type: "object", required: ["action"] });
    const proposed = await tool!.execute(
      "write",
      {
        action: "write",
        type: "semantic_fact",
        statement: "The deployment target is Linux.",
        scopeType: "project",
        projectId: "glassbox",
      },
      undefined,
      undefined,
      {} as never,
    );
    expect(proposed.details).toMatchObject({
      proposedType: "semantic_fact",
      status: "pending",
      scope: { type: "project", projectId: "glassbox" },
    });
    expect(proposed.details).not.toHaveProperty("source");
    expect(proposed.details).toMatchObject({
      sourceEvidence: [{ kind: "system_inference", trustLevel: "low" }],
    });
    expect(proposed.details).not.toHaveProperty("sourceEvidence.0.evidenceId");
    expect(proposed.details).not.toHaveProperty("sourceEvidence.0.ref");
    expect(await store.learning.listMemories({ caller })).toHaveLength(0);
    const candidateId = (proposed.details as { candidateId: string }).candidateId;
    expect(candidateId).toMatch(/^candidate_[0-9a-f]{32}$/u);
    expect(proposed.details).toHaveProperty(
      "confirmationCommand",
      `/memory promote ${candidateId}`,
    );
    const confirmation = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: caller.scope,
      messageId: "confirmation",
      text: `/memory promote ${candidateId}`,
      executionRef: "pi:test",
    });
    currentRunId = confirmation.run.id;
    const promoted = await tool!.execute(
      "promote",
      { action: "promote", id: candidateId },
      undefined,
      undefined,
      {} as never,
    );
    expect(promoted.details).toMatchObject({ lifecycleState: "active" });
    const memoryId = (promoted.details as { memoryId: string }).memoryId;
    expect(memoryId).toMatch(/^memory_[0-9a-f]{32}$/u);
    expect(promoted.details).not.toHaveProperty("evidence");
    expect(promoted.details).not.toHaveProperty("evidenceRefs");
    expect(promoted.details).not.toHaveProperty("assertedBy");
    const correctedStatement = "The Owner said the deployment target is “Linux production”.";
    const update = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: caller.scope,
      messageId: "update-with-typographic-quotes",
      text: `/memory update ${memoryId} ${correctedStatement}`,
      executionRef: "pi:test",
    });
    currentRunId = update.run.id;
    requiredToolInput = { action: "update", id: memoryId, statement: correctedStatement };
    await expect(
      tool!.execute(
        "wrong-action",
        { action: "revoke", id: memoryId },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("mutation_not_requested");
    const updated = await tool!.execute(
      "normalized-provider-input",
      {
        action: "update",
        id: memoryId,
        statement: 'The Owner said the deployment target is "Linux production".',
      },
      undefined,
      undefined,
      {} as never,
    );
    expect(updated.details).toMatchObject({
      content: { statement: correctedStatement },
      lifecycleState: "active",
    });
    requiredToolInput = undefined;
    const repeatedPromotion = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: caller.scope,
      messageId: "repeated-promotion",
      text: `/memory promote ${candidateId}`,
      executionRef: "pi:test",
    });
    currentRunId = repeatedPromotion.run.id;
    const notPromotedAgain = await tool!.execute(
      "repeated-promotion",
      { action: "promote", id: candidateId },
      undefined,
      undefined,
      {} as never,
    );
    expect(notPromotedAgain.details).toEqual({
      executed: false,
      reason: "candidate_not_pending",
      candidateId,
      status: "promoted",
    });
    const proposedReplacement = await tool!.execute(
      "model-supersede",
      {
        action: "supersede",
        id: memoryId,
        statement: "A corrected target.",
      },
      undefined,
      undefined,
      {} as never,
    );
    expect(proposedReplacement.details).toMatchObject({
      status: "pending",
      scope: { type: "project", projectId: "glassbox" },
      mergeHint: { ifMatchMemoryId: memoryId },
    });
    // The refusal is the point, not the fact of one: the model has to be able to tell a promotion
    // the Owner's own message did not authorize from a Tool that broke, or it reports the second
    // and the Owner's instruction silently never lands.
    await expect(
      tool!.execute(
        "unconfirmed-promotion",
        {
          action: "promote",
          id: (proposedReplacement.details as { candidateId: string }).candidateId,
        },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("owner_confirmation_required");
    expect((await store.learning.getMemory({ caller }, memoryId))?.lifecycleState).toBe("active");
    await expect(
      tool!.execute(
        "cross-scope",
        {
          action: "supersede",
          id: memoryId,
          type: "semantic_fact",
          statement: "Wrong scope",
          scopeType: "global",
        },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("memory_scope_mismatch");
    const listed = await tool!.execute(
      "list",
      { action: "list", scopeType: "project", projectId: "glassbox" },
      undefined,
      undefined,
      {} as never,
    );
    expect(listed.details).toHaveLength(1);
    const all = await tool!.execute("all", { action: "list" }, undefined, undefined, {} as never);
    expect(all.details).toHaveLength(1);

    const feedbackRun = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: caller.scope,
      messageId: "feedback",
      text: "/memory feedback project:glassbox edit Prefer named exports.",
      executionRef: "pi:test",
    });
    currentRunId = feedbackRun.run.id;
    const feedback = await tool!.execute(
      "feedback",
      {
        action: "feedback",
        signalType: "edit",
        scopeType: "project",
        projectId: "glassbox",
        statement: "Prefer named exports.",
      },
      undefined,
      undefined,
      {} as never,
    );
    expect(feedback.details).toMatchObject({ candidate: { status: "pending" } });

    const extracted = await tool!.execute(
      "extract",
      {
        action: "extract",
        type: "episodic_event",
        scopeType: "project",
        projectId: "glassbox",
        statement: "An acceptance run completed.",
      },
      undefined,
      undefined,
      {} as never,
    );
    expect(extracted.details).toMatchObject([
      { status: "pending", proposedType: "episodic_event" },
    ]);

    await store.authorization.registerResource({
      id: groupResourceId("100"),
      kind: "qq_group",
      visibility: "public",
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: groupResourceId("100"),
      action: "history:read",
      scope: caller.scope,
      effect: "allow",
    });
    await store.capabilities.write({
      connectionId: "qq",
      groupId: "100",
      principalId: "owner",
      policy: { categories: {}, memorySources: { history: true } },
    });
    const archive = new ChannelArchiveStore(store.db);
    await archive.ingest({
      channel: "qq",
      connectionId: "qq",
      groupId: "100",
      externalMessageId: "external-1",
      senderId: "member-1",
      normalizedText: "Source fact.",
      occurredAt: "2026-09-20T10:00:00Z",
    });
    await archive.ingest({
      channel: "qq",
      connectionId: "qq",
      groupId: "100",
      externalMessageId: "external-2",
      senderId: "member-2",
      normalizedText: "哈哈",
      occurredAt: "2026-09-20T10:01:00Z",
    });
    const source = await tool!.execute(
      "source",
      {
        action: "source",
        groupId: "100",
        sourceClass: "history",
        scopeType: "project",
        projectId: "glassbox",
        query: "Source fact",
      },
      undefined,
      undefined,
      {} as never,
    );
    expect(source.details).toMatchObject({
      matched: 1,
      imported: 1,
      created: 1,
      reused: 0,
      skipped: 0,
      candidates: [
        expect.objectContaining({
          status: "pending",
          sourceEvidence: [
            expect.objectContaining({
              metadata: expect.objectContaining({
                externalMessageId: "external-1",
                senderId: "member-1",
                untrustedInput: true,
              }),
            }),
          ],
        }),
      ],
    });
    const imported = source.details as {
      candidates: Array<{
        sourceEvidence: Array<{ metadata: { authorizationDecisionId: string } }>;
      }>;
    };
    const sourceDecisionId =
      imported.candidates[0]!.sourceEvidence[0]!.metadata.authorizationDecisionId;
    const sourceDecision = await store.db.transaction((tx) =>
      tx.execute({
        sql: "SELECT policy_condition_json,delivery_source FROM authorization_decisions_all WHERE id = ?",
        args: [sourceDecisionId],
      }),
    );
    expect(sourceDecision.rows[0]).toMatchObject({
      policy_condition_json: JSON.stringify({
        version: 1,
        kind: "qq_memory_source",
        connectionId: "qq",
        groupId: "100",
        sourceClass: "history",
      }),
      delivery_source: "content_source",
    });
    // The message that asserts nothing was never read as a candidate: the query matched one
    // message and the rest of the read was dropped before it reached the review queue.
    const queued = () =>
      store.learning.listCandidates(
        { caller },
        { scope: { type: "project", projectId: "glassbox" } },
      );
    const before = (await queued()).length;

    // The same read again queues nothing new: the assertion is already pending review, so a
    // repeated or re-run read cannot fill the Owner's queue with copies of what is in it.
    const again = await tool!.execute(
      "source-again",
      {
        action: "source",
        groupId: "100",
        sourceClass: "history",
        scopeType: "project",
        projectId: "glassbox",
        query: "Source fact",
      },
      undefined,
      undefined,
      {} as never,
    );
    expect(again.details).toMatchObject({ imported: 1, created: 0, reused: 1 });
    expect(await queued()).toHaveLength(before);

    // No query at all is refused rather than defaulting to "the most recent messages", and the
    // refusal says which rule was broken.
    await expect(
      tool!.execute(
        "source-no-query",
        {
          action: "source",
          groupId: "100",
          sourceClass: "history",
          scopeType: "project",
          projectId: "glassbox",
        },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("memory_source_query_required");
    expect(await store.learning.listMemories({ caller })).toHaveLength(1);

    const explicitRun = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: caller.scope,
      messageId: "explicit-write",
      text: "/memory write global semantic_fact The Owner confirmed this fact.",
      executionRef: "pi:test",
    });
    currentRunId = explicitRun.run.id;
    const explicit = await tool!.execute(
      "explicit-write",
      {
        action: "write",
        scopeType: "global",
        type: "semantic_fact",
        statement: "The Owner confirmed this fact.",
      },
      undefined,
      undefined,
      {} as never,
    );
    expect(explicit.details).toMatchObject({ lifecycleState: "active", scope: { type: "global" } });

    await store.authorization.revoke(governGrant);
    const readableAfterGovernRevoke = await tool!.execute(
      "list-after-govern-revoke",
      { action: "list" },
      undefined,
      undefined,
      {} as never,
    );
    expect(readableAfterGovernRevoke.details).toHaveLength(2);

    await store.authorization.revoke(writeGrant);
    await expect(
      tool!.execute(
        "revoked-write",
        {
          action: "write",
          type: "semantic_fact",
          statement: "Must not persist.",
          scopeType: "global",
        },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("Permission denied");
    expect(await store.learning.listMemories({ caller })).toHaveLength(2);
  } finally {
    await store.close();
  }
});

it("rejects the private Memory tool from a group context before loading content", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  const caller = {
    principalId: "owner",
    scope: {
      connectionId: "qq",
      botId: "bot",
      chatType: "group" as const,
      chatId: "123",
      senderId: "owner",
    },
  };
  try {
    await store.identities.bindOwner("owner", caller.scope);
    await store.conversations.createAgent("personal");
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "agent:personal",
      action: "run:create",
      scope: caller.scope,
      effect: "allow",
    });
    const accepted = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: caller.scope,
      messageId: "group-message",
      text: "list memory",
      executionRef: "pi:test",
    });
    await store.authorization.registerResource({
      id: OWNER_MEMORY_RESOURCE,
      kind: "owner-memory",
      visibility: "private",
      ownerId: "owner",
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: OWNER_MEMORY_RESOURCE,
      action: MEMORY_GOVERN_ACTION,
      scope: caller.scope,
      effect: "allow",
    });
    const [tool] = createOwnerMemoryTools({
      store,
      getContext: () => ({
        caller,
        runId: accepted.run.id,
        conversationId: accepted.conversation.id,
      }),
    });
    await expect(
      tool!.execute("group-list", { action: "list" }, undefined, undefined, {} as never),
    ).rejects.toThrow("private_group_context");
  } finally {
    await store.close();
  }
});

it("authorizes a governing command the Owner wrote on its own line, and nothing else", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  const caller = {
    principalId: "owner",
    scope: {
      connectionId: "qq",
      botId: "bot",
      chatType: "private" as const,
      chatId: "owner",
      senderId: "owner",
    },
  };
  try {
    await store.identities.bindOwner("owner", caller.scope);
    await store.conversations.createAgent("personal");
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "agent:personal",
      action: "run:create",
      scope: caller.scope,
      effect: "allow",
    });
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
        scope: caller.scope,
        effect: "allow",
      });
    const seed = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: caller.scope,
      messageId: "seed",
      text: "开始候选审核",
      executionRef: "pi:test",
    });
    const candidate = await store.learning.createCandidate(
      { caller, conversationId: seed.conversation.id, runId: seed.run.id },
      {
        candidateKind: "assertion",
        subject: { kind: "user", id: "owner" },
        scope: { type: "global" },
        proposedType: "semantic_fact",
        statement: "A fact the Owner confirmed.",
        content: { statement: "A fact the Owner confirmed." },
        source: { kind: "system", ref: `run:${seed.run.id}` },
        sourceEvidence: [],
        confidence: 0.9,
        mergeHint: { strategy: "manual_review_required" },
        extensions: {},
      },
    );
    let currentRunId = seed.run.id;
    const [tool] = createOwnerMemoryTools({
      store,
      getContext: () => ({
        caller,
        runId: currentRunId,
        conversationId: seed.conversation.id,
      }),
    });

    // The command inside a longer message, on its own line: the Owner typed it, so it authorizes
    // the promotion. Requiring the whole message to equal the command refused this one.
    const inSentence = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: caller.scope,
      messageId: "in-sentence",
      text: `好的，把这条提升吧\n   /memory promote ${candidate.candidateId}   \n谢谢`,
      executionRef: "pi:test",
    });
    currentRunId = inSentence.run.id;
    expect(
      await tool!.execute(
        "in-sentence",
        { action: "promote", id: candidate.candidateId },
        undefined,
        undefined,
        {} as never,
      ),
    ).toMatchObject({ details: { lifecycleState: "active" } });

    // The same command with no command in the message at all still authorizes nothing, and the
    // refusal names the gate rather than collapsing into "the Tool failed".
    const prose = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: caller.scope,
      messageId: "prose-only",
      text: "把第一个候选提升",
      executionRef: "pi:test",
    });
    currentRunId = prose.run.id;
    await expect(
      tool!.execute(
        "prose-only",
        { action: "promote", id: candidate.candidateId },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("owner_confirmation_required");
  } finally {
    await store.close();
  }
});
