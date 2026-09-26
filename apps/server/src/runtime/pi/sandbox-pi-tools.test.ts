import { describe, expect, it } from "vite-plus/test";
import { createIsolatedPiTools, type IsolatedPiSession } from "./sandbox-pi-tools.js";
import type { DomainStore } from "../../application/domain-store.js";
import type { WorkspaceRegistry } from "../../workspace/registry.js";
import type { PiRunContext } from "./types.js";

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

function fixture(decision: "ALLOW" | "DENY") {
  const checks: string[] = [];
  const executions: string[] = [];
  const updates: unknown[] = [];
  const context: PiRunContext = { caller, conversationId: "conversation", runId: "run" };
  const registry = {
    async resolveAuthorized(principalId: string, workspaceId: string, access: string) {
      checks.push(`registry:${principalId}:${workspaceId}:${access}`);
      return { id: workspaceId };
    },
  } as unknown as WorkspaceRegistry;
  const store = {
    authorization: {
      async check(input: { action: string }) {
        checks.push(`auth:${input.action}`);
        return { id: "decision", decision, grantId: decision === "ALLOW" ? "grant" : null };
      },
    },
  } as unknown as DomainStore;
  const session: IsolatedPiSession = {
    toolDefinitions: [
      { name: "read", description: "Read", parameters: {}, available: true },
      { name: "bash", description: "Run", parameters: {}, available: true },
    ],
    async execute(input) {
      executions.push(input.name);
      if (input.name === "read")
        return { content: [{ type: "text", text: "read failed" }], isError: true };
      input.onUpdate?.({ content: [{ type: "text", text: "progress" }] });
      return {
        content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
        details: { diff: "native" },
      };
    },
    async close() {},
  };
  const tools = createIsolatedPiTools({
    session,
    registry,
    store,
    workspaceId: "workspace-1",
    getContext: () => context,
  });
  return { tools, checks, executions, updates };
}

describe("isolated Pi tool authorization", () => {
  it("checks the current workspace grant before any container call", async () => {
    const f = fixture("DENY");
    await expect(
      f.tools[0]!.execute("call", { path: "file" }, undefined, undefined, {} as never),
    ).rejects.toThrow("authorization_denied");
    expect(f.checks).toEqual(["registry:owner:workspace-1:read", "auth:workspace:read"]);
    expect(f.executions).toEqual([]);
  });

  it("treats Shell as writable and preserves Pi image and details", async () => {
    const f = fixture("ALLOW");
    const result = await f.tools[1]!.execute(
      "call",
      { command: "echo ok" },
      undefined,
      (update) => f.updates.push(update),
      {} as never,
    );
    expect(f.checks).toEqual(["registry:owner:workspace-1:write", "auth:workspace:write"]);
    expect(f.executions).toEqual(["bash"]);
    expect(result.content).toEqual([{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }]);
    expect(result.details).toEqual({ diff: "native" });
    expect(f.updates).toEqual([
      { content: [{ type: "text", text: "progress" }], details: undefined },
    ]);
  });

  it("keeps a native tool error in the Pi result", async () => {
    const f = fixture("ALLOW");
    const result = await f.tools[0]!.execute(
      "call",
      { path: "missing" },
      undefined,
      undefined,
      {} as never,
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "read failed" }],
      details: undefined,
      isError: true,
    });
  });
});
