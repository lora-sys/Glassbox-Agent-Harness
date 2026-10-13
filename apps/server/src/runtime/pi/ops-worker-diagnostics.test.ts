import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vite-plus/test";
import { openDomainStore } from "../../persistence/index.js";
import { FakeHerdrBridge } from "../../ops/fake-herdr-bridge.js";
import { AuthorizedOpsService } from "../../ops/service.js";
import { createOpsTools } from "./ops-tools.js";

it("explains an ungranted configured Worker workspace without leaking paths or inventing a running Worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-worker-diagnostic-"));
  const root = join(directory, "project");
  const data = join(directory, "data");
  await mkdir(root);
  await mkdir(data);
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
    const start = vi.spyOn(bridge, "startAgent");
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
    expect(result).toMatchObject({
      status: "FAILED",
      dispatchFailure: { phase: "worker_context", code: "worker_file_authority_missing" },
    });
    expect(start).not.toHaveBeenCalled();
    const trace = await store.tasks.listTraceEvents({ taskId: task.id });
    expect(trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "task.status_changed",
          data: expect.objectContaining({
            failure: expect.objectContaining({ code: "worker_file_authority_missing" }),
          }),
        }),
      ]),
    );
    expect(JSON.stringify(trace)).not.toContain(directory);
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
    for (const name of ["worker_status", "worker_read"])
      await expect(
        tools
          .find((tool) => tool.name === name)!
          .execute("read", { taskId: task.id }, undefined, undefined, {} as never),
      ).rejects.toThrow("worker_not_started");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});
