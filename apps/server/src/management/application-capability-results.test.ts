import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { OneBotCapabilityResult } from "../channels/onebot/adapter.js";
import { ModelProfileStore } from "../config/model-profiles.js";
import { ManagementApplication } from "./application.js";
import type { PiRunContext } from "../runtime/pi/types.js";

/** Real application wiring with a disposable provider boundary. No socket or live QQ state. */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-capability-results-"));
  const app = await ManagementApplication.open({
    dataDirectory: directory,
    databasePath: ":memory:",
    piAgentDirectory: null,
    kitPath: fileURLToPath(new URL("../runtime/pi/fixtures/lora-pi-kit", import.meta.url)),
    models: await ModelProfileStore.open(directory),
  });
  const scope = {
    connectionId: "fixture",
    botId: "10001",
    chatType: "private" as const,
    chatId: "10002",
    senderId: "10002",
  };
  await app.store.identities.bindOwner("owner", scope);
  await app.store.authorization.registerResource({
    id: "group:10003",
    kind: "qq_group",
    visibility: "public",
    ifAbsent: true,
  });
  for (const [resourceId, action] of [
    ["agent:personal", "run:create"],
    ["agent:personal", "trace:write"],
    ["agent:personal", "account:status:read"],
    ["group:10003", "group:members:read"],
    ["group:10003", "group:moderate"],
  ])
    await app.store.authorization.grant({
      principalId: "owner",
      resourceId: resourceId!,
      action: action!,
      scope,
      effect: "allow",
    });
  await app.store.capabilities.write({
    connectionId: "fixture",
    groupId: "10003",
    principalId: "owner",
    policy: {
      categories: { "group.members": true, "group.moderate": true },
      memorySources: {},
    },
  });
  const accepted = await app.store.conversations.acceptIncoming({
    agentId: "personal",
    scope,
    messageId: "projection",
    text: "read",
    executionRef: "pi:test",
  });
  const context: PiRunContext = {
    caller: { principalId: "owner", scope },
    runId: accepted.run.id,
    conversationId: accepted.conversation.id,
    authorizedToolNames: ["qq_account_status", "qq_group_members", "qq_group_moderation"],
  };
  const verifiedInputs: Array<{
    runId: string;
    conversationId: string;
    principalId: string;
    toolCallId: string;
    toolName: "qq_group_members" | "qq_group_moderation";
    leaseId: string | null;
    action: "get_group_member_info" | "set_group_ban";
    resourceId: string;
    inputSha256: string;
    inputBytes: number;
  }> = [];
  const executionOrder: string[] = [];
  context.recordQqToolExecutionInput = async (record) => {
    executionOrder.push("witness");
    verifiedInputs.push({ runId: context.runId!, ...record });
  };
  const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
  const responses = new Map<string, OneBotCapabilityResult>();
  let response: OneBotCapabilityResult = { status: "ok", data: null };
  const application = app as unknown as {
    connections: Map<
      string,
      {
        invokeCapability(input: {
          action: string;
          params: Record<string, unknown>;
        }): Promise<OneBotCapabilityResult>;
        stop(): Promise<void>;
      }
    >;
    createRuntimeTools(
      getContext: () => PiRunContext,
      definitionContext?: Readonly<PiRunContext>,
    ): ToolDefinition[];
  };
  application.connections.set("fixture", {
    invokeCapability: async (input) => {
      executionOrder.push("provider");
      calls.push(input);
      return responses.get(input.action) ?? response;
    },
    stop: async () => {},
  });
  const toolsFor = (value: PiRunContext) => application.createRuntimeTools(() => value, value);
  const tools = toolsFor(context);
  return {
    context,
    calls,
    verifiedInputs,
    executionOrder,
    responses,
    app,
    tools,
    toolsFor,
    set response(value: OneBotCapabilityResult) {
      response = value;
    },
    call: (name: string, input: Record<string, unknown>) =>
      tools
        .find((tool) => tool.name === name)!
        .execute("fixture", input, undefined, undefined, {} as never),
    close: async () => {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it("passes the SDK definition context through the application capability factory", async () => {
  const f = await fixture();
  try {
    const branches = (schema: unknown) => {
      const value = schema as {
        anyOf?: Array<{
          properties?: Record<string, unknown>;
          required?: string[];
        }>;
        properties?: Record<string, unknown>;
        required?: string[];
      };
      return value.anyOf ?? [value];
    };
    const privateMembers = branches(
      f.tools.find((tool) => tool.name === "qq_group_members")!.parameters,
    );
    expect(privateMembers.length).toBeGreaterThan(0);
    for (const branch of privateMembers) {
      expect(branch.properties).toHaveProperty("groupId");
      expect(branch.required).toContain("groupId");
    }

    const scope = {
      ...f.context.caller!.scope,
      chatType: "group" as const,
      chatId: "10003",
    };
    const groupContext: PiRunContext = {
      ...f.context,
      caller: { principalId: "owner", scope },
    };
    const groupTools = f.toolsFor(groupContext);
    const groupMembers = branches(
      groupTools.find((tool) => tool.name === "qq_group_members")!.parameters,
    );
    expect(groupMembers.length).toBeGreaterThan(0);
    for (const branch of groupMembers) {
      expect(branch.properties).not.toHaveProperty("groupId");
      expect(branch.required ?? []).not.toContain("groupId");
    }
  } finally {
    await f.close();
  }
});

it.each([
  {
    name: "qq_account_status",
    input: { operation: "get_login_info" },
    data: { user_id: 10001, nickname: "private-account-name" },
    expected: { botId: "10001" },
  },
  {
    name: "qq_group_members",
    input: { groupId: "10003", operation: "get_group_member_list" },
    data: [{ user_id: 10004, role: "member", nickname: "private-member-name" }],
    expected: {
      memberCount: 1,
      members: [{ qqId: "10004", groupRole: "member", nickname: "private-member-name" }],
      truncated: false,
    },
  },
  {
    name: "qq_group_members",
    input: {
      groupId: "10003",
      operation: "get_group_member_info",
      params: { user_id: 10004 },
    },
    data: {
      user_id: 10004,
      group_id: 10003,
      role: "admin",
      nickname: "private-member-name",
    },
    expected: {
      qqId: "10004",
      memberExists: true,
      groupRole: "admin",
      nickname: "private-member-name",
    },
  },
])(
  "projects verified OneBot data through ManagementApplication and the actual Tool: $input.operation",
  async ({ name, input, data, expected }) => {
    const f = await fixture();
    try {
      f.response = { status: "ok", data };
      const result = await f.call(name, input);
      expect(result.details).toEqual(expected);
      if (name === "qq_account_status") expect(JSON.stringify(result)).not.toContain("private-");
      else expect(JSON.stringify(result)).toContain("private-member-name");
    } finally {
      await f.close();
    }
  },
);

it("records a digest of the normalized Bot-role provider input before OneBot invocation", async () => {
  const f = await fixture();
  try {
    f.response = {
      status: "ok",
      data: { group_id: 10003, user_id: 10004, role: "admin" },
    };
    await f.call("qq_group_members", {
      groupId: "10003",
      operation: "get_group_member_info",
      params: { user_id: 10004 },
    });
    const canonical = '{"group_id":10003,"user_id":10004}';
    expect(f.verifiedInputs).toEqual([
      {
        runId: f.context.runId,
        conversationId: f.context.conversationId,
        principalId: "owner",
        toolCallId: "fixture",
        toolName: "qq_group_members",
        leaseId: null,
        action: "get_group_member_info",
        resourceId: "group:10003",
        inputSha256: createHash("sha256").update(canonical, "utf8").digest("hex"),
        inputBytes: Buffer.byteLength(canonical, "utf8"),
      },
    ]);
    expect(f.executionOrder).toEqual(["witness", "provider"]);
    expect(JSON.stringify(f.verifiedInputs)).not.toMatch(/params|user_id|group_id/u);
  } finally {
    await f.close();
  }
});

it("does not invoke OneBot when verified-input evidence persistence fails", async () => {
  const f = await fixture();
  try {
    f.context.recordQqToolExecutionInput = async () => {
      throw new Error("trace_write_failed");
    };
    await expect(
      f.call("qq_group_members", {
        groupId: "10003",
        operation: "get_group_member_info",
        params: { user_id: 10004 },
      }),
    ).rejects.toThrow("protected_tool_failed");
    expect(f.calls).toEqual([]);
    expect(f.executionOrder).toEqual([]);
  } finally {
    await f.close();
  }
});

it("keeps the generic mutation success envelope and refuses failed provider envelopes", async () => {
  const f = await fixture();
  try {
    const input = {
      groupId: "10003",
      operation: "set_group_ban",
      params: { user_id: 10004, duration: 30 },
    };
    f.context.requiredToolName = "qq_group_moderation";
    f.context.requiredToolInput = input;
    f.response = { status: "ok", data: null };
    expect((await f.call("qq_group_moderation", input)).details).toEqual({
      status: "ok",
      data: null,
    });
    f.response = { status: "failed", code: "api_rejected", retcode: 100 };
    await expect(f.call("qq_account_status", { operation: "get_login_info" })).rejects.toThrow(
      "provider_failed",
    );
  } finally {
    await f.close();
  }
});

it("resolves a nickname through the real application projection and records its exact target", async () => {
  const f = await fixture();
  try {
    f.responses.set("get_group_member_list", {
      status: "ok",
      data: [
        { user_id: 10004, card: "Ripped", nickname: "private-roster-name" },
        { user_id: 10005, nickname: "unrelated-private-name" },
      ],
    });
    const input = {
      groupId: "10003",
      operation: "set_group_ban",
      memberSelector: "Ripped",
      params: { duration: 30 },
    };
    f.context.requiredToolName = "qq_group_moderation";
    f.context.requiredToolInput = input;
    const result = await f.call("qq_group_moderation", input);
    expect(result.details).toEqual({ status: "ok", data: null });
    expect(f.calls).toEqual([
      { action: "get_group_member_list", params: { group_id: 10003 } },
      {
        action: "set_group_ban",
        params: { group_id: 10003, user_id: 10004, duration: 30 },
      },
    ]);
    const trace = await f.app.trace.readPage(f.context.runId!);
    expect(JSON.stringify(trace)).toContain("moderation_target_resolution");
    expect(JSON.stringify(trace)).toContain('"resolvedUserId":"10004"');
    expect(JSON.stringify(trace)).toContain("rosterReadDecisionId");
    expect(JSON.stringify(trace)).not.toContain("private-roster-name");
    expect(JSON.stringify(trace)).not.toContain("unrelated-private-name");
    expect(JSON.stringify(result)).not.toContain("Ripped");
    const sources = await f.app.store.db.transaction((tx) =>
      tx.execute({
        sql: "SELECT action, policy_condition_json FROM authorization_decisions WHERE run_id = ? AND delivery_source = 'content_source'",
        args: [f.context.runId!],
      }),
    );
    expect(sources.rows).toHaveLength(2);
    for (const source of sources.rows) {
      expect(source.action).toBe("group:members:read");
      if (typeof source.policy_condition_json !== "string")
        throw new Error("Missing source policy");
      expect(JSON.parse(source.policy_condition_json)).toEqual({
        version: 1,
        kind: "qq_category",
        connectionId: "fixture",
        groupId: "10003",
        category: "group.members",
      });
    }
  } finally {
    await f.close();
  }
});

it.each([
  { status: "unknown", code: "timeout" },
  { status: "failed", code: "not_connected" },
  { status: "rejected", code: "action_not_allowlisted" },
] as const)("never unwraps an unsuccessful projection response: $status", async (response) => {
  const f = await fixture();
  try {
    f.response = response;
    await expect(
      f.call("qq_group_members", {
        groupId: "10003",
        operation: "get_group_member_list",
      }),
    ).rejects.toThrow(/^provider_/u);
  } finally {
    await f.close();
  }
});

it("refuses a nested data-shaped object instead of blindly unwrapping it", async () => {
  const f = await fixture();
  try {
    f.response = {
      status: "ok",
      data: { data: [{ user_id: 10004, nickname: "private-name" }] },
    };
    await expect(
      f.call("qq_group_members", {
        groupId: "10003",
        operation: "get_group_member_list",
      }),
    ).rejects.toThrow("invalid_response");
  } finally {
    await f.close();
  }
});
