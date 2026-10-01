import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { openDomainStore } from "../application/domain-store.js";
import { MemoryConsolidator } from "./consolidation.js";
import { createOwnerMemoryTools } from "../runtime/pi/owner-memory-tools.js";

async function fixture(databasePath = ":memory:") {
  const store = await openDomainStore({ databasePath });
  const scope = {
    connectionId: "qq",
    botId: "bot",
    chatType: "private" as const,
    chatId: "owner",
    senderId: "owner",
  };
  const caller = { principalId: "owner", scope };
  const context = { caller };
  const groupContext = {
    caller: {
      principalId: "owner",
      scope: { ...scope, chatType: "group" as const, chatId: "100" },
    },
  };
  const groupScope = { type: "group" as const, connectionId: "qq", botId: "bot", groupId: "100" };
  await store.identities.bindOwner("owner", scope);
  await store.conversations.createAgent("personal");
  await store.authorization.grant({
    principalId: "owner",
    resourceId: "agent:personal",
    action: "run:create",
    scope,
    effect: "allow",
  });
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
  for (const action of ["memory:read", "memory:write", "memory:govern"])
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "owner-memory",
      action,
      scope,
      effect: "allow",
    });
  await store.authorization.grant({
    principalId: "owner",
    resourceId: "group:100",
    action: "memory:read",
    scope: groupContext.caller.scope,
    effect: "allow",
  });
  const base = {
    subject: { kind: "user" as const, id: "owner" },
    scope: { type: "global" as const },
    type: "semantic_fact" as const,
  };
  return { store, caller, context, scope, groupContext, groupScope, base };
}

it.each(
  (["global", "group"] as const).flatMap((kind) => [1, 40, 100].map((limit) => ({ kind, limit }))),
)("fills the $kind memory limit of $limit with active eligible rows", async ({ kind, limit }) => {
  const f = await fixture();
  try {
    const base = {
      ...f.base,
      scope: kind === "group" ? f.groupScope : f.base.scope,
      sensitivity: "public" as const,
    };
    const eligibleIds: string[] = [];
    for (let i = 0; i < limit; i++) {
      const memory = await f.store.learning.writeExplicit(f.context, {
        ...base,
        statement: `Still relevant ${i}`,
      });
      eligibleIds.push(memory.memoryId);
    }
    await f.store.db.transaction((tx) =>
      tx.execute("UPDATE memories SET updated_at = '2000-01-01T00:00:00.000Z'"),
    );
    for (let i = 0; i <= limit; i++) {
      await f.store.learning.writeExplicit(f.context, {
        ...base,
        statement: `Expired record ${i}`,
        ttlSeconds: 0,
      });
      if (kind === "group") {
        await f.store.learning.writeExplicit(f.context, {
          ...base,
          statement: `Confidential record ${i}`,
          sensitivity: "confidential",
        });
        await f.store.learning.writeExplicit(f.context, {
          ...f.base,
          scope: f.groupScope,
          statement: `Unclassified record ${i}`,
        });
      }
    }
    const rows =
      kind === "group"
        ? await f.store.learning.listGroupMemories(f.groupContext, "group:100", f.groupScope, limit)
        : await f.store.learning.listMemories(f.context, { scope: base.scope, limit });
    expect(rows.map((row) => row.memoryId)).toEqual(eligibleIds.sort());
    const inspected = await f.store.learning.listMemories(f.context, {
      scope: base.scope,
      includeInactive: true,
    });
    expect(inspected.filter((row) => row.lifecycleState === "expired")).toHaveLength(limit + 1);
    if (kind === "group")
      expect(inspected.filter((row) => row.sensitivity !== "public")).toHaveLength(2 * (limit + 1));
  } finally {
    await f.store.close();
  }
});

it.each(["global", "group"])("excludes $0 memory expiring exactly at query time", async (kind) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = new Date("2026-10-01T00:00:00.000Z");
  vi.setSystemTime(start);
  const f = await fixture();
  try {
    const base = {
      ...f.base,
      scope: kind === "group" ? f.groupScope : f.base.scope,
      sensitivity: "public" as const,
    };
    const permanent = await f.store.learning.writeExplicit(f.context, {
      ...base,
      statement: "Permanent",
    });
    vi.setSystemTime(new Date(start.getTime() + 1_000));
    const temporary = await f.store.learning.writeExplicit(f.context, {
      ...base,
      statement: "Temporary",
      ttlSeconds: 1,
    });
    const list = () =>
      kind === "group"
        ? f.store.learning.listGroupMemories(f.groupContext, "group:100", f.groupScope, 1)
        : f.store.learning.listMemories(f.context, { scope: base.scope, limit: 1 });
    vi.setSystemTime(new Date(start.getTime() + 1_999));
    expect((await list()).map((row) => row.memoryId)).toEqual([temporary.memoryId]);
    vi.setSystemTime(new Date(start.getTime() + 2_000));
    expect((await list()).map((row) => row.memoryId)).toEqual([permanent.memoryId]);
    expect(
      await f.store.learning.listMemories(f.context, {
        scope: base.scope,
        includeInactive: true,
        limit: 1,
      }),
    ).toMatchObject([{ memoryId: temporary.memoryId, lifecycleState: "expired" }]);
  } finally {
    await f.store.close();
    vi.useRealTimers();
  }
});

it.each(
  (["explicit", "candidate"] as const).flatMap((mode) =>
    (["public", "confidential"] as const).map((sensitivity) => ({ mode, sensitivity })),
  ),
)(
  "preserves $sensitivity group sensitivity for a $mode correction after reopen",
  async ({ mode, sensitivity }) => {
    const directory = await mkdtemp(join(tmpdir(), "glassbox-memory-correction-"));
    const databasePath = join(directory, "glassbox.db");
    const f = await fixture(databasePath);
    try {
      const base = { ...f.base, scope: f.groupScope };
      const original = await f.store.learning.writeExplicit(f.context, {
        ...base,
        statement: "Meeting Monday",
        sensitivity,
      });
      const accepted = await f.store.conversations.acceptIncoming({
        agentId: "personal",
        scope: f.scope,
        messageId: "supersede",
        text:
          mode === "explicit"
            ? `/memory supersede ${original.memoryId} Meeting Tuesday`
            : "Suggest a correction",
        executionRef: "fixture",
      });
      const [tool] = createOwnerMemoryTools({
        store: f.store,
        getContext: () => ({
          caller: f.caller,
          runId: accepted.run.id,
          conversationId: accepted.conversation.id,
        }),
      });
      const result = await tool!.execute(
        "call",
        { action: "supersede", id: original.memoryId, statement: "Meeting Tuesday" },
        undefined,
        undefined,
        {} as never,
      );
      if (mode === "candidate") {
        const candidates = await f.store.learning.listCandidates(f.context);
        const candidate = candidates.find(
          (row) => row.mergeHint.ifMatchMemoryId === original.memoryId,
        );
        expect(candidate).toBeDefined();
        await f.store.learning.promoteCandidate(f.context, candidate!.candidateId);
      } else expect(result.details).toMatchObject({ sensitivity });
      await f.store.close();
      f.store = await openDomainStore({ databasePath });
      const rows = await f.store.learning.listGroupMemories(
        f.groupContext,
        "group:100",
        f.groupScope,
      );
      expect(rows.map((row) => row.content.statement)).toEqual(
        sensitivity === "public" ? ["Meeting Tuesday"] : [],
      );
      const [replacement] = await f.store.learning.listMemories(f.context, { scope: f.groupScope });
      expect(replacement).toMatchObject({
        sensitivity,
        scope: f.groupScope,
        content: { statement: "Meeting Tuesday" },
        supersedes: [original.memoryId],
      });
      expect((await f.store.learning.getMemory(f.context, original.memoryId))?.lifecycleState).toBe(
        "retired",
      );
    } finally {
      await f.store.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each(["superseded", "expired", "revoked", "retired", "missing"])(
  "rejects correction promotion with a %s target",
  async (state) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-10-01T00:00:00.000Z");
    vi.setSystemTime(start);
    const directory = await mkdtemp(join(tmpdir(), "glassbox-memory-stale-"));
    const databasePath = join(directory, "glassbox.db");
    const f = await fixture(databasePath);
    try {
      const original = await f.store.learning.writeExplicit(f.context, {
        ...f.base,
        statement: "Launch Monday",
        ...(state === "expired" ? { ttlSeconds: 1 } : {}),
      });
      const candidate = await f.store.learning.createCandidate(f.context, {
        candidateKind: "correction",
        subject: f.base.subject,
        scope: f.base.scope,
        proposedType: f.base.type,
        statement: "Launch Tuesday",
        content: { statement: "Launch Tuesday" },
        source: { kind: "human", ref: "fixture" },
        sourceEvidence: [],
        mergeHint: { strategy: "manual_review_required", ifMatchMemoryId: original.memoryId },
        extensions: {},
      });
      if (state === "superseded")
        await f.store.learning.supersedeMemory(f.context, original.memoryId, {
          ...f.base,
          statement: "Launch Wednesday",
        });
      else if (state === "expired") vi.setSystemTime(new Date(start.getTime() + 1_000));
      else if (state === "missing")
        await f.store.db.transaction((tx) =>
          tx.execute({ sql: "DELETE FROM memories WHERE id = ?", args: [original.memoryId] }),
        );
      else
        await f.store.learning.setLifecycle(
          f.context,
          original.memoryId,
          state as "revoked" | "retired",
        );
      await expect(
        f.store.learning.promoteCandidate(f.context, candidate.candidateId),
      ).rejects.toThrow("memory_not_active");
      await f.store.close();
      f.store = await openDomainStore({ databasePath });
      expect((await f.store.learning.getCandidate(f.context, candidate.candidateId))?.status).toBe(
        "pending",
      );
      const active = await f.store.learning.listMemories(f.context);
      expect(active.map((row) => row.content.statement)).toEqual(
        state === "superseded" ? ["Launch Wednesday"] : [],
      );
      expect(
        await f.store.learning.listMemories(f.context, { includeInactive: true }),
      ).toHaveLength(state === "missing" ? 0 : state === "superseded" ? 2 : 1);
    } finally {
      await f.store.close();
      await rm(directory, { recursive: true, force: true });
      vi.useRealTimers();
    }
  },
);

it.each(["explicit", "candidate"])(
  "preserves the expiry deadline and retention policy for a %s statement correction",
  async (mode) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-10-01T00:00:00.000Z");
    vi.setSystemTime(start);
    const directory = await mkdtemp(join(tmpdir(), "glassbox-memory-retention-"));
    const databasePath = join(directory, "glassbox.db");
    const f = await fixture(databasePath);
    try {
      const original = await f.store.learning.writeExplicit(f.context, {
        ...f.base,
        statement: "Temporary Monday fact",
        ttlSeconds: 60,
        retentionPolicy: "project-window",
      });
      vi.setSystemTime(new Date(start.getTime() + 30_000));
      const statement = "Temporary Tuesday fact";
      const replacement =
        mode === "explicit"
          ? await f.store.learning.supersedeMemory(f.context, original.memoryId, {
              ...f.base,
              statement,
            })
          : await f.store.learning.promoteCandidate(
              f.context,
              (
                await f.store.learning.createCandidate(f.context, {
                  candidateKind: "correction",
                  subject: f.base.subject,
                  scope: f.base.scope,
                  proposedType: f.base.type,
                  statement,
                  content: { statement },
                  source: { kind: "human", ref: "fixture" },
                  sourceEvidence: [],
                  mergeHint: {
                    strategy: "manual_review_required",
                    ifMatchMemoryId: original.memoryId,
                  },
                  extensions: {},
                })
              ).candidateId,
            );
      expect(replacement).toMatchObject({
        ttlSeconds: original.ttlSeconds,
        expiresAt: original.expiresAt,
        retentionPolicy: original.retentionPolicy,
      });
      await f.store.close();
      f.store = await openDomainStore({ databasePath });
      expect(await f.store.learning.getMemory(f.context, replacement.memoryId)).toMatchObject({
        ttlSeconds: original.ttlSeconds,
        expiresAt: original.expiresAt,
        retentionPolicy: original.retentionPolicy,
        lifecycleState: "active",
      });
      vi.setSystemTime(new Date(start.getTime() + 60_000));
      expect(await f.store.learning.listMemories(f.context)).toEqual([]);
      expect(await f.store.learning.getMemory(f.context, replacement.memoryId)).toMatchObject({
        lifecycleState: "expired",
      });
    } finally {
      await f.store.close();
      await rm(directory, { recursive: true, force: true });
      vi.useRealTimers();
    }
  },
);

it.each(
  (["explicit", "candidate"] as const).flatMap((mode) =>
    [0, 180].map((ttlSeconds) => ({ mode, ttlSeconds })),
  ),
)(
  "honors explicit metadata in a $mode correction with TTL $ttlSeconds",
  async ({ mode, ttlSeconds }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-10-01T00:00:00.000Z");
    vi.setSystemTime(start);
    const f = await fixture();
    try {
      const original = await f.store.learning.writeExplicit(f.context, {
        ...f.base,
        statement: "Monday fact",
        sensitivity: "public",
        ttlSeconds: 60,
        retentionPolicy: "original-policy",
      });
      vi.setSystemTime(new Date(start.getTime() + 30_000));
      const input = {
        ...f.base,
        statement: "Tuesday fact",
        sensitivity: "confidential" as const,
        ttlSeconds,
        retentionPolicy: "revised-policy",
      };
      const replacement =
        mode === "explicit"
          ? await f.store.learning.supersedeMemory(f.context, original.memoryId, input)
          : await f.store.learning.promoteCandidate(
              f.context,
              (
                await f.store.learning.createCandidate(f.context, {
                  candidateKind: "correction",
                  subject: input.subject,
                  scope: input.scope,
                  proposedType: input.type,
                  statement: input.statement,
                  content: { statement: input.statement },
                  source: { kind: "human", ref: "fixture" },
                  sourceEvidence: [],
                  sensitivity: input.sensitivity,
                  ttlSeconds,
                  retentionPolicy: input.retentionPolicy,
                  mergeHint: {
                    strategy: "manual_review_required",
                    ifMatchMemoryId: original.memoryId,
                  },
                  extensions: {},
                })
              ).candidateId,
            );
      expect(replacement).toMatchObject({
        sensitivity: "confidential",
        ttlSeconds,
        expiresAt: new Date(start.getTime() + (30 + ttlSeconds) * 1_000).toISOString(),
        retentionPolicy: "revised-policy",
      });
      expect(await f.store.learning.getMemory(f.context, replacement.memoryId)).toMatchObject({
        lifecycleState: ttlSeconds === 0 ? "expired" : "active",
      });
    } finally {
      await f.store.close();
      vi.useRealTimers();
    }
  },
);

it.each(["expired", "revoked", "retired", "missing"])(
  "rejects direct supersession of a %s target without inserting a candidate",
  async (state) => {
    const f = await fixture();
    try {
      const original = await f.store.learning.writeExplicit(f.context, {
        ...f.base,
        statement: "Monday fact",
        ...(state === "expired" ? { ttlSeconds: 0 } : {}),
      });
      if (state === "missing")
        await f.store.db.transaction((tx) =>
          tx.execute({ sql: "DELETE FROM memories WHERE id = ?", args: [original.memoryId] }),
        );
      else if (state !== "expired")
        await f.store.learning.setLifecycle(
          f.context,
          original.memoryId,
          state as "revoked" | "retired",
        );
      const candidatesBefore = await f.store.learning.listCandidates(f.context);
      await expect(
        f.store.learning.supersedeMemory(f.context, original.memoryId, {
          ...f.base,
          statement: "Tuesday fact",
        }),
      ).rejects.toThrow("memory_not_active");
      expect(await f.store.learning.listCandidates(f.context)).toEqual(candidatesBefore);
      expect(await f.store.learning.listMemories(f.context)).toEqual([]);
      expect(
        await f.store.learning.listMemories(f.context, { includeInactive: true }),
      ).toHaveLength(state === "missing" ? 0 : 1);
    } finally {
      await f.store.close();
    }
  },
);

it("binds Owner Tool correction candidates to the observed memory version", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = new Date("2026-10-01T00:00:00.000Z");
  vi.setSystemTime(start);
  const f = await fixture();
  try {
    const original = await f.store.learning.writeExplicit(f.context, {
      ...f.base,
      statement: "Launch Monday",
    });
    const accepted = await f.store.conversations.acceptIncoming({
      agentId: "personal",
      scope: f.scope,
      messageId: "suggest-correction",
      text: "Suggest a launch correction",
      executionRef: "fixture",
    });
    const [tool] = createOwnerMemoryTools({
      store: f.store,
      getContext: () => ({
        caller: f.caller,
        runId: accepted.run.id,
        conversationId: accepted.conversation.id,
      }),
    });
    await tool!.execute(
      "call",
      { action: "supersede", id: original.memoryId, statement: "Launch Tuesday" },
      undefined,
      undefined,
      {} as never,
    );
    const candidate = (await f.store.learning.listCandidates(f.context)).find(
      (row) => row.mergeHint.ifMatchMemoryId === original.memoryId,
    )!;
    expect(candidate.mergeHint.ifMatchUpdatedAt).toBe(original.updatedAt);
    vi.setSystemTime(new Date(start.getTime() + 1_000));
    const updated = await f.store.learning.updateMemory(f.context, original.memoryId, {
      statement: "Launch Wednesday",
    });
    await expect(
      f.store.learning.promoteCandidate(f.context, candidate.candidateId),
    ).rejects.toThrow("memory_version_conflict");
    const promotion = await f.store.conversations.acceptIncoming({
      agentId: "personal",
      scope: f.scope,
      messageId: "promote-stale-correction",
      text: `/memory promote ${candidate.candidateId}`,
      executionRef: "fixture",
    });
    const [promotionTool] = createOwnerMemoryTools({
      store: f.store,
      getContext: () => ({
        caller: f.caller,
        runId: promotion.run.id,
        conversationId: promotion.conversation.id,
      }),
    });
    const error: unknown = await promotionTool!
      .execute(
        "promote-stale",
        { action: "promote", id: candidate.candidateId },
        undefined,
        undefined,
        {} as never,
      )
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("memory_version_conflict");
    for (const protectedValue of [
      original.memoryId,
      candidate.candidateId,
      "Launch Monday",
      "Launch Tuesday",
      "Launch Wednesday",
    ])
      expect((error as Error).message).not.toContain(protectedValue);
    expect(await f.store.learning.getMemory(f.context, original.memoryId)).toEqual(updated);
    expect(await f.store.learning.getCandidate(f.context, candidate.candidateId)).toMatchObject({
      status: "pending",
    });
    expect(
      (await f.store.learning.listMemories(f.context)).map((row) => row.content.statement),
    ).toEqual(["Launch Wednesday"]);
  } finally {
    await f.store.close();
    vi.useRealTimers();
  }
});

it.each(["update", "retire"] as const)(
  "binds extracted %s candidates to the version used during extraction",
  async (action) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-10-01T00:00:00.000Z");
    vi.setSystemTime(start);
    const f = await fixture();
    try {
      const original = await f.store.learning.writeExplicit(f.context, {
        ...f.base,
        statement: "Launch Monday",
      });
      const consolidator = new MemoryConsolidator(f.store.learning, {
        extract: async () => {
          vi.setSystemTime(new Date(start.getTime() + 1_000));
          await f.store.learning.updateMemory(f.context, original.memoryId, {
            statement: "Launch Wednesday",
          });
          return [
            {
              action,
              existingMemoryId: original.memoryId,
              type: f.base.type,
              statement: "Launch Tuesday",
            },
          ];
        },
      });
      const [candidate] = await consolidator.consolidate({
        context: f.context,
        subject: f.base.subject,
        scope: f.base.scope,
        messages: [{ role: "user", text: "Launch Tuesday", ref: "message:fixture" }],
      });
      expect(candidate!.mergeHint.ifMatchUpdatedAt).toBe(original.updatedAt);
      await expect(
        f.store.learning.promoteCandidate(f.context, candidate!.candidateId),
      ).rejects.toThrow("memory_version_conflict");
      expect(await f.store.learning.getCandidate(f.context, candidate!.candidateId)).toMatchObject({
        status: "pending",
      });
      expect(
        (await f.store.learning.listMemories(f.context)).map((row) => row.content.statement),
      ).toEqual(["Launch Wednesday"]);
    } finally {
      await f.store.close();
      vi.useRealTimers();
    }
  },
);

it.each(["manual_review_required", "replace"] as const)(
  "enforces the supplied updated-at precondition for %s candidates",
  async (strategy) => {
    const f = await fixture();
    try {
      const original = await f.store.learning.writeExplicit(f.context, {
        ...f.base,
        statement: "Launch Monday",
      });
      const create = (ifMatchUpdatedAt: string) =>
        f.store.learning.createCandidate(f.context, {
          candidateKind: "correction",
          subject: f.base.subject,
          scope: f.base.scope,
          proposedType: f.base.type,
          statement: "Launch Tuesday",
          content: { statement: "Launch Tuesday" },
          source: { kind: "human", ref: "fixture" },
          sourceEvidence: [],
          mergeHint: { strategy, ifMatchMemoryId: original.memoryId, ifMatchUpdatedAt },
          extensions: {},
        });
      const stale = await create("2000-01-01T00:00:00.000Z");
      await expect(f.store.learning.promoteCandidate(f.context, stale.candidateId)).rejects.toThrow(
        "memory_version_conflict",
      );
      expect(await f.store.learning.getCandidate(f.context, stale.candidateId)).toMatchObject({
        status: "pending",
      });
      expect(await f.store.learning.getMemory(f.context, original.memoryId)).toEqual(original);
      await f.store.learning.rejectCandidate(f.context, stale.candidateId);
      const matching = await create(original.updatedAt);
      expect(matching.candidateId).not.toBe(stale.candidateId);
      expect(
        await f.store.learning.promoteCandidate(f.context, matching.candidateId),
      ).toMatchObject({ content: { statement: "Launch Tuesday" } });
    } finally {
      await f.store.close();
    }
  },
);

it.each(["inherited", "explicit"] as const)(
  "does not reuse an existing pending correction over %s correction metadata",
  async (mode) => {
    const f = await fixture();
    try {
      const original = await f.store.learning.writeExplicit(f.context, {
        ...f.base,
        statement: "Monday fact",
        sensitivity: "confidential",
        ttlSeconds: 60,
        retentionPolicy: "original-policy",
      });
      const pending = await f.store.learning.createCandidate(f.context, {
        candidateKind: "correction",
        subject: f.base.subject,
        scope: f.base.scope,
        proposedType: f.base.type,
        statement: "Tuesday fact",
        content: { statement: "Tuesday fact" },
        source: { kind: "system", ref: "pending-suggestion" },
        sourceEvidence: [],
        sensitivity: "public",
        ttlSeconds: 3600,
        retentionPolicy: "pending-policy",
        mergeHint: {
          strategy: "manual_review_required",
          ifMatchMemoryId: original.memoryId,
          ifMatchUpdatedAt: original.updatedAt,
        },
        extensions: { "glassbox:model_inference": true },
      });
      const replacement = await f.store.learning.supersedeMemory(f.context, original.memoryId, {
        ...f.base,
        statement: "Tuesday fact",
        ...(mode === "explicit"
          ? {
              sensitivity: "confidential" as const,
              ttlSeconds: 0,
              retentionPolicy: "explicit-policy",
            }
          : {}),
      });
      expect(replacement).toMatchObject({
        sensitivity: "confidential",
        ttlSeconds: mode === "explicit" ? 0 : 60,
        retentionPolicy: mode === "explicit" ? "explicit-policy" : "original-policy",
        supersedes: [original.memoryId],
      });
      if (mode === "inherited") expect(replacement.expiresAt).toBe(original.expiresAt);
      expect(replacement.derivedFrom).not.toContain(pending.candidateId);
      expect(await f.store.learning.getCandidate(f.context, pending.candidateId)).toEqual(pending);
      const confirmed = await f.store.learning.getCandidate(f.context, replacement.derivedFrom[0]!);
      expect(confirmed).toMatchObject({
        status: "promoted",
        promotedMemoryId: replacement.memoryId,
      });
      expect(confirmed!.sourceEvidence[0]?.kind).toBe("user_confirmation");
      await expect(
        f.store.learning.promoteCandidate(f.context, pending.candidateId),
      ).rejects.toThrow("memory_not_active");
    } finally {
      await f.store.close();
    }
  },
);
