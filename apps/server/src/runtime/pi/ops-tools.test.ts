import { expect, it, vi } from "vite-plus/test";
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
    await store.authorization.registerResource({
      id: "task-t1",
      kind: "task",
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
        "task_step_accept",
        "task_step_rework",
        "task_signal",
        "task_approve",
        "task_cancel",
        "task_steps",
        "task_events",
        "task_plan",
        "task_link_child",
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
    const plan = tools.find((tool) => tool.name === "task_plan")!;
    expect(plan.parameters).toMatchObject({ additionalProperties: false });
    const planSchema = plan.parameters as {
      properties: {
        steps: {
          maxItems: number;
          items: { additionalProperties: boolean; properties: Record<string, unknown> };
        };
      };
    };
    expect(planSchema.properties.steps.maxItems).toBe(64);
    expect(planSchema.properties.steps.items.additionalProperties).toBe(false);
    expect(Object.keys(planSchema.properties.steps.items.properties).sort()).toEqual(
      [
        "dependencyIds",
        "durationMs",
        "id",
        "instructions",
        "kind",
        "signalKey",
        "targetTaskId",
        "title",
        "workerAccess",
      ].sort(),
    );
    await expect(
      plan.execute(
        "ungranted-plan",
        {
          taskId: "t1",
          rootStepId: "root",
          steps: [
            {
              id: "root",
              kind: "timer_wait",
              title: "Wait",
              dependencyIds: [],
              durationMs: 1000,
            },
          ],
        },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("Permission denied: no_grant");
    const signal = tools.find((tool) => tool.name === "task_signal")!;
    await expect(
      signal.execute(
        "unauthorized-signal",
        { taskId: "t1", stepId: "wait", targetStepVersion: 2, type: "continue" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("Permission denied: no_grant");
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "task-t1",
      action: "task:signal",
      scope: caller.scope,
      effect: "allow",
    });
    await expect(
      signal.execute(
        "unrequested-signal",
        { taskId: "t1", stepId: "wait", targetStepVersion: 2, type: "continue" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("mutation_not_requested");
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

it("plans a text-only Model Step from the current Run profile and rejects extra execution fields", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
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
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "agent:personal",
      action: "conversation:read",
      scope: caller.scope,
      effect: "allow",
    });
    const accepted = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: caller.scope,
      messageId: "model-plan-message",
      text: "Plan a short analysis Task",
      executionRef: "pi:configured-profile",
    });
    await store.authorization.registerResource({
      id: "task-planned",
      kind: "task",
      visibility: "private",
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "task-planned",
      action: "task:plan",
      scope: caller.scope,
      effect: "allow",
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "task-planned",
      action: "task:delegate",
      scope: caller.scope,
      effect: "allow",
    });
    const planExistingTask = vi.fn(async () => {});
    const linkChildTask = vi.fn(async () => ({
      parentTaskId: "planned",
      parentStepId: "child-step",
      childTaskId: "child",
    }));
    const plannedWorkerPermissions = vi.fn(async () => [
      { resourceId: "worker-workspace:configured", action: "worker:file:write" },
      { resourceId: "workspace:configured", action: "workspace:write" },
    ]);
    let currentRunId = accepted.run.id;
    const tools = createOpsTools({
      store,
      service: {
        planExistingTask,
        plannedWorkerPermissions,
        linkChildTask,
      } as unknown as AuthorizedOpsService,
      getContext: () => ({
        caller,
        conversationId: accepted.conversation.id,
        runId: currentRunId,
      }),
      workerTarget: {
        workspaceId: "configured",
        agentKind: "pi",
        worktreePath: "C:/configured-worker",
      },
    });
    const plan = tools.find((tool) => tool.name === "task_plan")!;
    const input = {
      taskId: "planned",
      rootStepId: "model-step",
      steps: [
        {
          id: "model-step",
          kind: "model",
          title: "Analyze",
          dependencyIds: [],
          instructions: "Summarize the approved research.",
        },
      ],
    };
    await plan.execute("plan-model", input, undefined, undefined, {} as never);
    expect(planExistingTask).toHaveBeenCalledWith(
      caller,
      "planned",
      [
        expect.objectContaining({
          kind: "model",
          instructions: "Summarize the approved research.",
          specRef: "pi:configured-profile",
          requiredCapabilities: ["text"],
          delegatedPermissionSet: [],
        }),
      ],
      "model-step",
      expect.objectContaining({ runId: accepted.run.id }),
    );
    await plan.execute(
      "plan-tool",
      {
        taskId: "planned",
        rootStepId: "read-step",
        steps: [
          {
            id: "read-step",
            kind: "tool",
            title: "Read a Task",
            dependencyIds: [],
            targetTaskId: "target-read",
          },
        ],
      },
      undefined,
      undefined,
      {} as never,
    );
    expect(planExistingTask).toHaveBeenLastCalledWith(
      caller,
      "planned",
      [expect.objectContaining({ kind: "tool", specRef: "tool:task_get:target-read" })],
      "read-step",
      expect.objectContaining({ runId: accepted.run.id }),
    );
    await plan.execute(
      "plan-approval",
      {
        taskId: "planned",
        rootStepId: "approval-step",
        steps: [
          {
            id: "approval-step",
            kind: "approval_wait",
            title: "Owner approval",
            dependencyIds: [],
            signalKey: "approve-release",
          },
        ],
      },
      undefined,
      undefined,
      {} as never,
    );
    expect(planExistingTask).toHaveBeenLastCalledWith(
      caller,
      "planned",
      [
        expect.objectContaining({
          kind: "approval_wait",
          waitPolicy: {
            version: 1,
            kind: "approval",
            signalKey: "approve-release",
            overdue: "stale",
          },
        }),
      ],
      "approval-step",
      expect.objectContaining({ runId: accepted.run.id }),
    );
    await plan.execute(
      "plan-child",
      {
        taskId: "planned",
        rootStepId: "child-step",
        steps: [
          {
            id: "child-step",
            kind: "child_task",
            title: "Prepare a child Task",
            dependencyIds: [],
            instructions: "Delegate work under the configured workspace",
            workerAccess: "write",
          },
        ],
      },
      undefined,
      undefined,
      {} as never,
    );
    expect(planExistingTask).toHaveBeenLastCalledWith(
      caller,
      "planned",
      [
        expect.objectContaining({
          kind: "child_task",
          delegatedPermissionSet: [
            { resourceId: "worker-workspace:configured", action: "worker:file:write" },
            { resourceId: "workspace:configured", action: "workspace:write" },
          ],
        }),
      ],
      "child-step",
      expect.objectContaining({ runId: accepted.run.id }),
    );
    const link = tools.find((tool) => tool.name === "task_link_child")!;
    await link.execute(
      "link-child",
      {
        parentTaskId: "planned",
        parentStepId: "child-step",
        expectedStepVersion: 2,
        childTaskId: "child",
        acceptanceCriteria: ["Child work reviewed"],
        cancellationPolicy: "cancel_child",
        failurePolicy: "block_parent",
      },
      undefined,
      undefined,
      {} as never,
    );
    expect(linkChildTask).toHaveBeenCalledWith(
      caller,
      expect.objectContaining({ parentTaskId: "planned", childTaskId: "child" }),
      expect.objectContaining({ runId: accepted.run.id }),
    );
    await plan.execute(
      "plan-worker",
      {
        taskId: "planned",
        rootStepId: "worker-step",
        steps: [
          {
            id: "worker-step",
            kind: "herdr_worker",
            title: "Edit the configured project",
            dependencyIds: [],
            instructions: "Make the requested change and report tests",
            workerAccess: "write",
          },
        ],
      },
      undefined,
      undefined,
      {} as never,
    );
    expect(plannedWorkerPermissions).toHaveBeenCalledWith(
      caller,
      "planned",
      "C:/configured-worker",
      "write",
      expect.objectContaining({ runId: accepted.run.id }),
    );
    expect(planExistingTask).toHaveBeenLastCalledWith(
      caller,
      "planned",
      [
        expect.objectContaining({
          kind: "herdr_worker",
          instructions: "Make the requested change and report tests",
          delegatedPermissionSet: [
            { resourceId: "worker-workspace:configured", action: "worker:file:write" },
            { resourceId: "workspace:configured", action: "workspace:write" },
          ],
        }),
      ],
      "worker-step",
      expect.objectContaining({ runId: accepted.run.id }),
    );
    await expect(
      plan.execute(
        "plan-model-with-extra-field",
        { ...input, steps: [{ ...input.steps[0], signalKey: "continue" }] },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("protected_tool_failed");
    const unsupported = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: caller.scope,
      messageId: "non-model-plan-message",
      text: "Plan another Task",
      executionRef: "claude-code",
    });
    currentRunId = unsupported.run.id;
    await expect(
      plan.execute("plan-with-non-model-run", input, undefined, undefined, {} as never),
    ).rejects.toThrow("protected_tool_failed");
    expect(planExistingTask).toHaveBeenCalledTimes(5);
  } finally {
    await store.close();
  }
});

it("executes one explicit Step acceptance and keeps protected Step fields out of the result", async () => {
  const store = await openDomainStore({ databasePath: ":memory:" });
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
      messageId: "step-accept-message",
      text: "/task step-accept t1 s1 4",
      executionRef: "pi:step-test",
    });
    await store.authorization.registerResource({
      id: "task-t1",
      kind: "task",
      visibility: "private",
    });
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "task-t1",
      action: "task:accept",
      scope: caller.scope,
      effect: "allow",
    });
    const acceptStep = vi.fn(async () => ({
      id: "s1",
      status: "succeeded" as const,
      version: 5,
      instructions: "PROTECTED_STEP_INSTRUCTIONS",
    }));
    const requiredToolInput = { taskId: "t1", stepId: "s1", expectedStepVersion: 4 };
    const tools = createOpsTools({
      store,
      service: { acceptStep } as unknown as AuthorizedOpsService,
      getContext: () => ({
        caller,
        conversationId: accepted.conversation.id,
        runId: accepted.run.id,
        requiredToolName: "task_step_accept",
        requiredToolInput,
      }),
      workerTarget: { workspaceId: "configured", agentKind: "test" },
    });
    const tool = tools.find((entry) => entry.name === "task_step_accept")!;
    const input = { ...requiredToolInput };
    const result = await tool.execute("accept-once", input, undefined, undefined, {} as never);
    expect(result.content).toEqual([
      { type: "text", text: '{"stepId":"s1","status":"succeeded","version":5}' },
    ]);
    expect(result.details).not.toHaveProperty("instructions");
    expect(acceptStep).toHaveBeenCalledTimes(1);
    await expect(
      tool.execute("accept-twice", input, undefined, undefined, {} as never),
    ).rejects.toThrow("mutation_already_attempted");
    expect(acceptStep).toHaveBeenCalledTimes(1);
  } finally {
    await store.close();
  }
});
