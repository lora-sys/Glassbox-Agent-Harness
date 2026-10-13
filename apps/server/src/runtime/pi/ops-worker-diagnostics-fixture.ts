import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDomainStore } from "../../persistence/index.js";
import { FakeHerdrBridge } from "../../ops/fake-herdr-bridge.js";
import { AuthorizedOpsService } from "../../ops/service.js";
import { createOpsTools } from "./ops-tools.js";

export const opsWorkerDiagnosticsFixtureScript = new URL(import.meta.url);

async function runFixture() {
  const directory = process.argv[2];
  assert.ok(directory);
  const root = join(directory, "project");
  const data = join(directory, "data");
  await mkdir(root, { recursive: true });
  await mkdir(data, { recursive: true });
  const store = await openDomainStore({ databasePath: join(data, "glassbox.db") });
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
    await store.identities.bindOwner(caller.principalId, caller.scope);
    await store.conversations.createAgent("personal");
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "agent:personal",
      action: "run:create",
      scope: caller.scope,
      effect: "allow",
    });
    const incoming = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: caller.scope,
      messageId: "worker-diagnostic",
      text: "Check Worker",
      executionRef: "pi:test",
    });
    const task = await store.tasks.createTask({
      title: "Fixture",
      creatorPrincipalId: caller.principalId,
      authorizationScope: caller.scope,
    });
    for (const action of ["task:delegate", "worker:status", "worker:read"])
      await store.authorization.grant({
        principalId: caller.principalId,
        resourceId: `task-${task.id}`,
        action,
        scope: caller.scope,
        effect: "allow",
      });
    const bridge = new FakeHerdrBridge();
    let startCalls = 0;
    const originalStartAgent = bridge.startAgent.bind(bridge);
    bridge.startAgent = async (...args) => {
      startCalls += 1;
      return originalStartAgent(...args);
    };
    const service = new AuthorizedOpsService(store, bridge, {
      databasePath: join(data, "glassbox.db"),
      contextDirectory: join(data, "worker-contexts"),
      resourceId: "worker-workspace:new-configured-target",
    });
    const result = await service.delegate(caller, {
      taskId: task.id,
      workspaceId: "configured",
      agentKind: "pi",
      worktreePath: root,
      prompt: "Write one file",
    });
    assert.partialDeepStrictEqual(result, {
      status: "FAILED",
      dispatchFailure: { phase: "worker_context", code: "worker_file_authority_missing" },
    });
    assert.equal(startCalls, 0);
    const trace = await store.tasks.listTraceEvents({ taskId: task.id });
    assert.ok(
      trace.some(
        (event) =>
          event.type === "task.status_changed" &&
          JSON.stringify(event.data).includes("worker_file_authority_missing"),
      ),
    );
    assert.ok(!JSON.stringify(trace).includes(directory));
    const tools = createOpsTools({
      store,
      service,
      getContext: () => ({
        caller,
        runId: incoming.run.id,
        conversationId: incoming.conversation.id,
      }),
      workerTarget: { workspaceId: "configured", agentKind: "pi", worktreePath: root },
    });
    for (const name of ["worker_status", "worker_read"]) {
      const tool = tools.find((item) => item.name === name);
      assert.ok(tool);
      await assert.rejects(
        tool.execute("read", { taskId: task.id }, undefined, undefined, {} as never),
        { message: "worker_not_started" },
      );
    }
  } finally {
    await store.close();
  }
  console.log(JSON.stringify({ completed: true }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await runFixture();
