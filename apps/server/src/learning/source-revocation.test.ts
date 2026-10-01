import { expect, it, vi } from "vite-plus/test";
import { sourcePolicyFixture as fixture } from "./source-policy-test-fixture.js";
import { archiveDecisionBatch } from "../persistence/decision-archive.js";
import { MemoryConsolidator } from "./consolidation.js";

it("withholds imported candidates, promotion, and canonical Memory after exact source revocation", async () => {
  const f = await fixture();
  try {
    const candidateId = await f.importSource();
    const memory = await f.store.learning.promoteCandidate({ caller: f.caller }, candidateId);
    const pendingId = await f.importSource("notice");
    const lease = await f.store.lifecycle.claimQueuedRun(f.caller, f.accepted.run.id);
    await lease.settle("succeeded", "Imported fixture");
    expect(await archiveDecisionBatch(f.store.db, "9999-01-01T00:00:00.000Z")).toBeGreaterThan(0);
    await f.policy(false, false);
    await expect(f.store.learning.getMemory({ caller: f.caller }, memory.memoryId)).rejects.toThrow(
      "memory_source_denied",
    );
    expect(await f.store.learning.listMemories({ caller: f.caller })).toEqual([]);
    await expect(f.store.learning.getCandidate({ caller: f.caller }, pendingId)).rejects.toThrow(
      "memory_source_denied",
    );
    expect(
      await f.store.learning.listCandidates({ caller: f.caller }, { status: "pending" }),
    ).toEqual([]);
    await expect(
      f.store.learning.promoteCandidate({ caller: f.caller }, pendingId),
    ).rejects.toThrow("memory_source_denied");
    await f.policy(true, true);
    expect(await f.store.learning.getMemory({ caller: f.caller }, memory.memoryId)).toMatchObject({
      memoryId: memory.memoryId,
    });
    expect(await f.store.learning.getCandidate({ caller: f.caller }, pendingId)).toMatchObject({
      status: "pending",
    });
  } finally {
    await f.store.close();
  }
});

it("captures a model candidate's protected Run even when supplied evidence omits or disguises sources", async () => {
  const f = await fixture();
  try {
    await f.importSource();
    const candidate = await f.store.learning.createCandidate(f.context, {
      candidateKind: "derived",
      subject: f.base.subject,
      scope: f.base.scope,
      proposedType: f.base.type,
      statement: "Derived orchard fact.",
      content: { statement: "Derived orchard fact." },
      source: { kind: "human", ref: "fake-unrelated-user-source" },
      sourceEvidence: [],
      mergeHint: { strategy: "manual_review_required" },
      extensions: { source_dependencies_json: { version: 1, decisionIds: [] } },
    });
    const memory = await f.store.learning.promoteCandidate(
      { caller: f.caller },
      candidate.candidateId,
    );
    await f.policy(false);
    await expect(f.store.learning.getMemory({ caller: f.caller }, memory.memoryId)).rejects.toThrow(
      "memory_source_denied",
    );
  } finally {
    await f.store.close();
  }
});

it("preserves consumed Memory dependencies when a consolidator omits its update target", async () => {
  const f = await fixture();
  try {
    const candidateId = await f.importSource();
    await f.store.learning.promoteCandidate({ caller: f.caller }, candidateId);
    const consolidator = new MemoryConsolidator(f.store.learning, {
      extract: async () => [
        { action: "create", type: "semantic_fact", statement: "A consolidated orchard fact." },
      ],
    });
    const [candidate] = await consolidator.consolidate({
      context: { caller: f.caller },
      subject: f.base.subject,
      scope: f.base.scope,
      messages: [{ role: "user", text: "Summarize orchard", ref: "message:fixture" }],
    });
    const memory = await f.store.learning.promoteCandidate(
      { caller: f.caller },
      candidate!.candidateId,
    );
    await f.policy(false);
    await expect(f.store.learning.getMemory({ caller: f.caller }, memory.memoryId)).rejects.toThrow(
      "memory_source_denied",
    );
  } finally {
    await f.store.close();
  }
});

it("keeps a fresh explicit unrelated user write source-free despite protected Run context", async () => {
  const f = await fixture();
  try {
    await f.importSource();
    const memory = await f.store.learning.writeExplicit(f.context, {
      ...f.base,
      statement: "My unrelated favorite color is blue.",
    });
    await f.policy(false);
    expect(await f.store.learning.getMemory({ caller: f.caller }, memory.memoryId)).toMatchObject({
      content: { statement: "My unrelated favorite color is blue." },
    });
  } finally {
    await f.store.close();
  }
});

it("keeps raw source imports bound to their own class rather than unrelated prior Run reads", async () => {
  const f = await fixture();
  try {
    await f.importSource("history");
    const noticeId = await f.importSource("notice");
    await f.policy(false, true);
    expect(await f.store.learning.getCandidate({ caller: f.caller }, noticeId)).toMatchObject({
      statement: "Protected orchard notice fact.",
    });
    await f.policy(true, false);
    await expect(f.store.learning.getCandidate({ caller: f.caller }, noticeId)).rejects.toThrow(
      "memory_source_denied",
    );
  } finally {
    await f.store.close();
  }
});

async function consumeWithRuntime(
  f: Awaited<ReturnType<typeof fixture>>,
  beforeRuntime?: () => Promise<void>,
  text = "Summarize orchard facts",
  duringRuntime?: () => Promise<void>,
) {
  const origin = await f.store.db.transaction(
    async (tx) =>
      (await tx.execute({ sql: "SELECT status FROM runs WHERE id = ?", args: [f.accepted.run.id] }))
        .rows[0],
  );
  if (origin?.status === "queued") {
    const originLease = await f.store.lifecycle.claimQueuedRun(f.caller, f.accepted.run.id);
    await originLease.settle("succeeded", "Imported fixture");
  }
  const { PiRunExecutionAdapter } = await import("../runtime/pi/run-adapter.js");
  const accepted = await f.store.conversations.acceptIncoming({
    agentId: "personal",
    scope: f.scope,
    messageId: `consume-${crypto.randomUUID()}`,
    text,
    executionRef: "fake",
  });
  let prompt = "";
  let calls = 0;
  const runtime = {
    initialize: async () => {},
    createOrRestoreSession: async () => ({
      conversationId: accepted.conversation.id,
      runtimeSessionId: "fake-session",
      profileName: "owner-direct",
      agentDir: "disposable",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    }),
    getModelCapacity: () => ({
      contextWindowTokens: 32768,
      outputReserveTokens: 4096,
      thinkingReserveTokens: 0,
      safetyMarginTokens: 512,
    }),
    run: async (_session: unknown, _run: unknown, text: string) => {
      if (calls === 0) prompt = text;
      calls++;
      await duringRuntime?.();
      return { status: "completed", text: "Fixture answer", toolCalls: [] };
    },
    abort: async () => {},
    disposeSession: async () => {},
    cleanup: async () => {},
  };
  const adapter = new PiRunExecutionAdapter(runtime as never, {
    learningStore: f.store.learning,
    isOwner: async () => true,
    onLearningEvidence: beforeRuntime,
  });
  const lease = await f.store.lifecycle.claimQueuedRun(f.caller, accepted.run.id);
  const result = await adapter.execute({
    caller: f.caller,
    conversation: accepted.conversation,
    run: lease.run,
    text,
    history: [],
    providerSessionId: null,
    signal: new AbortController().signal,
  });
  return { prompt, result, accepted, lease, calls };
}

it("filters revoked Memory before automatic Runtime context and propagates allowed Memory to delivery gates", async () => {
  const f = await fixture();
  try {
    const candidate = await f.importSource();
    await f.store.learning.promoteCandidate({ caller: f.caller }, candidate);
    await f.policy(false);
    const denied = await consumeWithRuntime(f);
    expect(denied.prompt).not.toContain("Protected orchard history fact.");
    await denied.lease.settle("succeeded", denied.result.text);
    await f.policy(true);
    const allowed = await consumeWithRuntime(f);
    expect(allowed.prompt).toContain("Protected orchard history fact.");
    await allowed.lease.settle("succeeded", allowed.result.text);
    const delivery = await f.store.lifecycle.createDelivery(f.caller, {
      runId: allowed.accepted.run.id,
      dedupKey: "derived",
      destination: f.scope,
      payloadText: "Derived fixture answer",
      payloadKind: "result",
    });
    const failed = await f.store.lifecycle.createDelivery(f.caller, {
      runId: allowed.accepted.run.id,
      dedupKey: "derived-failed",
      destination: f.scope,
      payloadText: "Derived fixture answer",
      payloadKind: "result",
    });
    const deliveryLease = await f.store.lifecycle.claimDelivery(
      f.caller,
      allowed.accepted.run.id,
      failed,
    );
    await deliveryLease!.settle("failed");
    await f.policy(false);
    await expect(
      f.store.lifecycle.transitionDelivery(
        f.caller,
        allowed.accepted.run.id,
        failed,
        "failed",
        "pending",
      ),
    ).rejects.toThrow();
    await expect(
      f.store.lifecycle.claimDelivery(f.caller, allowed.accepted.run.id, delivery),
    ).rejects.toThrow();
    await expect(
      f.store.lifecycle.createDelivery(f.caller, {
        runId: allowed.accepted.run.id,
        dedupKey: "derived-late",
        destination: f.scope,
        payloadText: "Derived fixture answer",
        payloadKind: "result",
      }),
    ).rejects.toThrow();
  } finally {
    await f.store.close();
  }
});

it("rechecks Memory sources after awaited context evidence before Runtime exposure", async () => {
  const f = await fixture();
  try {
    await f.store.learning.promoteCandidate({ caller: f.caller }, await f.importSource());
    const consumed = await consumeWithRuntime(f, async () => {
      await f.policy(false);
    });
    expect(consumed.prompt).toBe("");
    expect(consumed.result).toMatchObject({ status: "failed", failureCode: "gate_refused" });
  } finally {
    await f.store.close();
  }
});

it.each(["dedupe", "replace", "merge", "reinforce", "manual_review_required"] as const)(
  "unions source dependencies through %s promotion and later explicit updates",
  async (strategy) => {
    const f = await fixture();
    try {
      const old = await f.store.learning.promoteCandidate(
        { caller: f.caller },
        await f.importSource("history"),
      );
      await f.importSource("notice");
      const candidate = await f.store.learning.createCandidate(f.context, {
        candidateKind: "correction",
        subject: f.base.subject,
        scope: f.base.scope,
        proposedType: f.base.type,
        statement: "New orchard interpretation",
        content: { statement: "New orchard interpretation" },
        source: { kind: "human", ref: "disguised-model-output" },
        sourceEvidence: [],
        mergeHint: { strategy, ifMatchMemoryId: old.memoryId },
        extensions: {},
      });
      const memory = await f.store.learning.promoteCandidate(
        { caller: f.caller },
        candidate.candidateId,
      );
      await f.store.learning.updateMemory({ caller: f.caller }, memory.memoryId, {
        statement: "Edited orchard interpretation",
      });
      await f.policy(false, true);
      await expect(
        f.store.learning.getMemory({ caller: f.caller }, memory.memoryId),
      ).rejects.toThrow("memory_source_denied");
      await f.policy(true, false);
      await expect(
        f.store.learning.getMemory({ caller: f.caller }, memory.memoryId),
      ).rejects.toThrow("memory_source_denied");
    } finally {
      await f.store.close();
    }
  },
);

it("preserves the source dependency through explicit supersession", async () => {
  const f = await fixture();
  try {
    const original = await f.store.learning.promoteCandidate(
      { caller: f.caller },
      await f.importSource(),
    );
    const replacement = await f.store.learning.supersedeMemory(
      { caller: f.caller },
      original.memoryId,
      { ...f.base, statement: "Explicitly corrected orchard" },
    );
    await f.policy(false);
    await expect(
      f.store.learning.getMemory({ caller: f.caller }, replacement.memoryId),
    ).rejects.toThrow("memory_source_denied");
  } finally {
    await f.store.close();
  }
});

it("keeps trusted literal current-message capture source-free without declassifying an older duplicate", async () => {
  const f = await fixture(":memory:", "请记住，Independent literal fact");
  try {
    await f.importSource();
    const independent = await f.store.learning.captureCurrentMessage(f.context);
    expect(independent?.statement).toBe("Independent literal fact");
    const old = await f.store.learning.createCandidate(f.context, {
      candidateKind: "derived",
      subject: f.base.subject,
      scope: f.base.scope,
      proposedType: f.base.type,
      statement: "Duplicate literal fact",
      content: { statement: "Duplicate literal fact", privateExtra: "Protected orchard detail" },
      source: { kind: "human", ref: "model-claimed-user" },
      sourceEvidence: [],
      mergeHint: { strategy: "manual_review_required" },
      extensions: {},
    });
    const duplicateRun = await f.store.conversations.acceptIncoming({
      agentId: "personal",
      scope: f.scope,
      messageId: "literal",
      text: "请记住，Duplicate literal fact",
      executionRef: "fake",
    });
    const reused = await f.store.learning.captureCurrentMessage({
      caller: f.caller,
      conversationId: duplicateRun.conversation.id,
      runId: duplicateRun.run.id,
    });
    expect(reused?.candidateId).toBe(old.candidateId);
    await f.policy(false);
    expect(
      await f.store.learning.getCandidate({ caller: f.caller }, independent!.candidateId),
    ).toMatchObject({ statement: "Independent literal fact" });
    await expect(
      f.store.learning.getCandidate({ caller: f.caller }, old.candidateId),
    ).rejects.toThrow("memory_source_denied");
  } finally {
    await f.store.close();
  }
});

it.each(["malformed", "missing"] as const)(
  "fails closed for %s server-owned dependency state without exposing content",
  async (kind) => {
    const f = await fixture();
    try {
      const candidate = await f.importSource();
      await f.store.db.transaction((tx) =>
        tx.execute({
          sql: "UPDATE memory_candidates SET source_dependencies_json = ? WHERE id = ?",
          args: [
            kind === "malformed"
              ? "not-json"
              : JSON.stringify({ version: 1, decisionIds: ["missing-receipt"] }),
            candidate,
          ],
        }),
      );
      await expect(f.store.learning.getCandidate({ caller: f.caller }, candidate)).rejects.toThrow(
        "memory_source_provenance_unavailable",
      );
      expect(await f.store.learning.listCandidates({ caller: f.caller })).toEqual([]);
      const rows = await f.store.db.transaction((tx) =>
        tx.execute({
          sql: "SELECT statement FROM memory_candidates WHERE id = ?",
          args: [candidate],
        }),
      );
      expect(rows.rows[0]?.statement).toBe("Protected orchard history fact.");
    } finally {
      await f.store.close();
    }
  },
);

it("does not trust model-authored legacy audit lineage or confirmation flags", async () => {
  const f = await fixture();
  try {
    const unrelated = await f.store.learning.writeExplicit(
      { caller: f.caller },
      { ...f.base, statement: "Provably explicit user fact" },
    );
    const candidate = await f.store.learning.createCandidate(
      { caller: f.caller },
      {
        candidateKind: "assertion",
        subject: f.base.subject,
        scope: f.base.scope,
        proposedType: f.base.type,
        statement: "Unknown older model content",
        content: { statement: "Unknown older model content" },
        source: { kind: "human", ref: unrelated.memoryId },
        sourceEvidence: [
          {
            evidenceId: crypto.randomUUID(),
            kind: "user_confirmation",
            ref: unrelated.derivedFrom[0]!,
            capturedAt: new Date().toISOString(),
            trustLevel: "high",
          },
        ],
        mergeHint: { strategy: "manual_review_required" },
        extensions: { confirmedByUser: true },
      },
    );
    await f.store.db.transaction((tx) =>
      tx.execute({
        sql: "UPDATE memory_candidates SET source_dependencies_json = NULL WHERE id = ?",
        args: [candidate.candidateId],
      }),
    );
    await expect(
      f.store.learning.getCandidate({ caller: f.caller }, candidate.candidateId),
    ).rejects.toThrow("memory_source_provenance_unavailable");
    expect(await f.store.learning.getMemory({ caller: f.caller }, unrelated.memoryId)).toBeTruthy();
  } finally {
    await f.store.close();
  }
});

it("does not declassify a legacy model candidate reused by a later literal capture", async () => {
  const f = await fixture();
  try {
    await f.importSource();
    const candidate = await f.store.learning.createCandidate(f.context, {
      candidateKind: "derived",
      subject: f.base.subject,
      scope: f.base.scope,
      proposedType: f.base.type,
      statement: "Duplicate literal fact",
      content: { statement: "Duplicate literal fact", hidden: "Protected orchard detail" },
      source: { kind: "human", ref: "model-claim" },
      sourceEvidence: [],
      mergeHint: { strategy: "manual_review_required" },
      extensions: {},
    });
    const literal = await f.store.conversations.acceptIncoming({
      agentId: "personal",
      scope: f.scope,
      messageId: "legacy-literal",
      text: "请记住，Duplicate literal fact",
      executionRef: "fake",
    });
    const captured = await f.store.learning.captureCurrentMessage({
      caller: f.caller,
      conversationId: literal.conversation.id,
      runId: literal.run.id,
    });
    expect(captured!.candidateId).toBe(candidate.candidateId);
    await f.store.db.transaction((tx) =>
      tx.execute({
        sql: "UPDATE memory_candidates SET source_dependencies_json = NULL WHERE id = ?",
        args: [candidate.candidateId],
      }),
    );
    await f.policy(false);
    await expect(
      f.store.learning.getCandidate({ caller: f.caller }, candidate.candidateId),
    ).rejects.toThrow("memory_source_denied");
  } finally {
    await f.store.close();
  }
});

it("keeps public group Memory constrained by its exact source policy", async () => {
  const f = await fixture();
  try {
    const groupScope = { ...f.scope, chatType: "group" as const, chatId: "100" };
    const groupCaller = { principalId: "owner", scope: groupScope };
    for (const [resourceId, actions] of [
      ["agent:personal", ["run:create"]],
      ["group:100", ["history:read", "memory:candidate:write", "memory:read"]],
    ] as const)
      for (const action of actions)
        await f.store.authorization.grant({
          principalId: "owner",
          scope: groupScope,
          resourceId,
          action,
          effect: "allow",
        });
    await f.store.identities.bindOwner("owner", groupScope);
    const accepted = await f.store.conversations.acceptIncoming({
      agentId: "personal",
      scope: groupScope,
      messageId: "group-model",
      text: "Derive orchard fact",
      executionRef: "fake",
    });
    const context = {
      caller: groupCaller,
      conversationId: accepted.conversation.id,
      runId: accepted.run.id,
    };
    const { qqMemorySourceCondition } = await import("../auth/policy-condition.js");
    const decision = await f.store.authorization.check({
      ...context,
      resourceId: "group:100",
      action: "history:read",
      policyCondition: qqMemorySourceCondition(groupCaller, "qq", "100", "history"),
    });
    await f.store.authorization.markDeliverySource(decision.id, "content_source");
    const scope = { type: "group" as const, connectionId: "qq", botId: "bot", groupId: "100" };
    const candidate = await f.store.learning.createGroupCandidate(context, "group:100", {
      candidateKind: "derived",
      subject: f.base.subject,
      scope,
      proposedType: f.base.type,
      sensitivity: "public",
      statement: "Public orchard summary",
      content: { statement: "Public orchard summary" },
      source: { kind: "human", ref: "model-claim" },
      sourceEvidence: [],
      mergeHint: { strategy: "manual_review_required" },
      extensions: {},
    });
    const promoted = await f.store.learning.promoteCandidate(
      { caller: f.caller },
      candidate.candidateId,
    );
    expect(
      (await f.store.learning.listGroupMemories(context, "group:100", scope)).map(
        (row) => row.memoryId,
      ),
    ).toEqual([promoted.memoryId]);
    await f.policy(false);
    expect(await f.store.learning.listGroupMemories(context, "group:100", scope)).toEqual([]);
  } finally {
    await f.store.close();
  }
});

it.each([
  "请画一只 orchard 奶牛猫",
  "用 browser 打开 https://example.com/orchard，读取标题并截图",
  "搜索 orchard 官方博客最近的文章，核对官网来源和发布日期",
])("rechecks Memory before each provider continuation: %s", async (text) => {
  const f = await fixture();
  try {
    await f.store.learning.promoteCandidate({ caller: f.caller }, await f.importSource());
    const consumed = await consumeWithRuntime(f, undefined, text, async () => {
      await f.policy(false);
    });
    expect(consumed.prompt).toContain("Protected orchard history fact.");
    expect(consumed.calls).toBe(1);
    expect(consumed.result).toMatchObject({ status: "failed", failureCode: "gate_refused" });
  } finally {
    await f.store.close();
  }
});

it.each(["expired", "revoked", "retired"] as const)(
  "allows metadata-only %s without revealing denied source content",
  async (state) => {
    const f = await fixture();
    try {
      const memory = await f.store.learning.promoteCandidate(
        { caller: f.caller },
        await f.importSource(),
      );
      await f.policy(false);
      const result = await f.store.learning.setLifecycle(
        { caller: f.caller },
        memory.memoryId,
        state,
      );
      expect(result).toEqual({ executed: true, lifecycleState: state, contentWithheld: true });
      expect(JSON.stringify(result)).not.toContain("orchard");
      const raw = await f.store.db.transaction((tx) =>
        tx.execute({
          sql: "SELECT lifecycle_state,statement FROM memories WHERE id = ?",
          args: [memory.memoryId],
        }),
      );
      expect(raw.rows[0]).toMatchObject({
        lifecycle_state: state,
        statement: "Protected orchard history fact.",
      });
    } finally {
      await f.store.close();
    }
  },
);

it("lets the real Owner reject a revoked-source candidate with a body-free receipt", async () => {
  const f = await fixture();
  try {
    const candidateId = await f.importSource();
    await f.policy(false);
    const accepted = await f.store.conversations.acceptIncoming({
      agentId: "personal",
      scope: f.scope,
      messageId: "reject",
      text: `/memory reject ${candidateId}`,
      executionRef: "fake",
    });
    const { createOwnerMemoryTools } = await import("../runtime/pi/owner-memory-tools.js");
    const [tool] = createOwnerMemoryTools({
      store: f.store,
      getContext: () => ({
        caller: f.caller,
        conversationId: accepted.conversation.id,
        runId: accepted.run.id,
      }),
    });
    const result = await tool!.execute(
      "reject",
      { action: "reject", id: candidateId },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.details).toEqual({ executed: true, status: "rejected", contentWithheld: true });
    expect(JSON.stringify(result)).not.toContain("orchard");
    expect(JSON.stringify(result)).not.toContain(candidateId);
  } finally {
    await f.store.close();
  }
});

it("retains the Owner collection gate on a public-group read Run without making public correction content private", async () => {
  const f = await fixture();
  try {
    const scope = { type: "group" as const, connectionId: "qq", botId: "bot", groupId: "100" };
    const memory = await f.store.learning.writeExplicit(
      { caller: f.caller },
      { ...f.base, scope, sensitivity: "public", statement: "Public orchard calendar" },
    );
    await f.store.learning.getMemory(f.context, memory.memoryId);
    const corrected = await f.store.learning.supersedeMemory(f.context, memory.memoryId, {
      ...f.base,
      scope,
      statement: "Public orchard revised calendar",
    });
    const rows = await f.store.db.transaction((tx) =>
      tx.execute({
        sql: "SELECT id FROM grants WHERE resource_id = 'owner-memory' AND action = 'memory:read' AND effect = 'allow'",
        args: [],
      }),
    );
    expect(rows.rows).toHaveLength(1);
    await f.store.authorization.revoke(rows.rows[0]!.id as string);
    await expect(f.store.learning.authorizeContext(f.context, [])).rejects.toThrow(
      "memory_source_denied",
    );
    const lease = await f.store.lifecycle.claimQueuedRun(f.caller, f.accepted.run.id);
    await lease.settle("succeeded", "Public orchard revised calendar");
    await expect(
      f.store.lifecycle.createDelivery(f.caller, {
        runId: f.accepted.run.id,
        dedupKey: "public-group",
        destination: f.scope,
        payloadText: "Public orchard revised calendar",
        payloadKind: "result",
      }),
    ).rejects.toThrow();
    const groupCaller = {
      principalId: "owner",
      scope: { ...f.scope, chatType: "group" as const, chatId: "100" },
    };
    await f.store.identities.bindOwner("owner", groupCaller.scope);
    await f.store.authorization.grant({
      principalId: "owner",
      resourceId: "group:100",
      action: "memory:read",
      scope: groupCaller.scope,
      effect: "allow",
    });
    expect(
      (await f.store.learning.listGroupMemories({ caller: groupCaller }, "group:100", scope)).map(
        (row) => row.memoryId,
      ),
    ).toEqual([corrected.memoryId]);
  } finally {
    await f.store.close();
  }
});

it.each(["private", "mixed"] as const)(
  "does not exempt %s Owner reads from durable source dependencies",
  async (mode) => {
    const f = await fixture();
    try {
      const scope = { type: "group" as const, connectionId: "qq", botId: "bot", groupId: "100" };
      await f.store.learning.writeExplicit(
        { caller: f.caller },
        { ...f.base, statement: "Private orchard detail", sensitivity: "confidential" },
      );
      if (mode === "mixed")
        await f.store.learning.writeExplicit(
          { caller: f.caller },
          { ...f.base, scope, statement: "Public orchard detail", sensitivity: "public" },
        );
      await f.store.learning.listMemories(f.context);
      const candidate = await f.store.learning.createCandidate(f.context, {
        candidateKind: "derived",
        subject: f.base.subject,
        scope,
        proposedType: f.base.type,
        statement: "Purportedly public orchard inference",
        content: { statement: "Purportedly public orchard inference" },
        source: { kind: "human", ref: "model-claim" },
        sourceEvidence: [],
        sensitivity: "public",
        mergeHint: { strategy: "manual_review_required" },
        extensions: {},
      });
      await f.store.learning.promoteCandidate({ caller: f.caller }, candidate.candidateId);
      const groupCaller = {
        principalId: "owner",
        scope: { ...f.scope, chatType: "group" as const, chatId: "100" },
      };
      await f.store.identities.bindOwner("owner", groupCaller.scope);
      await f.store.authorization.grant({
        principalId: "owner",
        resourceId: "group:100",
        action: "memory:read",
        scope: groupCaller.scope,
        effect: "allow",
      });
      const visible = await f.store.learning.listGroupMemories(
        { caller: groupCaller },
        "group:100",
        scope,
      );
      expect(
        visible.some((row) => row.content.statement === "Purportedly public orchard inference"),
      ).toBe(false);
      const sources = await f.store.db.transaction((tx) =>
        tx.execute({
          sql: "SELECT delivery_source FROM authorization_decisions WHERE run_id = ? AND resource_id = 'owner-memory' AND action = 'memory:read' AND delivery_source IS NOT NULL",
          args: [f.accepted.run.id],
        }),
      );
      expect(sources.rows.some((row) => row.delivery_source === "content_source")).toBe(true);
    } finally {
      await f.store.close();
    }
  },
);

it("allows unknown-provenance rejection but still requires the current governance grant", async () => {
  const f = await fixture();
  try {
    const candidateId = await f.importSource();
    await f.store.db.transaction((tx) =>
      tx.execute({
        sql: "UPDATE memory_candidates SET source_dependencies_json = 'corrupt' WHERE id = ?",
        args: [candidateId],
      }),
    );
    expect(await f.store.learning.rejectCandidate({ caller: f.caller }, candidateId)).toEqual({
      executed: true,
      status: "rejected",
      contentWithheld: true,
    });
    const other = await f.importSource("notice");
    const grants = await f.store.db.transaction((tx) =>
      tx.execute(
        "SELECT id FROM grants WHERE resource_id = 'owner-memory' AND action = 'memory:govern'",
      ),
    );
    for (const grant of grants.rows) await f.store.authorization.revoke(grant.id as string);
    await expect(f.store.learning.rejectCandidate({ caller: f.caller }, other)).rejects.toThrow(
      "Permission denied",
    );
    const row = await f.store.db.transaction((tx) =>
      tx.execute({ sql: "SELECT status FROM memory_candidates WHERE id = ?", args: [other] }),
    );
    expect(row.rows[0]?.status).toBe("pending");
  } finally {
    await f.store.close();
  }
});

it("preserves public group collection receipts through Task completion reauthorization", async () => {
  const f = await fixture();
  try {
    const scope = { type: "group" as const, connectionId: "qq", botId: "bot", groupId: "100" };
    const memory = await f.store.learning.writeExplicit(
      { caller: f.caller },
      { ...f.base, scope, sensitivity: "public", statement: "Public orchard Task fact" },
    );
    await f.store.learning.getMemory(f.context, memory.memoryId);
    const task = await f.store.tasks.createTask({
      title: "Public orchard Task",
      creatorPrincipalId: "owner",
      runId: f.accepted.run.id,
      authorizationScope: f.scope,
    });
    await f.store.authorization.grant({
      principalId: "owner",
      resourceId: `task-${task.id}`,
      action: "task:read",
      scope: f.scope,
      effect: "allow",
    });
    const { AuthorizedOpsService } = await import("../ops/service.js");
    const { FakeHerdrBridge } = await import("../ops/fake-herdr-bridge.js");
    const service = new AuthorizedOpsService(f.store, new FakeHerdrBridge());
    expect(await service.get(f.caller, task.id)).toMatchObject({ title: "Public orchard Task" });
    const grants = await f.store.db.transaction((tx) =>
      tx.execute(
        "SELECT id FROM grants WHERE resource_id = 'owner-memory' AND action = 'memory:read'",
      ),
    );
    for (const grant of grants.rows) await f.store.authorization.revoke(grant.id as string);
    await expect(service.get(f.caller, task.id)).rejects.toMatchObject({
      decision: { reason: "no_grant" },
    });
  } finally {
    await f.store.close();
  }
});

it("validates raw imports with empty optional archive metadata without inventing evidence", async () => {
  const f = await fixture();
  try {
    const { ChannelArchiveStore } = await import("../retrieval/channel-archive.js");
    await new ChannelArchiveStore(f.store.db).ingest({
      channel: "qq",
      connectionId: "qq",
      groupId: "100",
      sourceClass: "notice",
      externalMessageId: "",
      senderId: "",
      normalizedText: "Optional orchard metadata body.",
      occurredAt: "2026-09-22T10:00:00Z",
    });
    const candidate = await f.store.learning.getCandidate(
      { caller: f.caller },
      await f.importSource("notice"),
    );
    expect(candidate).toMatchObject({ statement: "Optional orchard metadata body." });
    expect(candidate!.sourceEvidence[0]!.metadata).not.toHaveProperty("senderId");
    expect(candidate!.sourceEvidence[0]!.metadata).not.toHaveProperty("externalMessageId");
  } finally {
    await f.store.close();
  }
});

it("does not let a read completion caller downgrade an ordinary Memory source into a public access gate", async () => {
  const f = await fixture();
  try {
    const request = {
      ...f.context,
      resourceId: "owner-memory",
      action: "memory:read",
      policyCondition: { version: 1, kind: "none" } as const,
    };
    const decision = await f.store.authorization.check(request);
    await expect(
      f.store.authorization.authorizeReadResults([
        { request, decisionId: decision.id, source: "access_gate" },
      ]),
    ).rejects.toMatchObject({ decision: { reason: "source_read_unverified" } });
    await f.store.authorization.markDeliverySource(decision.id, "content_source");
    await expect(
      f.store.authorization.authorizeReadResults([
        { request, decisionId: decision.id, source: "access_gate" },
      ]),
    ).rejects.toMatchObject({ decision: { reason: "source_read_unverified" } });
  } finally {
    await f.store.close();
  }
});

it("authorizes known Memory metadata before fetching or parsing denied bodies", async () => {
  const f = await fixture();
  try {
    const memory = await f.store.learning.promoteCandidate(
      { caller: f.caller },
      await f.importSource(),
    );
    const pending = await f.importSource("notice");
    await f.store.db.transaction(async (tx) => {
      await tx.execute({
        sql: "UPDATE memories SET content_json = 'invalid-protected-body' WHERE id = ?",
        args: [memory.memoryId],
      });
      await tx.execute({
        sql: "UPDATE memory_candidates SET content_json = 'invalid-protected-body' WHERE id = ?",
        args: [pending],
      });
    });
    await f.policy(false, false);
    const original = f.store.db.transaction.bind(f.store.db);
    const bodyQueries: string[] = [];
    const spy = vi.spyOn(f.store.db, "transaction").mockImplementation((operation) =>
      original(async (tx) =>
        operation(
          new Proxy(tx, {
            get(target, key) {
              if (key === "execute")
                return async (statement: Parameters<typeof tx.execute>[0]) => {
                  const sql = typeof statement === "string" ? statement : statement.sql;
                  if (/SELECT \* FROM (memories|memory_candidates)\b/iu.test(sql))
                    bodyQueries.push(sql);
                  return target.execute(statement);
                };
              const value: unknown = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        ),
      ),
    );
    try {
      expect(await f.store.learning.listMemories({ caller: f.caller })).toEqual([]);
      expect(await f.store.learning.listCandidates({ caller: f.caller })).toEqual([]);
      await expect(
        f.store.learning.getMemory({ caller: f.caller }, memory.memoryId),
      ).rejects.toThrow("memory_source_denied");
      await expect(f.store.learning.getCandidate({ caller: f.caller }, pending)).rejects.toThrow(
        "memory_source_denied",
      );
      expect(bodyQueries).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  } finally {
    await f.store.close();
  }
});

it("keeps the group eligibility cutoff stable while skipping a denied page", async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = new Date("2026-10-01T00:00:00.000Z");
  vi.setSystemTime(start);
  try {
    const protectedMemory = await f.store.learning.promoteCandidate(
      { caller: f.caller },
      await f.importSource(),
    );
    const scope = { type: "group" as const, connectionId: "qq", botId: "bot", groupId: "100" };
    const eligible = await f.store.learning.writeExplicit(
      { caller: f.caller },
      { ...f.base, scope, sensitivity: "public", statement: "Still eligible orchard fact" },
    );
    await f.store.db.transaction(async (tx) => {
      const source = (
        await tx.execute({
          sql: "SELECT source_dependencies_json FROM memories WHERE id = ?",
          args: [protectedMemory.memoryId],
        })
      ).rows[0]!.source_dependencies_json;
      const columns = (await tx.execute("PRAGMA table_info(memories)")).rows.map((row) => {
        if (typeof row.name !== "string") throw new Error("Invalid fixture schema column");
        return row.name;
      });
      const expressions = columns.map((column) =>
        column === "id"
          ? "'page-' || seq.n"
          : column === "signature"
            ? "'page-signature-' || seq.n"
            : column === "expires_at"
              ? "'2026-10-01T00:00:01.000Z'"
              : column === "source_dependencies_json"
                ? "?"
                : `m.${column}`,
      );
      await tx.execute({
        sql: `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<128) INSERT INTO memories (${columns.join(",")}) SELECT ${expressions.join(",")} FROM memories m CROSS JOIN seq WHERE m.id = ?`,
        args: [source!, eligible.memoryId],
      });
      await tx.execute({
        sql: "UPDATE memories SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
        args: [eligible.memoryId],
      });
    });
    await f.policy(false);
    const groupCaller = {
      principalId: "owner",
      scope: { ...f.scope, chatType: "group" as const, chatId: "100" },
    };
    await f.store.identities.bindOwner("owner", groupCaller.scope);
    for (const action of ["memory:read", "history:read"])
      await f.store.authorization.grant({
        principalId: "owner",
        resourceId: "group:100",
        action,
        scope: groupCaller.scope,
        effect: "allow",
      });
    const original = f.store.db.transaction.bind(f.store.db);
    let pages = 0;
    const spy = vi.spyOn(f.store.db, "transaction").mockImplementation((operation) =>
      original(async (tx) =>
        operation(
          new Proxy(tx, {
            get(target, key) {
              if (key === "execute")
                return async (statement: Parameters<typeof tx.execute>[0]) => {
                  const sql = typeof statement === "string" ? statement : statement.sql;
                  const result = await target.execute(statement);
                  if (sql.startsWith("SELECT id FROM memories WHERE scope_json") && ++pages === 1)
                    vi.setSystemTime(new Date(start.getTime() + 2_000));
                  return result;
                };
              const value: unknown = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        ),
      ),
    );
    try {
      const result = await f.store.learning.listGroupMemories(
        { caller: groupCaller },
        "group:100",
        scope,
        1,
      );
      expect(pages).toBe(2);
      expect(result.map((row) => row.memoryId)).toEqual([eligible.memoryId]);
    } finally {
      spy.mockRestore();
    }
  } finally {
    await f.store.close();
    vi.useRealTimers();
  }
});

it.each(["workspace:read", "workspace:write", "skill:read", "model:switch"])(
  "does not infer source-free legacy model provenance from an unmarked %s result",
  async (action) => {
    const f = await fixture();
    try {
      const resourceId = action.startsWith("workspace:")
        ? "workspace:fixture"
        : action === "model:switch"
          ? "owner-control"
          : "legacy-fixture-source";
      await f.store.authorization.registerResource({
        id: resourceId,
        kind: action.startsWith("workspace:")
          ? "workspace"
          : action === "model:switch"
            ? "owner-control"
            : "skill",
        visibility: "private",
        ownerId: "owner",
      });
      const grantId = await f.store.authorization.grant({
        principalId: "owner",
        scope: f.scope,
        resourceId,
        action,
        effect: "allow",
      });
      const read = await f.store.authorization.check({ ...f.context, resourceId, action });
      const candidate = await f.store.learning.createCandidate(f.context, {
        candidateKind: "derived",
        subject: f.base.subject,
        scope: f.base.scope,
        proposedType: f.base.type,
        statement: "Old protected result fixture",
        content: { statement: "Old protected result fixture" },
        source: { kind: "human", ref: "model-claimed-origin" },
        sourceEvidence: [],
        mergeHint: { strategy: "manual_review_required" },
        extensions: {},
      });
      const explicit = await f.store.learning.writeExplicit(f.context, {
        ...f.base,
        statement: "Independent explicit user fixture",
      });
      await f.store.db.transaction(async (tx) => {
        await tx.execute({
          sql: "UPDATE authorization_decisions SET delivery_source = NULL, policy_condition_json = NULL WHERE id = ?",
          args: [read.id],
        });
        await tx.execute("UPDATE memory_candidates SET source_dependencies_json = NULL");
        await tx.execute("UPDATE memories SET source_dependencies_json = NULL");
      });
      await f.store.authorization.revoke(grantId);
      await expect(
        f.store.learning.getCandidate({ caller: f.caller }, candidate.candidateId),
      ).rejects.toThrow("memory_source_provenance_unavailable");
      expect(
        await f.store.learning.getMemory({ caller: f.caller }, explicit.memoryId),
      ).toMatchObject({ content: { statement: "Independent explicit user fixture" } });
    } finally {
      await f.store.close();
    }
  },
);

it.each(["admission", "neighbor-resource", "neighbor-action", "neighbor-scope"])(
  "bounds the legacy admission-only exemption: %s",
  async (variant) => {
    const f = await fixture();
    try {
      const resourceId = variant === "neighbor-resource" ? "agent:other" : "agent:personal";
      const action = variant === "neighbor-action" ? "history:read" : "conversation:read";
      if (variant === "neighbor-resource")
        await f.store.authorization.registerResource({
          id: resourceId,
          kind: "agent",
          visibility: "private",
          ownerId: "owner",
        });
      await f.store.authorization.grant({
        principalId: "owner",
        scope: f.scope,
        resourceId,
        action,
        effect: "allow",
      });
      const decision = await f.store.authorization.check({ ...f.context, resourceId, action });
      const candidate = await f.store.learning.createCandidate(f.context, {
        candidateKind: "derived",
        subject: f.base.subject,
        scope: f.base.scope,
        proposedType: f.base.type,
        statement: "Admission-only fixture",
        content: { statement: "Admission-only fixture" },
        source: { kind: "human", ref: "model-claim" },
        sourceEvidence: [],
        mergeHint: { strategy: "manual_review_required" },
        extensions: {},
      });
      await f.store.db.transaction(async (tx) => {
        await tx.execute({
          sql: "UPDATE memory_candidates SET source_dependencies_json=NULL WHERE id=?",
          args: [candidate.candidateId],
        });
        if (variant === "neighbor-scope")
          await tx.execute({
            sql: "UPDATE authorization_decisions SET scope_key='different-scope' WHERE id=?",
            args: [decision.id],
          });
      });
      const value = f.store.learning.getCandidate({ caller: f.caller }, candidate.candidateId);
      if (variant === "admission")
        await expect(value).resolves.toMatchObject({ statement: "Admission-only fixture" });
      else await expect(value).rejects.toThrow("memory_source_provenance_unavailable");
    } finally {
      await f.store.close();
    }
  },
);
