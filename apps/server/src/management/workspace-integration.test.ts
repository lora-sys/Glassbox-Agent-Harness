import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { createApplicationFixtureScope } from "./application-test-helpers.js";

const { fixture, afterEachCleanup } = createApplicationFixtureScope();
const directories: string[] = [];
afterEach(async () => {
  await afterEachCleanup();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it("keeps two Owner workspaces separate and revokes only the shared grant", async () => {
  const f = await fixture(async (input) => ({ status: "succeeded", text: input.text }), {
    coOwnerId: "10006",
  });
  const owner = (await f.app.listWorkspaces("owner")) as Array<{ id: string; selected: boolean }>;
  const coOwner = (await f.app.listWorkspaces("owner-10006")) as Array<{
    id: string;
    selected: boolean;
  }>;
  expect(owner).toHaveLength(1);
  expect(coOwner).toHaveLength(1);
  expect(owner[0]?.id).not.toBe(coOwner[0]?.id);
  expect(owner[0]?.selected).toBe(true);
  expect(coOwner[0]?.selected).toBe(true);

  const sharedPath = await mkdtemp(join(tmpdir(), "glassbox-shared-project-"));
  directories.push(sharedPath);
  const registered = await f.app.registerWorkspace({
    path: sharedPath,
    label: "Shared fixture",
    ownerPrincipalId: "owner",
  });
  const sharedId = registered.id;
  await f.app.grantWorkspace({
    workspaceId: sharedId,
    principalId: "owner-10006",
    access: "write",
  });
  await f.app.selectWorkspace({ workspaceId: sharedId, principalId: "owner-10006" });
  expect(
    (await f.app.listWorkspaces("owner-10006")).find((workspace) => workspace.id === sharedId)
      ?.selected,
  ).toBe(true);

  await f.app.grantWorkspace({ workspaceId: sharedId, principalId: "owner-10006", access: "read" });
  expect(
    (await f.app.listWorkspaces("owner-10006")).find((workspace) => workspace.id === sharedId)
      ?.access,
  ).toBe("read");

  await f.app.revokeWorkspace({ workspaceId: sharedId, principalId: "owner-10006" });
  expect(
    (await f.app.listWorkspaces("owner-10006")).some((workspace) => workspace.id === sharedId),
  ).toBe(false);
  expect((await f.app.listWorkspaces("owner")).some((workspace) => workspace.id === sharedId)).toBe(
    true,
  );
  const coOwnerCaller = {
    principalId: "owner-10006",
    scope: {
      connectionId: "fixture",
      botId: "10001",
      chatType: "private" as const,
      chatId: "10006",
      senderId: "10006",
    },
  };
  expect(
    (
      await f.app.store.authorization.check({
        caller: coOwnerCaller,
        resourceId: `workspace:${sharedId}`,
        action: "workspace:write",
      })
    ).decision,
  ).toBe("DENY");
});

it("withholds write tools while another Run occupies the selected workspace", async () => {
  const f = await fixture(async (input) => ({ status: "succeeded", text: input.text }));
  const [workspace] = await f.app.listWorkspaces("owner");
  expect(workspace).toBeDefined();
  (f.app as unknown as { sandboxRuntime: unknown }).sandboxRuntime = {
    availableTools: new Set(["read", "write"]),
  };
  f.send(501, "workspace candidate fixture", true);
  const run = await f.started.take();
  await f.reply("workspace candidate fixture");
  const lease = f.app.workspaceWrites.acquire({
    workspaceId: workspace!.id,
    principalId: "owner",
    executionId: "other-run",
    sandboxSessionId: "other-session",
    policyVersion: "workspace-sandbox-v1",
  });
  try {
    const candidates = await f.app.resolveRunToolCandidates({
      caller: run.caller,
      conversationId: run.conversation.id,
      runId: run.run.id,
    });
    expect(candidates.find((candidate) => candidate.name === "write")?.exclusion).toBe(
      "policy_disabled",
    );
    expect(candidates.find((candidate) => candidate.name === "read")?.exclusion).toBeNull();
  } finally {
    await f.app.workspaceWrites.closeAndRelease(lease, async () => undefined);
    (f.app as unknown as { sandboxRuntime: unknown }).sandboxRuntime = null;
  }
});
