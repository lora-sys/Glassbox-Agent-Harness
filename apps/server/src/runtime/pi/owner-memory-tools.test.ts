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
    const [tool] = createOwnerMemoryTools({
      store,
      getContext: () => ({
        caller,
        runId: currentRunId,
        conversationId: accepted.conversation.id,
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
    ).rejects.toThrow("protected_tool_failed");
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
    ).rejects.toThrow("protected_tool_failed");
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
    const source = await tool!.execute(
      "source",
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
    );
    expect(source.details).toMatchObject([
      {
        status: "pending",
        sourceEvidence: [
          {
            metadata: {
              externalMessageId: "external-1",
              senderId: "member-1",
              untrustedInput: true,
            },
          },
        ],
      },
    ]);
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
