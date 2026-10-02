import { expect, it } from "vite-plus/test";
import { openDomainStore } from "../../persistence/index.js";
import { ChannelArchiveStore } from "../../retrieval/channel-archive.js";
import { createOwnerMemoryTools } from "./owner-memory-tools.js";

async function fixture() {
  const store = await openDomainStore({ databasePath: ":memory:" });
  const scope = {
    connectionId: "qq",
    botId: "bot",
    chatType: "private" as const,
    chatId: "owner",
    senderId: "owner",
  };
  const caller = { principalId: "owner", scope };
  await store.identities.bindOwner("owner", scope);
  await store.conversations.createAgent("personal");
  await store.authorization.registerResource({
    id: "owner-memory",
    kind: "owner-memory",
    visibility: "private",
    ownerId: "owner",
  });
  await store.authorization.registerResource({
    id: "group:100",
    kind: "qq_group",
    visibility: "public",
  });
  for (const [resourceId, action] of [
    ["agent:personal", "run:create"],
    ["owner-memory", "memory:read"],
    ["owner-memory", "memory:write"],
    ["owner-memory", "memory:govern"],
    ["group:100", "history:read"],
  ])
    await store.authorization.grant({
      principalId: "owner",
      resourceId: resourceId!,
      action: action!,
      scope,
      effect: "allow",
    });
  await store.capabilities.write({
    connectionId: "qq",
    groupId: "100",
    principalId: "owner",
    policy: { categories: {}, memorySources: { history: true } },
  });
  let sequence = 0;
  const accept = (text: string, inputScope = scope) =>
    store.conversations.acceptIncoming({
      agentId: "personal",
      scope: inputScope,
      messageId: `message-${++sequence}`,
      text,
      executionRef: "pi:fixture",
    });
  let current = await accept("Start");
  const [tool] = createOwnerMemoryTools({
    store,
    getContext: () => ({ caller, runId: current.run.id, conversationId: current.conversation.id }),
  });
  const call = (args: Record<string, unknown>) =>
    tool!.execute("batch-call", args, undefined, undefined, {} as never);
  const setCurrent = (value: typeof current) => {
    current = value;
  };
  const archive = new ChannelArchiveStore(store.db);
  const importBatch = async (label: string, count: number) => {
    for (let i = 0; i < count; i++)
      await archive.ingest({
        channel: "qq",
        connectionId: "qq",
        groupId: "100",
        externalMessageId: `${label}-${i}`,
        senderId: "member",
        normalizedText: `${label} deployment target number ${i} is Linux.`,
        occurredAt: "2026-09-20T10:00:00Z",
      });
    current = await accept(`/memory source global 100 history ${label} ${count}`);
    const result = await call({
      action: "source",
      scopeType: "global",
      groupId: "100",
      sourceClass: "history",
      query: label,
      limit: count,
    });
    const candidates = (result.details as { candidates: { candidateId: string }[] }).candidates;
    expect(candidates).toHaveLength(count);
    return { run: current, ids: candidates.map((c) => c.candidateId) };
  };
  const pending = () => store.learning.listCandidates({ caller }, { status: "pending" });
  return { store, scope, caller, accept, call, setCurrent, importBatch, pending };
}

it.each([2, 20])(
  "confirms all %i different QQ source references in the latest Run batch",
  async (count) => {
    const f = await fixture();
    try {
      const older = await f.importBatch("Earlier", 2);
      const newest = await f.importBatch("Release", count);
      // Identical timestamps must not let random candidate IDs choose an older Run.
      await f.store.db.transaction((tx) =>
        tx.execute("UPDATE memory_candidates SET created_at = '2026-09-20T10:00:00.000Z'"),
      );
      const refs = (await f.pending())
        .filter((c) => newest.ids.includes(c.candidateId))
        .map((c) => c.source.ref);
      expect(new Set(refs).size).toBe(count);
      f.setCurrent(await f.accept("/memory ok"));
      const result = await f.call({ action: "confirm" });
      const results = (result.details as { results: { candidateId: string; status: string }[] })
        .results;
      expect(results.map((c) => c.candidateId).sort()).toEqual([...newest.ids].sort());
      expect(results.every((c) => c.status === "promoted")).toBe(true);
      expect((await f.pending()).map((c) => c.candidateId).sort()).toEqual([...older.ids].sort());
      const memories = await f.store.learning.listMemories({ caller: f.caller });
      expect(memories).toHaveLength(count);
      expect(memories.every((m) => m.sensitivity === "confidential")).toBe(true);
      expect(memories.map((m) => m.source.ref).sort()).toEqual(refs.sort());
    } finally {
      await f.store.close();
    }
  },
);

it("rejects an oversized latest batch before promoting any of its candidates", async () => {
  const f = await fixture();
  try {
    const batch = await f.importBatch("Release", 21);
    f.setCurrent(await f.accept("/memory ok"));
    await expect(f.call({ action: "confirm" })).rejects.toThrow("too_many_pending_candidates");
    expect((await f.pending()).map((c) => c.candidateId).sort()).toEqual([...batch.ids].sort());
    expect(await f.store.learning.listMemories({ caller: f.caller })).toEqual([]);
  } finally {
    await f.store.close();
  }
});

it("uses prior Run order, excluding the confirmation Run and later Runs", async () => {
  const f = await fixture();
  try {
    const older = await f.importBatch("Earlier", 2);
    const confirmation = await f.accept("/memory ok");
    const later = await f.importBatch("Later", 2);
    f.setCurrent(confirmation);
    const result = await f.call({ action: "confirm" });
    expect(
      (result.details as { results: { candidateId: string }[] }).results
        .map((c) => c.candidateId)
        .sort(),
    ).toEqual([...older.ids].sort());
    expect((await f.pending()).map((c) => c.candidateId).sort()).toEqual([...later.ids].sort());
  } finally {
    await f.store.close();
  }
});

it("does not let candidate source metadata or another conversation redefine a batch", async () => {
  const f = await fixture();
  try {
    const older = await f.importBatch("Earlier", 2);
    const newest = await f.importBatch("Release", 2);
    // Simulate model-supplied source claims. Selection must read only server audit provenance.
    await f.store.db.transaction(async (tx) => {
      for (const id of older.ids)
        await tx.execute({
          sql: "UPDATE memory_candidates SET source_json = ?, evidence_json = ?, extensions_json = ? WHERE id = ?",
          args: [
            JSON.stringify({ kind: "system", ref: `run:${newest.run.run.id}` }),
            JSON.stringify([
              {
                kind: "system_inference",
                ref: `run:${newest.run.run.id}`,
                metadata: { sourceReadRunId: newest.run.run.id },
              },
            ]),
            JSON.stringify({ runId: newest.run.run.id }),
            id,
          ],
        });
    });
    const otherScope = { ...f.scope, connectionId: "other-qq" };
    await f.store.identities.bindPrincipal("owner", otherScope);
    await f.store.authorization.grant({
      principalId: "owner",
      resourceId: "agent:personal",
      action: "run:create",
      scope: otherScope,
      effect: "allow",
    });
    await f.store.authorization.grant({
      principalId: "owner",
      resourceId: "owner-memory",
      action: "memory:write",
      scope: otherScope,
      effect: "allow",
    });
    const other = await f.accept("Another conversation", otherScope);
    const foreign = await f.store.learning.createCandidate(
      {
        caller: { ...f.caller, scope: otherScope },
        conversationId: other.conversation.id,
        runId: other.run.id,
      },
      {
        candidateKind: "assertion",
        subject: { kind: "user", id: "owner" },
        scope: { type: "global" },
        proposedType: "semantic_fact",
        statement: "Foreign conversation fact",
        content: { statement: "Foreign conversation fact" },
        source: { kind: "system", ref: `run:${newest.run.run.id}` },
        sourceEvidence: [],
        mergeHint: { strategy: "manual_review_required" },
        extensions: {},
      },
    );
    f.setCurrent(await f.accept("/memory ok"));
    const result = await f.call({ action: "confirm" });
    expect(
      (result.details as { results: { candidateId: string }[] }).results
        .map((c) => c.candidateId)
        .sort(),
    ).toEqual([...newest.ids].sort());
    expect((await f.pending()).map((c) => c.candidateId).sort()).toEqual(
      [...older.ids, foreign.candidateId].sort(),
    );
  } finally {
    await f.store.close();
  }
});

it("does not adopt a duplicate from another conversation or a different Owner's candidate", async () => {
  const f = await fixture();
  try {
    const first = await f.importBatch("Earlier", 2);
    const otherScope = { ...f.scope, connectionId: "other-qq" };
    const coOwnerScope = { ...f.scope, chatId: "co-owner", senderId: "co-owner" };
    await f.store.identities.bindPrincipal("owner", otherScope);
    await f.store.identities.createPrincipal("co-owner", "owner");
    await f.store.identities.bindPrincipal("co-owner", coOwnerScope);
    for (const [principalId, scope] of [
      ["owner", otherScope],
      ["co-owner", coOwnerScope],
    ] as const)
      for (const [resourceId, action] of [
        ["agent:personal", "run:create"],
        ["owner-memory", "memory:write"],
      ])
        await f.store.authorization.grant({
          principalId,
          resourceId: resourceId!,
          action: action!,
          scope,
          effect: "allow",
        });
    const protectedOriginal = await f.store.learning.getCandidate(
      { caller: f.caller },
      first.ids[0]!,
    );
    const literalRun = await f.accept("请记住，The original source-free suggestion", otherScope);
    const original = await f.store.learning.captureCurrentMessage({
      caller: { ...f.caller, scope: otherScope },
      conversationId: literalRun.conversation.id,
      runId: literalRun.run.id,
    });
    expect(original).toBeDefined();
    const otherRun = await f.accept("Repeat the earlier suggestion", otherScope);
    const otherContext = {
      caller: { ...f.caller, scope: otherScope },
      conversationId: otherRun.conversation.id,
      runId: otherRun.run.id,
    };
    // A different connection may not reuse QQ-derived content without its source authority.
    await expect(
      f.store.learning.createCandidate(otherContext, protectedOriginal!),
    ).rejects.toThrow("memory_source_denied");
    const coOwnerRun = await f.accept("Another Owner's suggestion", coOwnerScope);
    const foreign = await f.store.learning.createCandidate(
      {
        caller: { principalId: "co-owner", scope: coOwnerScope },
        conversationId: coOwnerRun.conversation.id,
        runId: coOwnerRun.run.id,
      },
      {
        candidateKind: "assertion",
        subject: { kind: "user", id: "co-owner" },
        scope: { type: "global" },
        proposedType: "semantic_fact",
        statement: "The other Owner deploys on Tuesday.",
        content: {},
        source: { kind: "system", ref: `run:${first.run.run.id}` },
        sourceEvidence: [],
        mergeHint: { strategy: "manual_review_required" },
        extensions: {},
      },
    );
    const newest = await f.importBatch("Release", 2);
    // A duplicate written after the valid batch must not adopt a foreign origin. Using
    // the latest write audit instead of the first creation audit would select this one.
    const duplicateRun = await f.accept("Repeat the source-free suggestion");
    const repeated = await f.store.learning.createCandidate(
      {
        caller: f.caller,
        conversationId: duplicateRun.conversation.id,
        runId: duplicateRun.run.id,
      },
      original!,
    );
    expect(repeated.candidateId).toBe(original!.candidateId);
    f.setCurrent(await f.accept("/memory ok"));
    const result = await f.call({ action: "confirm" });
    expect(
      (result.details as { results: { candidateId: string }[] }).results
        .map((c) => c.candidateId)
        .sort(),
    ).toEqual([...newest.ids].sort());
    expect((await f.pending()).map((c) => c.candidateId).sort()).toEqual(
      [...first.ids, original!.candidateId, foreign.candidateId].sort(),
    );
  } finally {
    await f.store.close();
  }
});

it("promote last uses server creation order even when candidate timestamps are identical", async () => {
  const f = await fixture();
  try {
    await f.importBatch("Earlier", 2);
    const newest = await f.importBatch("Release", 2);
    await f.store.db.transaction((tx) =>
      tx.execute("UPDATE memory_candidates SET created_at = '2026-09-20T10:00:00.000Z'"),
    );
    f.setCurrent(await f.accept("/memory promote last"));
    await f.call({ action: "promote", id: "last" });
    expect(
      (await f.store.learning.getCandidate({ caller: f.caller }, newest.ids.at(-1)!))?.status,
    ).toBe("promoted");
    expect(await f.pending()).toHaveLength(3);
  } finally {
    await f.store.close();
  }
});

it("reports reused legacy candidates with public review handles", async () => {
  const f = await fixture();
  try {
    const origin = await f.accept("The original suggestion");
    const statement = "Release deployment target number 0 is Linux.";
    await f.store.learning.createCandidate(
      { caller: f.caller, conversationId: origin.conversation.id, runId: origin.run.id },
      {
        candidateId: "123e4567-e89b-12d3-a456-426614174000",
        candidateKind: "assertion",
        subject: { kind: "user", id: "owner" },
        scope: { type: "global" },
        proposedType: "semantic_fact",
        statement,
        content: { statement },
        source: { kind: "system", ref: `run:${origin.run.id}` },
        sourceEvidence: [],
        mergeHint: { strategy: "manual_review_required" },
        extensions: {},
      },
    );
    const batch = await f.importBatch("Release", 1);
    const result = await f.call({
      action: "source",
      scopeType: "global",
      groupId: "100",
      sourceClass: "history",
      query: "Release",
      limit: 1,
    });
    expect(result.details).toMatchObject({
      imported: 1,
      created: 0,
      reused: 1,
      reusedCandidateIds: batch.ids,
    });
    expect(batch.ids).toEqual(["candidate_legacy_123e4567e89b12d3a456426614174000"]);
  } finally {
    await f.store.close();
  }
});
