import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sourcePolicyFixture } from "./source-policy-test-fixture.js";
import { openDomainStore } from "../persistence/index.js";
import { archiveDecisionBatch } from "../persistence/decision-archive.js";
import { CURRENT_SCHEMA_VERSION } from "../persistence/schema.js";

export const sourcePolicyReopenFixtureScript = new URL(import.meta.url);
async function runFixture() {
  const [databasePath, phase, scenario] = process.argv.slice(2);
  assert.ok(databasePath && phase && scenario);
  const statePath = `${databasePath}.json`;
  if (phase === "prepare") {
    const f = await sourcePolicyFixture(databasePath);
    try {
      const pending = await f.importSource("notice");
      const protectedMemory = await f.store.learning.promoteCandidate(
        { caller: f.caller },
        await f.importSource(),
      );
      const explicit = await f.store.learning.writeExplicit(
        { caller: f.caller },
        { ...f.base, statement: "Trusted unrelated user fact" },
      );
      const superseded = await f.store.learning.supersedeMemory(
        { caller: f.caller },
        explicit.memoryId,
        { ...f.base, statement: "Trusted explicitly corrected fact" },
      );
      const ambiguous = await f.store.learning.createCandidate(
        { caller: f.caller },
        {
          candidateKind: "derived",
          subject: f.base.subject,
          scope: f.base.scope,
          proposedType: f.base.type,
          statement: "Ambiguous old model origin",
          content: { statement: "Ambiguous old model origin" },
          source: { kind: "human", ref: "model-editable-claim" },
          sourceEvidence: [],
          mergeHint: { strategy: "manual_review_required" },
          extensions: { confirmedByUser: true },
        },
      );
      const lease = await f.store.lifecycle.claimQueuedRun(f.caller, f.accepted.run.id);
      await lease.settle("succeeded", "Source fixture complete");
      const legacy: Array<{ id: string; marked: boolean }> = [];
      if (scenario === "upgrade") {
        for (const [action, marked] of [
          ["workspace:read", false],
          ["workspace:write", false],
          ["skill:read", false],
          ["model:switch", false],
          ["workspace:write", true],
          ["model:switch", true],
        ] as const) {
          const resourceId = action.startsWith("workspace:")
            ? "workspace:legacy"
            : action === "model:switch"
              ? "owner-control"
              : "skill:legacy";
          await f.store.authorization.registerResource({
            id: resourceId,
            kind: action.startsWith("workspace:")
              ? "workspace"
              : action === "model:switch"
                ? "owner-control"
                : "skill",
            visibility: "private",
            ownerId: "owner",
            ifAbsent: true,
          });
          const grantId = await f.store.authorization.grant({
            principalId: "owner",
            scope: f.scope,
            resourceId,
            action,
            effect: "allow",
          });
          const admitted = await f.store.conversations.acceptIncoming({
            agentId: "personal",
            scope: f.scope,
            messageId: `legacy-${action}-${marked}`,
            text: "Legacy source fixture",
            executionRef: "fake",
          });
          const context = {
            caller: f.caller,
            runId: admitted.run.id,
            conversationId: admitted.conversation.id,
          };
          const request = { ...context, resourceId, action, policyCondition: null };
          const decision = await f.store.authorization.check(request);
          if (marked) {
            await f.store.authorization.markDeliverySource(decision.id, "content_source");
            // A same-shape preflight is covered by a valid producer marker, not mistaken
            // for another missing source. Its original NULL policy provenance is retained.
            await f.store.authorization.check(request);
          }
          const candidate = await f.store.learning.createCandidate(context, {
            candidateKind: "derived",
            subject: f.base.subject,
            scope: f.base.scope,
            proposedType: f.base.type,
            statement: `Legacy ${action} ${marked} fixture`,
            content: { statement: `Legacy ${action} ${marked} fixture` },
            source: { kind: "human", ref: "model-claimed-origin" },
            sourceEvidence: [],
            mergeHint: { strategy: "manual_review_required" },
            extensions: {},
          });
          legacy.push({ id: candidate.candidateId, marked });
          if (!marked) await f.store.authorization.revoke(grantId);
          const runLease = await f.store.lifecycle.claimQueuedRun(f.caller, admitted.run.id);
          await runLease.settle("succeeded", "Legacy source fixture settled");
        }
      }
      assert.ok(await archiveDecisionBatch(f.store.db, "9999-01-01T00:00:00.000Z"));
      if (scenario === "upgrade") {
        await f.store.db.transaction(async (tx) => {
          await tx.execute("ALTER TABLE memory_candidates DROP COLUMN source_dependencies_json");
          await tx.execute("ALTER TABLE memories DROP COLUMN source_dependencies_json");
          await tx.execute("PRAGMA user_version = 26");
        });
      }
      await writeFile(
        statePath,
        JSON.stringify({
          caller: f.caller,
          pending,
          protectedMemory: protectedMemory.memoryId,
          explicit: explicit.memoryId,
          superseded: superseded.memoryId,
          ambiguous: ambiguous.candidateId,
          legacy,
        }),
      );
    } finally {
      await f.store.close();
    }
  } else if (phase === "verify") {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    const store = await openDomainStore({ databasePath });
    try {
      assert.equal(
        (await store.db.transaction((tx) => tx.execute("PRAGMA user_version"))).rows[0]
          ?.user_version,
        CURRENT_SCHEMA_VERSION,
      );
      for (const entry of state.legacy as Array<{ id: string; marked: boolean }>) {
        const value = store.learning.getCandidate({ caller: state.caller }, entry.id);
        if (entry.marked) assert.ok(await value);
        else await assert.rejects(value, /memory_source_provenance_unavailable/u);
      }
      // Fresh state and trusted legacy explicit-write ancestry both remain source-free.
      assert.equal(
        (await store.learning.getMemory({ caller: state.caller }, state.explicit))?.content
          .statement,
        "Trusted unrelated user fact",
      );
      assert.equal(
        (await store.learning.getMemory({ caller: state.caller }, state.superseded))?.content
          .statement,
        "Trusted explicitly corrected fact",
      );
      assert.ok(await store.learning.getMemory({ caller: state.caller }, state.protectedMemory));
      assert.ok(await store.learning.getCandidate({ caller: state.caller }, state.pending));
      await store.capabilities.write({
        connectionId: "qq",
        groupId: "100",
        principalId: "owner",
        policy: { categories: {}, memorySources: {} },
      });
      await assert.rejects(
        store.learning.getMemory({ caller: state.caller }, state.protectedMemory),
        /memory_source_denied/u,
      );
      await assert.rejects(
        store.learning.getCandidate({ caller: state.caller }, state.pending),
        /memory_source_denied/u,
      );
      if (scenario === "upgrade") {
        await assert.rejects(
          store.learning.getCandidate({ caller: state.caller }, state.ambiguous),
          /memory_source_provenance_unavailable/u,
        );
        const retained = await store.db.transaction((tx) =>
          tx.execute({
            sql: "SELECT statement,source_dependencies_json FROM memory_candidates WHERE id = ?",
            args: [state.ambiguous],
          }),
        );
        assert.equal(retained.rows[0]?.statement, "Ambiguous old model origin");
        assert.equal(retained.rows[0]?.source_dependencies_json, null);
      }
      await store.db.transaction(async (tx) => {
        assert.equal((await tx.execute("PRAGMA integrity_check")).rows[0]?.integrity_check, "ok");
        assert.deepEqual((await tx.execute("PRAGMA foreign_key_check")).rows, []);
      });
    } finally {
      await store.close();
    }
  } else if (phase === "reopen") {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    const store = await openDomainStore({ databasePath });
    try {
      await assert.rejects(
        store.learning.getMemory({ caller: state.caller }, state.protectedMemory),
        /memory_source_denied/u,
      );
      assert.ok(await store.learning.getMemory({ caller: state.caller }, state.explicit));
      for (const entry of state.legacy as Array<{ id: string; marked: boolean }>) {
        const value = store.learning.getCandidate({ caller: state.caller }, entry.id);
        if (entry.marked) assert.ok(await value);
        else await assert.rejects(value, /memory_source_provenance_unavailable/u);
      }
    } finally {
      await store.close();
    }
  } else assert.fail(`Unknown phase: ${phase}`);
  console.log(JSON.stringify({ phase, scenario }));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await runFixture();
