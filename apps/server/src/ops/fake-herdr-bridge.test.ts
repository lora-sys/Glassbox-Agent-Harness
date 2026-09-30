import { expect, it } from "vite-plus/test";
import { FakeHerdrBridge } from "./fake-herdr-bridge.js";

it("refuses repeat dispatch of a stable Worker identity", async () => {
  const bridge = new FakeHerdrBridge();
  const agentName = "glassbox-attempt-one";
  const binding = {
    workspaceId: "workspace-one",
    agentKind: "pi",
    worktreePath: "/worktree-one",
    branch: "codex/task-one",
    agentName,
  };
  const launched = await bridge.startAgent(binding);
  await expect(bridge.startAgent(binding)).rejects.toThrow("already exists");
  expect(launched.agentName).toBe(agentName);
  expect((await bridge.getSnapshot()).workspaces[0]?.panes).toHaveLength(1);
  await expect(bridge.startAgent({ ...binding, workspaceId: "workspace-two" })).rejects.toThrow(
    "bound elsewhere",
  );
  await expect(bridge.startAgent({ ...binding, worktreePath: "/worktree-two" })).rejects.toThrow(
    "bound elsewhere",
  );
  await expect(bridge.startAgent({ ...binding, agentName: "unsafe" })).rejects.toThrow(
    "Invalid stable",
  );
});
