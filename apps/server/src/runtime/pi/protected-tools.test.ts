import { describe, expect, it, vi } from "vite-plus/test";
import { Type } from "typebox";
import type { AuthorizationService } from "../../auth/service.js";
import type { CallerContext } from "../../identity/scope.js";
import { ProviderCallError } from "./provider-outcome.js";
import { authorizationProjectionResult } from "./authorization-projection.js";
import { safeToolOutput } from "./tool-output-evidence.js";
import {
  createProtectedTool,
  requiredCallClause,
  toolGateFailureCode,
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
  it("rechecks a server-owned lease after asynchronous authorization and before effects", async () => {
    let checks = 0;
    const execute = vi.fn(async () => "should not execute");
    const context: ProtectedToolContext = {
      caller,
      conversationId: "conversation-1",
      runId: "run-1",
      acceptanceLease: {
        leaseId: "lease-1",
        marker: "aabbccddeeff00112233445566778899",
        toolsSha256: "0".repeat(64),
        assertActive: () => true,
        filterToolNames: (names) => [...names],
        getToolInputRestrictions: (toolName) =>
          toolName === "fixture_tool"
            ? [{ action: "read", resourceId: "canary", inputConstraint: {} }]
            : [],
        checkToolCall: () => {
          checks += 1;
          return checks === 1;
        },
      },
    };
    const definition = createProtectedTool<Record<string, unknown>, string>({
      name: "fixture_tool",
      description: "fixture",
      parameters: Type.Object({}),
      action: "read",
      resourceId: "canary",
      authService: allowAll,
      getContext: () => context,
      execute,
    });
    await expect(run(definition)).rejects.toThrow("acceptance_lease_denied");
    expect(checks).toBe(2);
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed with a fixed code when the lease check throws", async () => {
    const privateValue = "lease-check-private-321";
    const execute = vi.fn(async () => "must not execute");
    const context: ProtectedToolContext = {
      caller,
      conversationId: "conversation-lease-check-throw",
      runId: "run-lease-check-throw",
      acceptanceLease: {
        leaseId: "lease-1",
        marker: "aabbccddeeff00112233445566778899",
        toolsSha256: "0".repeat(64),
        assertActive: () => true,
        filterToolNames: (names) => [...names],
        getToolInputRestrictions: (toolName) =>
          toolName === "fixture_tool"
            ? [{ action: "read", resourceId: "canary", inputConstraint: { value: privateValue } }]
            : [],
        checkToolCall: () => {
          throw new Error(`private callback detail ${privateValue}`);
        },
      },
    };
    const definition = createProtectedTool<Record<string, unknown>, string>({
      name: "fixture_tool",
      description: "fixture",
      parameters: Type.Object({ value: Type.String() }),
      action: "read",
      resourceId: "canary",
      authService: allowAll,
      getContext: () => context,
      execute,
    });

    let failure: unknown;
    try {
      await run(definition, { value: privateValue });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ToolInputError);
    expect((failure as Error).message).toBe("acceptance_lease_unavailable");
    expect((failure as Error).message).not.toContain(privateValue);
    expect(toolGateFailureCode(JSON.stringify({ message: (failure as Error).message }))).toBe(
      "acceptance_lease_unavailable",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed with a fixed code when the final lease check throws", async () => {
    const privateValue = "lease-final-check-private-654";
    let checks = 0;
    const execute = vi.fn(async () => "must not execute");
    const context: ProtectedToolContext = {
      caller,
      conversationId: "conversation-lease-final-check-throw",
      runId: "run-lease-final-check-throw",
      acceptanceLease: {
        leaseId: "lease-1",
        marker: "aabbccddeeff00112233445566778899",
        toolsSha256: "0".repeat(64),
        assertActive: () => true,
        filterToolNames: (names) => [...names],
        getToolInputRestrictions: (toolName) =>
          toolName === "fixture_tool"
            ? [{ action: "read", resourceId: "canary", inputConstraint: { value: privateValue } }]
            : [],
        checkToolCall: () => {
          checks += 1;
          if (checks === 2) throw new Error(`private callback detail ${privateValue}`);
          return true;
        },
      },
    };
    const definition = createProtectedTool<Record<string, unknown>, string>({
      name: "fixture_tool",
      description: "fixture",
      parameters: Type.Object({ value: Type.String() }),
      action: "read",
      resourceId: "canary",
      authService: allowAll,
      getContext: () => context,
      execute,
    });

    let failure: unknown;
    try {
      await run(definition, { value: privateValue });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ToolInputError);
    expect((failure as Error).message).toBe("acceptance_lease_unavailable");
    expect((failure as Error).message).not.toContain(privateValue);
    expect(checks).toBe(2);
    expect(execute).not.toHaveBeenCalled();
  });

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

  it.each([
    ["acceptance_lease_input_mismatch", "acceptance_lease_input_mismatch"],
    ["private-callback-payload-123", "acceptance_lease_denied"],
    ["owner_confirmation_required", "acceptance_lease_denied"],
  ])("restricts lease diagnosis %s to its own fixed codes", async (diagnostic, expected) => {
    const execute = vi.fn(async () => "must not execute");
    const context: ProtectedToolContext = {
      caller,
      conversationId: "diagnostic-conversation",
      runId: "diagnostic-run",
      acceptanceLease: {
        leaseId: "lease-1",
        marker: "aabbccddeeff00112233445566778899",
        toolsSha256: "0".repeat(64),
        assertActive: () => true,
        filterToolNames: (names) => [...names],
        getToolInputRestrictions: (toolName) =>
          toolName === "fixture_tool"
            ? [
                {
                  action: "read",
                  resourceId: "canary",
                  inputConstraint: { value: "private-argument-321" },
                },
              ]
            : [],
        checkToolCall: () => false,
        diagnoseToolCall: () => diagnostic,
      },
    };
    const definition = createProtectedTool<Record<string, unknown>, string>({
      name: "fixture_tool",
      description: "fixture",
      parameters: Type.Object({ value: Type.String() }),
      action: "read",
      resourceId: "canary",
      authService: allowAll,
      getContext: () => context,
      execute,
    });
    await expect(run(definition, { value: "private-argument-321" })).rejects.toThrow(expected);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a throwing lease diagnostic without exposing its error or arguments", async () => {
    const execute = vi.fn(async () => "must not execute");
    const context: ProtectedToolContext = {
      caller,
      conversationId: "diagnostic-conversation",
      runId: "diagnostic-run",
      acceptanceLease: {
        leaseId: "lease-1",
        marker: "aabbccddeeff00112233445566778899",
        toolsSha256: "0".repeat(64),
        assertActive: () => true,
        filterToolNames: (names) => [...names],
        getToolInputRestrictions: (toolName) =>
          toolName === "fixture_tool"
            ? [
                {
                  action: "read",
                  resourceId: "canary",
                  inputConstraint: { value: "private-argument-321" },
                },
              ]
            : [],
        checkToolCall: () => false,
        diagnoseToolCall: () => {
          throw new Error("private-diagnostic-canary-456");
        },
      },
    };
    const definition = createProtectedTool<Record<string, unknown>, string>({
      name: "fixture_tool",
      description: "fixture",
      parameters: Type.Object({ value: Type.String() }),
      action: "read",
      resourceId: "canary",
      authService: allowAll,
      getContext: () => context,
      execute,
    });
    await expect(run(definition, { value: "private-argument-321" })).rejects.toThrow(
      /^acceptance_lease_unavailable$/,
    );
    expect(execute).not.toHaveBeenCalled();
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

  it("hands a Glassbox gate code back unchanged so the next call can be a correction", async () => {
    // "The Owner's message does not carry the command" is a rule the model can satisfy. Reporting
    // it as "the Tool failed" instead is what let a Run tell the user an instruction had been
    // recorded while nothing was written.
    const { definition } = tool(async () => {
      throw new Error("owner_confirmation_required");
    });
    await expect(run(definition)).rejects.toThrow("owner_confirmation_required");
  });

  it("still collapses a message that is not one of the fixed codes", async () => {
    // The whitelist is what makes the pass-through safe: a message this repository did not author
    // as a code stays opaque, however much it looks like one.
    for (const message of [
      "NapCat retcode 100 at ws://internal:3000",
      "owner_confirmation_required for candidate_cafebabe",
      "timeout",
    ]) {
      const { definition } = tool(async () => {
        throw new Error(message);
      });
      await expect(run(definition)).rejects.toThrow("protected_tool_failed");
    }
  });
});

describe("a required call's instruction", () => {
  it("pins the exact input when the message bound every parameter", () => {
    expect(
      requiredCallClause("group_history_search", { query: "p4b-a-1349", sender: "3526039967" }),
    ).toBe(
      'group_history_search with exactly this JSON input: {"query":"p4b-a-1349","sender":"3526039967"}',
    );
  });

  it("names where an unpinned filter comes from instead of printing an empty object", () => {
    // Both alternatives fail: `{}` is rejected by the Tool's own schema, and a bare Tool name
    // leaves the model to send it anyway.
    for (const input of [undefined, {}]) {
      const clause = requiredCallClause("group_history_search", input);
      expect(clause).toBe("group_history_search with a filter taken from the user's own words");
      expect(clause).not.toContain("{}");
    }
  });
});

it("projects only server-bound QQ group IDs out of model call examples", () => {
  const input = Object.freeze({
    groupId: "1126022432",
    operation: "set_group_ban",
    memberSelector: "Ripped",
    params: Object.freeze({ duration: 30 }),
  });
  expect(requiredCallClause("qq_group_moderation", input, "group")).toBe(
    'qq_group_moderation with exactly this JSON input: {"operation":"set_group_ban","memberSelector":"Ripped","params":{"duration":30}}',
  );
  expect(requiredCallClause("qq_group_moderation", input, "private")).toContain(
    JSON.stringify(input),
  );
  expect(requiredCallClause("owner_group_admin", input, "group")).toContain(JSON.stringify(input));
  expect(requiredCallClause("qq_group_moderation", input)).toContain(JSON.stringify(input));
  expect(input.groupId).toBe("1126022432");
  expect(input.params).toEqual({ duration: 30 });
});

it("binds a server projection callback to the exact Tool call and normalized output", async () => {
  const record = vi.fn(async (receipt: { context: unknown; input: unknown; output: unknown }) => {
    void receipt;
  });
  const definition = createProtectedTool<Record<string, unknown>, { visible: string }>({
    name: "qq_groups",
    description: "fixture",
    parameters: Type.Object({ value: Type.String() }),
    action: "read",
    resourceId: "canary",
    authService: allowAll,
    getContext: () => ({
      caller,
      conversationId: "conversation-projection",
      runId: "run-projection",
    }),
    execute: async (params) =>
      authorizationProjectionResult(
        { visible: "safe metadata" },
        {
          kind: "managed_group_inventory",
          purpose: "managed_group_category_availability",
          decisions: [],
          input: params,
          record,
        },
      ),
  });
  const result = await definition.execute(
    "call-projection",
    { value: "private-query" },
    undefined,
    undefined,
    {} as never,
  );
  const normalized = safeToolOutput("qq_groups", result);
  expect(record).toHaveBeenCalledTimes(1);
  const receipt = record.mock.calls[0]![0];
  expect(receipt.context).toMatchObject({
    runId: "run-projection",
    conversationId: "conversation-projection",
    toolCallId: "call-projection",
    caller: { principalId: "owner" },
  });
  expect(receipt.input).toMatchObject({
    inputSha256: expect.any(String),
    inputBytes: expect.any(Number),
  });
  expect(receipt.output).toEqual({
    outputSha256: normalized.outputSha256,
    outputBytes: normalized.outputBytes,
  });
  expect(JSON.stringify(receipt)).not.toContain("private-query");
});
