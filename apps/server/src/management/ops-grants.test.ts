import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vite-plus/test";
import { openDomainStore, type CallerContext } from "../persistence/index.js";
import { AuthorizedOpsService } from "../ops/service.js";
import { FakeHerdrBridge } from "../ops/fake-herdr-bridge.js";
import { grantOpsPermissions } from "./ops-grants.js";

it("provisions scoped Task permissions explicitly, separates delivery, and revokes across database reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-task-policy-"));
  const databasePath = join(directory, "state.db");
  let store = await openDomainStore({ databasePath });
  const owner: CallerContext = {
    principalId: "owner",
    scope: {
      connectionId: "qq",
      botId: "bot",
      chatType: "private",
      chatId: "owner",
      senderId: "owner",
    },
  };
  const group: CallerContext = {
    ...owner,
    scope: { ...owner.scope, chatType: "group", chatId: "group" },
  };
  const visitor: CallerContext = {
    principalId: "visitor",
    scope: { ...owner.scope, chatId: "visitor", senderId: "visitor" },
  };
  try {
    await store.identities.bindOwner("owner", owner.scope);
    await store.identities.createPrincipal("visitor", "visitor");
    await store.identities.bindPrincipal("visitor", visitor.scope);
    await store.conversations.createAgent("personal");
    const runs = [];
    for (const caller of [owner, group, visitor]) {
      for (const action of ["run:create", "trace:write"])
        await store.authorization.grant({
          principalId: caller.principalId,
          resourceId: "agent:personal",
          action,
          scope: caller.scope,
          effect: "allow",
        });
      runs.push(
        await store.conversations.acceptIncoming({
          agentId: "personal",
          scope: caller.scope,
          messageId: `message-${runs.length}`,
          text: "Task",
          executionRef: "pi:test",
        }),
      );
    }
    const service = new AuthorizedOpsService(store, new FakeHerdrBridge());
    await expect(service.create(owner, { title: "Denied" })).rejects.toThrow();
    const granted = await grantOpsPermissions(store, undefined, {
      runId: runs[0]!.run.id,
      actions: ["task:create", "task:read", "task:list"],
    });
    const task = await service.create(owner, {
      title: "PRIVATE_TASK_CANARY",
      runId: runs[0]!.run.id,
      conversationId: runs[0]!.conversation.id,
    });
    expect(await service.get(owner, task.id)).toMatchObject({ id: task.id });
    const delivery = () =>
      store.authorization.check({
        caller: owner,
        resourceId: `task-${task.id}`,
        action: "delivery:send",
      });
    expect((await delivery()).decision).toBe("DENY");
    await expect(service.get(group, task.id)).rejects.toThrow();
    await grantOpsPermissions(store, undefined, {
      runId: runs[2]!.run.id,
      actions: ["task:create", "task:read", "task:list"],
    });
    await expect(service.get(visitor, task.id)).rejects.toThrow();
    expect(await service.list(visitor)).toEqual([]);
    await grantOpsPermissions(store, undefined, {
      runId: runs[1]!.run.id,
      actions: ["task:create", "task:read"],
    });
    const groupTask = await service.create(group, {
      title: "Group task",
      runId: runs[1]!.run.id,
      conversationId: runs[1]!.conversation.id,
    });
    expect(await service.get(group, groupTask.id)).toMatchObject({ id: groupTask.id });
    await expect(service.get(owner, groupTask.id)).rejects.toThrow();
    await grantOpsPermissions(store, undefined, {
      runId: runs[0]!.run.id,
      actions: ["delivery:send"],
    });
    expect((await delivery()).decision).toBe("ALLOW");
    await store.authorization.revoke(
      granted.grants.find((grant) => grant.action === "task:read")!.id,
    );
    await expect(service.get(owner, task.id)).rejects.toThrow();
    await store.close();
    store = await openDomainStore({ databasePath });
    expect(
      (
        await store.authorization.check({
          caller: owner,
          resourceId: `task-${task.id}`,
          action: "task:read",
        })
      ).decision,
    ).toBe("DENY");
    expect(
      (
        await store.authorization.check({
          caller: group,
          resourceId: `task-${groupTask.id}`,
          action: "task:read",
        })
      ).decision,
    ).toBe("ALLOW");
    for (const input of [
      { runId: runs[0]!.run.id, actions: ["raw-shell"] },
      { runId: runs[0]!.run.id, actions: ["task:read"], principalId: "visitor" },
    ])
      await expect(grantOpsPermissions(store, undefined, input)).rejects.toThrow(
        "Invalid Ops grant request",
      );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(
      (error) => {
        if (error.code !== "EBUSY") throw error;
      },
    );
  }
});
