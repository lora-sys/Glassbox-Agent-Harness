import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { openDomainStore } from "../application/domain-store.js";
import { createOwnerMemoryTools } from "../runtime/pi/owner-memory-tools.js";
import { memoryFixture } from "./memory-test-fixture.js";

export const memoryReopenFixtureScript = new URL(import.meta.url);

async function runFixture() {
  const [databasePath, scenario, mode, sensitivity] = process.argv.slice(2);
  assert.ok(databasePath);
  assert.ok(scenario);
  const start = new Date("2026-10-01T00:00:00.000Z");
  if (scenario !== "sensitivity") mock.timers.enable({ apis: ["Date"], now: start });
  const f = await memoryFixture(databasePath);
  try {
    if (scenario === "sensitivity") {
      assert.ok(mode === "explicit" || mode === "candidate");
      assert.ok(sensitivity === "public" || sensitivity === "confidential");
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
        assert.notStrictEqual(candidate, undefined);
        await f.store.learning.promoteCandidate(f.context, candidate!.candidateId);
      } else assert.partialDeepStrictEqual(result.details, { sensitivity });
      await f.store.close();
      f.store = await openDomainStore({ databasePath });
      const rows = await f.store.learning.listGroupMemories(
        f.groupContext,
        "group:100",
        f.groupScope,
      );
      assert.deepStrictEqual(
        rows.map((row) => row.content.statement),
        sensitivity === "public" ? ["Meeting Tuesday"] : [],
      );
      const [replacement] = await f.store.learning.listMemories(f.context, { scope: f.groupScope });
      assert.partialDeepStrictEqual(replacement, {
        sensitivity,
        scope: f.groupScope,
        content: { statement: "Meeting Tuesday" },
        supersedes: [original.memoryId],
      });
      assert.deepStrictEqual(replacement?.supersedes, [original.memoryId]);
      assert.strictEqual(
        (await f.store.learning.getMemory(f.context, original.memoryId))?.lifecycleState,
        "retired",
      );
    } else if (scenario === "stale") {
      const state = mode;
      assert.ok(
        state && ["superseded", "expired", "revoked", "retired", "missing"].includes(state),
      );
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
      else if (state === "expired") mock.timers.setTime(start.getTime() + 1_000);
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
      await assert.rejects(f.store.learning.promoteCandidate(f.context, candidate.candidateId), {
        message: "memory_not_active",
      });
      await f.store.close();
      f.store = await openDomainStore({ databasePath });
      assert.strictEqual(
        (await f.store.learning.getCandidate(f.context, candidate.candidateId))?.status,
        "pending",
      );
      const active = await f.store.learning.listMemories(f.context);
      assert.deepStrictEqual(
        active.map((row) => row.content.statement),
        state === "superseded" ? ["Launch Wednesday"] : [],
      );
      assert.strictEqual(
        (await f.store.learning.listMemories(f.context, { includeInactive: true })).length,
        state === "missing" ? 0 : state === "superseded" ? 2 : 1,
      );
    } else if (scenario === "retention") {
      assert.ok(mode === "explicit" || mode === "candidate");
      const original = await f.store.learning.writeExplicit(f.context, {
        ...f.base,
        statement: "Temporary Monday fact",
        ttlSeconds: 60,
        retentionPolicy: "project-window",
      });
      mock.timers.setTime(start.getTime() + 30_000);
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
      assert.partialDeepStrictEqual(replacement, {
        ttlSeconds: original.ttlSeconds,
        expiresAt: original.expiresAt,
        retentionPolicy: original.retentionPolicy,
      });
      await f.store.close();
      f.store = await openDomainStore({ databasePath });
      assert.partialDeepStrictEqual(
        await f.store.learning.getMemory(f.context, replacement.memoryId),
        {
          ttlSeconds: original.ttlSeconds,
          expiresAt: original.expiresAt,
          retentionPolicy: original.retentionPolicy,
          lifecycleState: "active",
        },
      );
      mock.timers.setTime(start.getTime() + 60_000);
      assert.deepStrictEqual(await f.store.learning.listMemories(f.context), []);
      assert.partialDeepStrictEqual(
        await f.store.learning.getMemory(f.context, replacement.memoryId),
        { lifecycleState: "expired" },
      );
    } else assert.fail(`Unknown memory fixture scenario: ${scenario}`);
  } finally {
    await f.store.close();
    mock.timers.reset();
  }
  console.log(JSON.stringify({ completed: scenario }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await runFixture();
