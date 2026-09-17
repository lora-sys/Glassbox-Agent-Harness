import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  PRIVATE_CANARY,
  type Audience,
} from "@glassbox/contracts";
import { openDomainStore, type DomainStore } from "../persistence/index.js";
import { parseOneBotConfig } from "../channels/onebot/config.js";
import { normalizeOneBotMessage } from "../channels/onebot/normalize.js";
import { FakeHerdrBridge } from "./fake-herdr-bridge.js";
import { OpsReconciler } from "./reconciler.js";
import { assertCanarySafety, checkDelivery } from "../delivery/gate.js";
import {
  CANARY_RESOURCE_ID,
  CANARY_SECRET_VALUE,
  FIXTURE_BOT_ID,
  FIXTURE_CONNECTION_ID,
  FIXTURE_GROUP_ID,
  FIXTURE_OWNER_ID,
  GROUP_MESSAGE_WITH_AT,
  GROUP_MESSAGE_WITHOUT_AT,
  OWNER_PRIVATE_MESSAGE,
  SELF_MESSAGE_PACKET,
} from "../fixtures/canonical-fixtures.js";

const stores: DomainStore[] = [];
const tempDirs: string[] = [];

async function createStore(dbPath = ":memory:"): Promise<DomainStore> {
  const store = await openDomainStore({ databasePath: dbPath });
  stores.push(store);
  return store;
}

afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.close();
  }
  for (const dir of tempDirs.splice(0)) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Ignored cleanup errors on Windows
    }
  }
});

describe("P3.0 Test Harness, Contracts, and Minimal Closed Loop", () => {
  it("normalizes and routes OneBot packet captures deterministically", () => {
    const config = parseOneBotConfig({
      connectionId: FIXTURE_CONNECTION_ID,
      label: "QQ Bot",
      endpoint: "ws://127.0.0.1:6700/",
      botId: FIXTURE_BOT_ID,
      ownerId: FIXTURE_OWNER_ID,
      groupIds: [FIXTURE_GROUP_ID],
      credentialSlot: "qq-token",
      allowRemote: false,
    });

    // 1. Owner private message
    const ownerRes = normalizeOneBotMessage(OWNER_PRIVATE_MESSAGE, config);
    expect(ownerRes.kind).toBe("message");
    if (ownerRes.kind === "message") {
      expect(ownerRes.message.scope.senderId).toBe(FIXTURE_OWNER_ID);
      expect(ownerRes.message.scope.chatType).toBe("private");
      expect(ownerRes.message.text).toBe("Run a disposable coding task");
    }

    // 2. Group message with @bot
    const groupAtRes = normalizeOneBotMessage(GROUP_MESSAGE_WITH_AT, config);
    expect(groupAtRes.kind).toBe("message");
    if (groupAtRes.kind === "message") {
      expect(groupAtRes.message.scope.chatType).toBe("group");
      expect(groupAtRes.message.scope.chatId).toBe(FIXTURE_GROUP_ID);
      expect(groupAtRes.message.text.trim()).toBe("检查任务状态");
    }

    // 3. Group message without @bot -> ignored (no agent run triggered)
    const groupNoAtRes = normalizeOneBotMessage(GROUP_MESSAGE_WITHOUT_AT, config);
    expect(groupNoAtRes.kind).toBe("ignored");

    // 4. Self message -> ignored (loop prevention)
    const selfRes = normalizeOneBotMessage(SELF_MESSAGE_PACKET, config);
    expect(selfRes.kind).toBe("ignored");
  });

  it("enforces Ingress, Context, Tool/Ops, and Delivery authorization with canary defense", async () => {
    const store = await createStore();
    await store.conversations.createAgent("personal");

    const ownerScope = {
      connectionId: FIXTURE_CONNECTION_ID,
      botId: FIXTURE_BOT_ID,
      chatType: "private" as const,
      chatId: FIXTURE_OWNER_ID,
      senderId: FIXTURE_OWNER_ID,
    };
    const visitorScope = {
      ...ownerScope,
      chatId: "20002",
      senderId: "20002",
    };
    const groupScope = {
      ...ownerScope,
      chatType: "group" as const,
      chatId: FIXTURE_GROUP_ID,
    };

    // Bind identities
    await store.identities.bindOwner("owner", ownerScope);
    await store.identities.createPrincipal("visitor", "visitor");
    await store.identities.bindPrincipal("visitor", visitorScope);

    // Register private canary resource
    await store.authorization.registerResource({
      id: CANARY_RESOURCE_ID,
      kind: "secret",
      visibility: "private",
      ownerId: "owner",
    });

    // Grant owner read access in private scope
    await store.authorization.grant({
      principalId: "owner",
      resourceId: CANARY_RESOURCE_ID,
      action: "read",
      scope: ownerScope,
      effect: "allow",
    });

    // Also grant owner read access in group scope (to test private_group_context check)
    await store.authorization.grant({
      principalId: "owner",
      resourceId: CANARY_RESOURCE_ID,
      action: "read",
      scope: groupScope,
      effect: "allow",
    });

    // 1. Owner in private chat: ALLOW
    const ownerPrivateCaller = { principalId: "owner", scope: ownerScope };
    const allowed = await store.authorization.check({
      caller: ownerPrivateCaller,
      resourceId: CANARY_RESOURCE_ID,
      action: "read",
    });
    expect(allowed.decision).toBe("ALLOW");

    const secretLoaded = await store.authorization.withAuthorizedResource(
      { caller: ownerPrivateCaller, resourceId: CANARY_RESOURCE_ID, action: "read" },
      async () => CANARY_SECRET_VALUE,
    );
    expect(secretLoaded).toBe(PRIVATE_CANARY);

    // 2. Visitor in private chat: DENY (no_grant)
    const visitorCaller = { principalId: "visitor", scope: visitorScope };
    const visitorDenied = await store.authorization.check({
      caller: visitorCaller,
      resourceId: CANARY_RESOURCE_ID,
      action: "read",
    });
    expect(visitorDenied.decision).toBe("DENY");
    expect(visitorDenied.reason).toBe("no_grant");

    // Decision record must not leak canary content
    expect(visitorDenied.decision).toBe("DENY");
    expect(JSON.stringify(visitorDenied)).not.toContain(PRIVATE_CANARY);

    // 3. Owner in group chat: DENY (private_group_context)
    const ownerGroupCaller = { principalId: "owner", scope: groupScope };
    const groupDenied = await store.authorization.check({
      caller: ownerGroupCaller,
      resourceId: CANARY_RESOURCE_ID,
      action: "read",
    });
    expect(groupDenied.decision).toBe("DENY");
    expect(groupDenied.reason).toBe("private_group_context");

    // 4. Delivery gate check:
    const groupAudience: Audience = {
      kind: "group",
      destinationScopeKey: JSON.stringify([FIXTURE_CONNECTION_ID, FIXTURE_BOT_ID, "group", FIXTURE_GROUP_ID]),
      allowedPrincipals: ["owner", "visitor"],
    };
    const visitorAudience: Audience = {
      kind: "private",
      destinationScopeKey: JSON.stringify([FIXTURE_CONNECTION_ID, FIXTURE_BOT_ID, "private", "20002"]),
      allowedPrincipals: ["visitor"],
    };
    const ownerPrivateAudience: Audience = {
      kind: "private",
      destinationScopeKey: JSON.stringify([FIXTURE_CONNECTION_ID, FIXTURE_BOT_ID, "private", FIXTURE_OWNER_ID]),
      allowedPrincipals: ["owner"],
    };

    // Private resource cannot be delivered to a group
    const deliveryToGroup = checkDelivery({
      resourceVisibility: "private",
      resourceOwnerId: "owner",
      audience: groupAudience,
      callerPrincipalId: "owner",
    });
    expect(deliveryToGroup.allowed).toBe(false);
    expect(deliveryToGroup.reason).toBe("private_group_delivery_denied");

    // Private resource cannot be delivered to unauthorized visitor
    const deliveryToVisitor = checkDelivery({
      resourceVisibility: "private",
      resourceOwnerId: "owner",
      audience: visitorAudience,
      callerPrincipalId: "owner",
    });
    expect(deliveryToVisitor.allowed).toBe(false);
    expect(deliveryToVisitor.reason).toBe("private_audience_mismatch");

    // Private resource CAN be delivered to owner's private audience
    const deliveryToOwner = checkDelivery({
      resourceVisibility: "private",
      resourceOwnerId: "owner",
      audience: ownerPrivateAudience,
      callerPrincipalId: "owner",
    });
    expect(deliveryToOwner.allowed).toBe(true);

    // 5. Assert canary safety
    expect(() =>
      assertCanarySafety(`Result with secret ${PRIVATE_CANARY}`, groupAudience, false),
    ).toThrow("SECURITY LEAK");

    expect(() =>
      assertCanarySafety(`Result with secret ${PRIVATE_CANARY}`, ownerPrivateAudience, true),
    ).not.toThrow();
  });

  it("completes full Agent Operations lifecycle with FakeHerdrBridge, rework, and review", async () => {
    const store = await createStore();
    await store.conversations.createAgent("personal");
    await store.identities.createPrincipal("owner", "owner");
    const bridge = new FakeHerdrBridge("test-herdr-session");
    const reconciler = new OpsReconciler(store.tasks, bridge);
    await reconciler.start();

    // 1. Create a task in Glassbox
    const task = await store.tasks.createTask({
      title: "Implement parser module",
      description: "Write unit tests and AST parser",
      priority: "high",
      creatorPrincipalId: "owner",
    });
    expect(task.status).toBe("NEW");

    // 2. Delegate to worker via FakeHerdrBridge
    const workerInfo = await bridge.startAgent({
      workspaceId: "ws-test-1",
      agentKind: "codex",
      worktreePath: "/tmp/worktree-1",
      branch: "task/parser",
    });

    const attempt1 = await store.tasks.createAttempt({ taskId: task.id });
    expect(attempt1.attemptNumber).toBe(1);
    expect(attempt1.status).toBe("running");

    const binding = await store.tasks.bindWorker({
      taskAttemptId: attempt1.id,
      herdrSession: "test-herdr-session",
      workspaceId: "ws-test-1",
      paneId: workerInfo.paneId,
      agentName: workerInfo.agentName,
      agentKind: "codex",
      lastObservedAgentState: "working",
    });
    expect(binding.paneId).toBe(workerInfo.paneId);

    let updatedTask = await store.tasks.getTask(task.id);
    expect(updatedTask?.status).toBe("RUNNING");

    // 3. Worker becomes blocked
    bridge.simulateAgentState(workerInfo.paneId, "blocked", "Need clarification on AST schema");
    // Give async event listener a tick
    await new Promise((r) => setTimeout(r, 20));

    updatedTask = await store.tasks.getTask(task.id);
    expect(updatedTask?.status).toBe("WAITING_INPUT");

    let attentionList = await store.tasks.listAttentionItems();
    const blockedAttention = attentionList.find((item) => item.kind === "worker_blocked");
    expect(blockedAttention).toBeDefined();
    expect(blockedAttention?.taskId).toBe(task.id);

    // 4. Unblock worker and worker finishes execution
    bridge.simulateAgentState(workerInfo.paneId, "working");
    bridge.simulateAgentState(workerInfo.paneId, "done", "Completed initial draft");
    await new Promise((r) => setTimeout(r, 20));

    updatedTask = await store.tasks.getTask(task.id);
    // INVARIANT: Worker reaching done moves Task to REVIEW, NEVER auto-accepts to DONE!
    expect(updatedTask?.status).toBe("REVIEW");

    attentionList = await store.tasks.listAttentionItems();
    expect(attentionList.some((item) => item.kind === "worker_blocked")).toBe(false);
    const reviewAttention = attentionList.find((item) => item.kind === "task_review");
    expect(reviewAttention).toBeDefined();
    expect(reviewAttention?.taskId).toBe(task.id);

    // 5. Review Action: REWORK
    // Reviewer requests rework without losing prior attempt history
    await reconciler.reworkTask(task.id, "AST visitor is incomplete; add visitor tests");

    updatedTask = await store.tasks.getTask(task.id);
    expect(updatedTask?.status).toBe("RUNNING");

    const allAttempts = await store.tasks.listAttempts(task.id);
    expect(allAttempts).toHaveLength(2);
    expect(allAttempts[0].attemptNumber).toBe(1);
    expect(allAttempts[0].status).toBe("review");
    expect(allAttempts[0].resultSummary).toContain("Rework requested");
    expect(allAttempts[1].attemptNumber).toBe(2);
    expect(allAttempts[1].status).toBe("running");

    // Bind worker for attempt #2
    await store.tasks.bindWorker({
      taskAttemptId: allAttempts[1].id,
      herdrSession: "test-herdr-session",
      workspaceId: "ws-test-1",
      paneId: workerInfo.paneId,
      agentName: workerInfo.agentName,
      agentKind: "codex",
      lastObservedAgentState: "working",
    });

    // 6. Worker finishes attempt #2
    bridge.simulateAgentState(workerInfo.paneId, "done", "Visitor tests added and passing");
    await new Promise((r) => setTimeout(r, 20));

    updatedTask = await store.tasks.getTask(task.id);
    expect(updatedTask?.status).toBe("REVIEW");

    // 7. Review Action: ACCEPT
    await reconciler.acceptTask(task.id);

    updatedTask = await store.tasks.getTask(task.id);
    expect(updatedTask?.status).toBe("DONE");

    const finalAttempts = await store.tasks.listAttempts(task.id);
    expect(finalAttempts[1].status).toBe("succeeded");

    const remainingAttention = await store.tasks.listAttentionItems();
    expect(remainingAttention).toHaveLength(0);

    // 8. Snapshot calculation
    const snapshot = await store.tasks.getOpsSnapshot();
    expect(snapshot.attention.total).toBe(0);
    expect(snapshot.tasks.open).toBe(0);
    expect(snapshot.tasks.doneToday).toBe(1);
  });

  it("survives restart and database reopen without losing durable task state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "glassbox-p3-test-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "durable-p3.db");

    // Session 1: Create task and attempt
    const store1 = await createStore(dbPath);
    await store1.conversations.createAgent("personal");
    await store1.identities.createPrincipal("owner", "owner");
    const task = await store1.tasks.createTask({
      id: "task-durability-01",
      title: "Check durability across reopen",
      priority: "urgent",
      creatorPrincipalId: "owner",
    });
    const attempt = await store1.tasks.createAttempt({ taskId: task.id });
    await store1.tasks.bindWorker({
      taskAttemptId: attempt.id,
      herdrSession: "session-persist",
      workspaceId: "ws-persist",
      paneId: "pane-persist-01",
      agentKind: "codex",
      lastObservedAgentState: "working",
    });
    await store1.tasks.createAttentionItem({
      kind: "worker_blocked",
      summary: "Worker blocked in attempt",
      taskId: task.id,
      taskAttemptId: attempt.id,
    });

    // Close session 1
    await store1.close();
    stores.splice(stores.indexOf(store1), 1);

    // Session 2: Reopen from same file
    const store2 = await createStore(dbPath);

    const reloadedTask = await store2.tasks.getTask("task-durability-01");
    expect(reloadedTask).toBeDefined();
    expect(reloadedTask?.title).toBe("Check durability across reopen");
    expect(reloadedTask?.status).toBe("RUNNING");
    expect(reloadedTask?.activeAttemptId).toBe(attempt.id);

    const reloadedAttempts = await store2.tasks.listAttempts("task-durability-01");
    expect(reloadedAttempts).toHaveLength(1);
    expect(reloadedAttempts[0].id).toBe(attempt.id);

    const reloadedBinding = await store2.tasks.getWorkerBinding(attempt.id);
    expect(reloadedBinding?.paneId).toBe("pane-persist-01");
    expect(reloadedBinding?.herdrSession).toBe("session-persist");

    const reloadedAttention = await store2.tasks.listAttentionItems();
    expect(reloadedAttention).toHaveLength(1);
    expect(reloadedAttention[0].taskId).toBe("task-durability-01");

    await store2.close();
    stores.splice(stores.indexOf(store2), 1);
  });
});
