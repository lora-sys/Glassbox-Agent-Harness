import { expect, it } from "vite-plus/test";
import { openDomainStore } from "../application/domain-store.js";
import { conversationScopeKey, scopeKey, type CallerContext } from "../identity/scope.js";
import { authorizeLongWorkAction } from "../ops/long-work-authority.js";
import { taskPolicyResourceId } from "./task-policy.js";

const caller: CallerContext = {
  principalId: "owner",
  scope: {
    connectionId: "test",
    botId: "bot",
    chatType: "private",
    chatId: "owner",
    senderId: "owner",
  },
};

it("intersects a child execution grant with every current delegated resource and action", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    await store.identities.bindOwner("owner", caller.scope);
    await store.tasks.createTask({
      id: "parent",
      title: "Parent",
      creatorPrincipalId: "owner",
      authorizationScope: caller.scope,
    });
    await store.tasks.createTask({
      id: "child",
      title: "Child",
      creatorPrincipalId: "owner",
      authorizationScope: caller.scope,
    });
    await store.tasks.createTask({
      id: "grandchild",
      title: "Grandchild",
      creatorPrincipalId: "owner",
      authorizationScope: caller.scope,
    });
    await store.authorization.registerResource({
      id: "secret-resource",
      kind: "file",
      visibility: "private",
      ownerId: "owner",
    });
    const resourceGrantId = await store.authorization.grant({
      principalId: "owner",
      resourceId: "secret-resource",
      action: "read",
      scope: caller.scope,
      effect: "allow",
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: taskPolicyResourceId(caller),
      action: "task:continue",
      scope: caller.scope,
      effect: "allow",
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "task-child",
      action: "task:cancel",
      scope: caller.scope,
      effect: "allow",
    });
    await store.db.transaction(async (tx) => {
      await tx.execute(
        "INSERT INTO task_steps(id,task_id,kind,title,status,dependency_policy_json,max_attempts,required_capabilities_json,delegated_permissions_json,version,created_at,updated_at) VALUES ('parent-step','parent','child_task','Child','running','{}',1,'[]','[]',1,'now','now')",
      );
      await tx.execute(
        "INSERT INTO task_child_links(child_task_id,parent_task_id,parent_step_id,delegated_permissions_json,acceptance_criteria_json,cancel_policy,failure_policy,created_at) VALUES ('child','parent','parent-step','[]','[]','keep_child','block_parent','now')",
      );
      await tx.execute(
        "INSERT INTO task_steps(id,task_id,kind,title,status,dependency_policy_json,max_attempts,required_capabilities_json,delegated_permissions_json,version,created_at,updated_at) VALUES ('child-child-step','child','child_task','Grandchild','running','{}',1,'[]','[]',1,'now','now')",
      );
      await tx.execute(
        "INSERT INTO task_child_links(child_task_id,parent_task_id,parent_step_id,delegated_permissions_json,acceptance_criteria_json,cancel_policy,failure_policy,created_at) VALUES ('grandchild','child','child-child-step','[]','[]','keep_child','block_parent','now')",
      );
    });

    expect(
      (await store.authorization.check({ caller, resourceId: "secret-resource", action: "read" }))
        .decision,
    ).toBe("ALLOW");
    expect(
      await store.authorization.check({
        caller,
        resourceId: "secret-resource",
        action: "read",
        delegatedTaskId: "child",
      }),
    ).toMatchObject({ decision: "DENY", reason: "delegation_scope_denied" });
    await expect(
      authorizeLongWorkAction(store, {
        taskId: "child",
        caller,
        resourceId: "secret-resource",
        action: "read",
      }),
    ).rejects.toMatchObject({ decision: { reason: "delegation_scope_denied" } });
    expect(
      await store.authorization.check({
        caller,
        resourceId: "task-child",
        action: "task:cancel",
        delegatedTaskId: "child",
      }),
    ).toMatchObject({ decision: "DENY", reason: "delegation_scope_denied" });
    expect(
      (
        await store.authorization.check({
          caller,
          resourceId: "task-child",
          action: "task:continue",
          delegatedTaskId: "child",
        })
      ).decision,
    ).toBe("ALLOW");

    await store.db.transaction((tx) =>
      tx.execute({
        sql: "UPDATE task_child_links SET delegated_permissions_json = ? WHERE child_task_id = 'child'",
        args: [JSON.stringify([{ resourceId: "secret-resource", action: "read" }])],
      }),
    );
    expect(
      (
        await store.authorization.check({
          caller,
          resourceId: "secret-resource",
          action: "read",
          delegatedTaskId: "child",
        })
      ).decision,
    ).toBe("ALLOW");
    await expect(
      authorizeLongWorkAction(store, {
        taskId: "child",
        caller,
        resourceId: "secret-resource",
        action: "read",
      }),
    ).resolves.toEqual(expect.any(String));
    expect(
      await store.authorization.check({
        caller,
        resourceId: "secret-resource",
        action: "read",
        delegatedTaskId: "grandchild",
      }),
    ).toMatchObject({ decision: "DENY", reason: "delegation_scope_denied" });
    await store.db.transaction((tx) =>
      tx.execute({
        sql: "UPDATE task_child_links SET delegated_permissions_json = ? WHERE child_task_id = 'grandchild'",
        args: [JSON.stringify([{ resourceId: "secret-resource", action: "read" }])],
      }),
    );
    expect(
      (
        await store.authorization.check({
          caller,
          resourceId: "secret-resource",
          action: "read",
          delegatedTaskId: "grandchild",
        })
      ).decision,
    ).toBe("ALLOW");
    await store.authorization.revoke(resourceGrantId);
    expect(
      await store.authorization.check({
        caller,
        resourceId: "secret-resource",
        action: "read",
        delegatedTaskId: "grandchild",
      }),
    ).toMatchObject({ decision: "DENY", reason: "no_grant" });
    expect(
      await store.authorization.check({
        caller,
        resourceId: "secret-resource",
        action: "write",
        delegatedTaskId: "child",
      }),
    ).toMatchObject({ decision: "DENY", reason: "delegation_scope_denied" });
  } finally {
    await store.close();
  }
});

it("derives the child execution boundary from its persisted internal Run", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    await store.identities.bindOwner("owner", caller.scope);
    await store.conversations.createAgent("personal");
    for (const id of ["parent", "child"])
      await store.tasks.createTask({
        id,
        title: id,
        creatorPrincipalId: "owner",
        authorizationScope: caller.scope,
      });
    await store.authorization.registerResource({
      id: "secret-resource",
      kind: "file",
      visibility: "private",
      ownerId: "owner",
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "secret-resource",
      action: "read",
      scope: caller.scope,
      effect: "allow",
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "agent:personal",
      action: "conversation:read",
      scope: caller.scope,
      effect: "allow",
    });
    await store.db.transaction(async (tx) => {
      await tx.execute(
        "INSERT INTO task_steps(id,task_id,kind,title,status,dependency_policy_json,max_attempts,required_capabilities_json,delegated_permissions_json,version,created_at,updated_at) VALUES ('parent-step','parent','child_task','Child','running','{}',1,'[]','[]',1,'now','now')",
      );
      await tx.execute(
        "INSERT INTO task_child_links(child_task_id,parent_task_id,parent_step_id,delegated_permissions_json,acceptance_criteria_json,cancel_policy,failure_policy,created_at) VALUES ('child','parent','parent-step','[]','[]','keep_child','block_parent','now')",
      );
      await tx.execute(
        "INSERT INTO task_steps(id,task_id,kind,title,status,dependency_policy_json,max_attempts,required_capabilities_json,delegated_permissions_json,version,created_at,updated_at) VALUES ('child-step','child','model','Model','running','{}',1,'[]','[]',1,'now','now')",
      );
      await tx.execute({
        sql: "INSERT INTO task_attempts(id,task_id,step_id,attempt_number,status,started_at) VALUES ('child-attempt','child','child-step',1,'running','now')",
      });
      await tx.execute(
        "INSERT INTO resources(id,kind,visibility,owner_id) VALUES ('conversation:child','conversation','private','owner')",
      );
      await tx.execute({
        sql: "INSERT INTO conversations(id,agent_id,principal_id,scope_key,scope_json,resource_id,created_at) VALUES ('child-conversation','personal','owner',?,?, 'conversation:child','now')",
        args: [conversationScopeKey(caller.scope), JSON.stringify(caller.scope)],
      });
      await tx.execute(
        "INSERT INTO resources(id,kind,visibility,owner_id) VALUES ('conversation:other','conversation','private','owner')",
      );
      await tx.execute({
        sql: "INSERT INTO conversations(id,agent_id,principal_id,scope_key,scope_json,resource_id,created_at) VALUES ('other-conversation','personal','owner',?,?, 'conversation:other','now')",
        args: ["other-location", JSON.stringify(caller.scope)],
      });
      await tx.execute({
        sql: "INSERT INTO messages(id,conversation_id,scope_key,external_id,text,created_at) VALUES ('child-message','child-conversation',?, 'child-internal','', 'now')",
        args: [scopeKey(caller.scope)],
      });
      await tx.execute({
        sql: "INSERT INTO runs(id,conversation_id,message_id,principal_id,scope_json,execution_ref,status,source,created_at,updated_at) VALUES ('child-run','child-conversation','child-message','owner',?,'pi:test','running','task_step','now','now')",
        args: [JSON.stringify(caller.scope)],
      });
      await tx.execute(
        "INSERT INTO task_attempt_runs(attempt_id,run_id,task_id,step_id) VALUES ('child-attempt','child-run','child','child-step')",
      );
    });

    expect(
      await store.authorization.check({
        caller,
        resourceId: "secret-resource",
        action: "read",
        runId: "child-run",
      }),
    ).toMatchObject({ decision: "DENY", reason: "delegation_scope_denied" });
    expect(
      (
        await store.authorization.check({
          caller,
          resourceId: "agent:personal",
          action: "conversation:read",
          runId: "child-run",
          conversationId: "child-conversation",
        })
      ).decision,
    ).toBe("ALLOW");
    expect(
      await store.authorization.check({
        caller,
        resourceId: "agent:personal",
        action: "conversation:read",
        runId: "child-run",
        conversationId: "other-conversation",
      }),
    ).toMatchObject({ decision: "DENY", reason: "delegation_scope_denied" });
    expect(
      await store.authorization.check({
        caller,
        resourceId: "secret-resource",
        action: "read",
        runId: "child-run",
        delegatedTaskId: "parent",
      }),
    ).toMatchObject({ decision: "DENY", reason: "delegation_scope_denied" });
    await store.db.transaction((tx) =>
      tx.execute({
        sql: "UPDATE task_child_links SET delegated_permissions_json = ? WHERE child_task_id = 'child'",
        args: [JSON.stringify([{ resourceId: "secret-resource", action: "read" }])],
      }),
    );
    expect(
      (
        await store.authorization.check({
          caller,
          resourceId: "secret-resource",
          action: "read",
          runId: "child-run",
        })
      ).decision,
    ).toBe("ALLOW");
    await store.db.transaction((tx) =>
      tx.execute("DELETE FROM task_attempt_runs WHERE run_id = 'child-run'"),
    );
    expect(
      await store.authorization.check({
        caller,
        resourceId: "secret-resource",
        action: "read",
        runId: "child-run",
      }),
    ).toMatchObject({ decision: "DENY", reason: "delegation_scope_denied" });
  } finally {
    await store.close();
  }
});
