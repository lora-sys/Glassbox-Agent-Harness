import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vite-plus/test";
import {
  agentResourceId,
  openDomainStore,
  type CallerContext,
  type DomainStore,
} from "../persistence/index.js";
import { FakeHerdrBridge } from "../ops/fake-herdr-bridge.js";
import { AuthorizedOpsService } from "../ops/service.js";
import { createOpsTools } from "../runtime/pi/ops-tools.js";
import type { PiRunContext } from "../runtime/pi/types.js";

const privateScope = {
  connectionId: "qq-task-fixture",
  botId: "task-fixture-bot",
  chatType: "private" as const,
  chatId: "owner-qq",
  senderId: "owner-qq",
};
const stores: DomainStore[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

it("observes a Task created, inspected, and canceled through protected Ops Tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-live-task-fixture-"));
  directories.push(directory);
  const databasePath = join(directory, "glassbox.db");
  const store = await openDomainStore({ databasePath });
  stores.push(store);

  await store.conversations.createAgent("personal");
  await store.identities.bindOwner("owner-task", privateScope);
  await store.authorization.registerResource({
    id: "agent-operations",
    kind: "ops",
    visibility: "public",
    ifAbsent: true,
  });
  for (const [resourceId, action] of [
    [agentResourceId("personal"), "run:create"],
    ["agent-operations", "task:create"],
  ])
    await store.authorization.grant({
      principalId: "owner-task",
      resourceId,
      action,
      scope: privateScope,
      effect: "allow",
    });

  const caller: CallerContext = { principalId: "owner-task", scope: privateScope };
  let context: PiRunContext | undefined;
  const tools = createOpsTools({
    store,
    service: new AuthorizedOpsService(store, new FakeHerdrBridge()),
    getContext: () => context,
    workerTarget: { workspaceId: "fixture-only", agentKind: "test" },
  });
  const tool = (name: string) => {
    const found = tools.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`missing tool ${name}`);
    return found;
  };
  const run = async (label: string) => {
    const accepted = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope: privateScope,
      messageId: `task-fixture-${randomUUID()}`,
      text: `Disposable Task fixture ${label}`,
      executionRef: "pi:qq-live-task-fixture-test",
    });
    context = {
      caller,
      runId: accepted.run.id,
      conversationId: accepted.conversation.id,
    };
    return accepted.run.id;
  };

  const nonce = randomUUID().replaceAll("-", "");
  const { taskFixtureStep } = await import(
    pathToFileURL(resolve(process.cwd(), "tools/qq-live/lib/task-scenario.mjs")).href
  );
  const { observeTaskFixture } = await import(
    pathToFileURL(resolve(process.cwd(), "tools/qq-live/lib/task-fixture.mjs")).href
  );
  const createSpec = taskFixtureStep("create", { nonce });
  const createInput = createSpec.leaseTools[0].operations[0].inputConstraint;
  const createRunId = await run("create");
  const createdResult = await tool("task_create").execute(
    "task-create",
    createInput,
    undefined,
    undefined,
    {} as never,
  );
  const created = createdResult.details as {
    id: string;
    status: string;
    priority: string;
    runId: string;
  };
  expect(created).toMatchObject({ status: "NEW", priority: "normal", runId: createRunId });

  for (const action of ["task:read", "task:cancel"])
    await store.authorization.grant({
      principalId: caller.principalId,
      resourceId: `task-${created.id}`,
      action,
      scope: caller.scope,
      effect: "allow",
    });

  const inspectRunId = await run("inspect");
  const inspectedResult = await tool("task_get").execute(
    "task-inspect",
    { taskId: created.id },
    undefined,
    undefined,
    {} as never,
  );
  expect(inspectedResult.details).toMatchObject({
    id: created.id,
    status: "NEW",
    priority: "normal",
  });

  const cancelRunId = await run("cancel");
  await tool("task_cancel").execute(
    "task-cancel",
    { taskId: created.id },
    undefined,
    undefined,
    {} as never,
  );
  await store.close();
  stores.splice(stores.indexOf(store), 1);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const inspectionDecision = db
      .prepare(
        "SELECT COUNT(*) AS count FROM authorization_decisions_all WHERE run_id = ? AND principal_id = ? AND resource_id = ? AND action = 'task:read' AND decision = 'ALLOW'",
      )
      .get(inspectRunId, caller.principalId, `task-${created.id}`);
    expect(Number(inspectionDecision?.count)).toBeGreaterThan(0);
    expect(
      observeTaskFixture(db, {
        stage: "cancel",
        fixtureNonce: nonce,
        principalId: caller.principalId,
        scope: caller.scope,
        creationRunId: createRunId,
        inspectRunId,
        stepRunId: cancelRunId,
        taskId: created.id,
      }),
    ).toMatchObject({
      taskId: created.id,
      status: "CANCELED",
      creationRunId: createRunId,
      stepRunId: cancelRunId,
    });
  } finally {
    db.close();
  }
});
