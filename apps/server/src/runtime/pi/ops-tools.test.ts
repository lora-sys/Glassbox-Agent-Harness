import { expect, it } from "vite-plus/test";
import { openDomainStore } from "../../persistence/index.js";
import { FakeHerdrBridge } from "../../ops/fake-herdr-bridge.js";
import { AuthorizedOpsService } from "../../ops/service.js";
import { createOpsTools } from "./ops-tools.js";

it("denies an ungranted Pi delegate before starting any worker", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  const bridge = new FakeHerdrBridge();
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
      text: "Delegate",
      executionRef: "pi:test",
    });
    await store.authorization.registerResource({
      id: "agent-operations",
      kind: "ops",
      visibility: "public",
    });
    const tools = createOpsTools({
      store,
      service: new AuthorizedOpsService(store, bridge),
      getContext: () => ({
        caller,
        runId: accepted.run.id,
        conversationId: accepted.conversation.id,
      }),
      workerTarget: { workspaceId: "configured", agentKind: "test" },
    });
    const delegate = tools.find((tool) => tool.name === "task_delegate")!;
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        "ops_status",
        "task_list",
        "task_get",
        "task_create",
        "task_delegate",
        "worker_status",
        "worker_read",
        "worker_prompt",
        "task_accept",
        "task_rework",
        "task_cancel",
      ].sort(),
    );
    await expect(
      delegate.execute(
        "call",
        { title: "Task", prompt: "Do work" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("Permission denied: no_grant");
    expect((await bridge.getSnapshot()).workspaces).toEqual([]);
    expect(await store.tasks.listTasks()).toEqual([]);
    expect(delegate.parameters).toMatchObject({ additionalProperties: false });
    const grant = await store.authorization.grant({
      principalId: "owner",
      resourceId: "agent-operations",
      action: "task:delegate",
      scope: caller.scope,
      effect: "allow",
    });
    await delegate.execute(
      "allowed-call",
      {
        title: "Allowed task",
        prompt: "Do bounded work",
        workspaceId: "attacker",
        worktreePath: "attacker-path",
        principalId: "attacker",
      },
      undefined,
      undefined,
      {} as never,
    );
    const tasks = await store.tasks.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      creatorPrincipalId: "owner",
      runId: accepted.run.id,
      conversationId: accepted.conversation.id,
    });
    const binding = await store.tasks.getWorkerBinding(tasks[0]!.activeAttemptId!);
    expect(binding).toMatchObject({ workspaceId: "configured", agentKind: "test" });
    expect(binding?.worktreePath).not.toBe("attacker-path");
    await store.authorization.revoke(grant);
    await expect(
      delegate.execute(
        "revoked-call",
        { title: "No", prompt: "No" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("no_grant");
    expect(await store.tasks.listTasks()).toHaveLength(1);
  } finally {
    await store.close();
  }
});
