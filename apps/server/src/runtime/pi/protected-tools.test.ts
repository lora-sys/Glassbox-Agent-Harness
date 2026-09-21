import { describe, expect, it, vi } from "vite-plus/test";
import { Type } from "typebox";
import type { AuthorizationService } from "../../auth/service.js";
import type { CallerContext } from "../../identity/scope.js";
import { ProviderCallError } from "./provider-outcome.js";
import {
  createProtectedTool,
  ToolInputError,
  type ProtectedToolContext,
} from "./protected-tools.js";

const caller: CallerContext = {
  principalId: "owner",
  scope: {
    connectionId: "qq",
    botId: "bot",
    chatType: "private",
    chatId: "owner",
    senderId: "owner",
  },
};

/** An authorization service that allows everything, so only the Tool's own behavior is under test. */
const allowAll = {
  check: vi.fn(async () => ({ decision: "ALLOW" as const, reason: "granted" })),
} as unknown as AuthorizationService;

function tool(
  execute: (params: Record<string, unknown>, context: ProtectedToolContext) => Promise<unknown>,
) {
  const context: ProtectedToolContext = {
    caller,
    conversationId: "conversation-1",
    runId: "run-1",
  };
  return {
    context,
    definition: createProtectedTool<Record<string, unknown>, unknown>({
      name: "fixture_tool",
      description: "fixture",
      parameters: Type.Object({}),
      action: "read",
      resourceId: "canary",
      authService: allowAll,
      getContext: () => context,
      execute: (params, current) => execute(params, current),
    }),
  };
}

async function run(
  definition: ReturnType<typeof tool>["definition"],
  params: Record<string, unknown> = {},
): Promise<unknown> {
  // The SDK's own Tool signature: the call id, the arguments, and the host-only extras this
  // adapter never reads.
  return definition.execute("call-1", params, undefined, undefined, {} as never);
}

describe("a protected Tool's failure classification", () => {
  it("returns a successful call's result to the model", async () => {
    const { definition } = tool(async () => ({ members: [] }));
    await expect(run(definition)).resolves.toMatchObject({
      content: [{ type: "text", text: '{"members":[]}' }],
    });
  });

  it("collapses an unknown execution failure into one opaque code", async () => {
    const { definition } = tool(async () => {
      throw new Error("NapCat retcode 100 at ws://internal:3000");
    });
    await expect(run(definition)).rejects.toThrow("protected_tool_failed");
  });

  it("re-throws a provider refusal unchanged, as its own fact", async () => {
    // "The bridge is not connected" and "the Tool broke" are different facts about the world.
    // Collapsing them would erase the distinction a Run has to report.
    const failure = new ProviderCallError("provider_unavailable", "provider_unavailable");
    const { definition } = tool(async () => {
      throw failure;
    });
    await expect(run(definition)).rejects.toBe(failure);
  });

  it("keeps an input refusal distinct from an execution failure", async () => {
    const { definition } = tool(async () => {
      throw new ToolInputError("mutation_not_requested");
    });
    await expect(run(definition)).rejects.toThrow("mutation_not_requested");
  });

  it("never lets a provider refusal reach the model as a Tool result", async () => {
    const { definition } = tool(async () => {
      throw new ProviderCallError("provider_failed", "provider_failed");
    });
    await expect(run(definition)).rejects.toBeInstanceOf(ProviderCallError);
  });
});
