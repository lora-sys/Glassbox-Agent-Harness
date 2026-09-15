import { describe, expect, it, vi } from "vite-plus/test";
import { Type } from "typebox";
import { createModelProvider } from "../../model/provider.ts";
import { eventStream, textResponse, toolResponse } from "../../model/testing/streams.ts";
import { runModelAgent, type AuthorizedModelTool, type ModelAgentEvent } from "./index.ts";

const protocol = "openai-completions";
const authorizedContext = {
  systemPrompt: "You can use the explicit public tool.",
  messages: [{ role: "user" as const, content: "Read the permitted fixture", timestamp: 1 }],
};
function fixture(responses: Array<() => Response>) {
  const requests: string[] = [];
  const fetch: typeof globalThis.fetch = async (_url, request) => {
    requests.push(typeof request?.body === "string" ? request.body : "");
    const next = responses.shift();
    if (!next) throw new Error("Unexpected extra model request");
    return next();
  };
  return {
    requests,
    provider: createModelProvider({
      profile: {
        id: "fixture",
        label: "Fixture",
        protocol,
        model: "test-model",
        baseUrl: "http://127.0.0.1:9898/v1",
        credentialSlot: null,
      },
      fetch,
    }),
  };
}
function publicTool(overrides: Partial<AuthorizedModelTool> = {}): AuthorizedModelTool {
  return {
    name: "read_public",
    description: "Read an allowed fixture",
    parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
    authorize: async () => true,
    execute: async () => ({ text: "Public fixture content" }),
    ...overrides,
  };
}

describe("copied Pi agent loop with Glassbox boundaries", () => {
  it("keeps hidden reasoning out of visible events and durable transcript messages", async () => {
    const { provider } = fixture([
      () =>
        eventStream([
          {
            choices: [
              {
                index: 0,
                delta: { role: "assistant", reasoning_content: "HIDDEN_REASONING_CANARY" },
                finish_reason: null,
              },
            ],
          },
          { choices: [{ index: 0, delta: { content: "Visible answer" }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]),
    ]);
    const events: ModelAgentEvent[] = [];
    const result = await runModelAgent({
      provider,
      authorizedContext,
      onEvent: (event) => {
        events.push(event);
      },
    });
    expect(result).toMatchObject({ status: "completed", text: "Visible answer" });
    expect(JSON.stringify({ result, events })).not.toContain("HIDDEN_REASONING_CANARY");
  });

  it("executes an authorized tool then returns a final answer", async () => {
    const { provider, requests } = fixture([
      () => toolResponse(protocol),
      () => textResponse(protocol, "The fixture says hello"),
    ]);
    const authorize = vi.fn<AuthorizedModelTool["authorize"]>(async () => true);
    const execute = vi.fn(async () => ({ text: "Public fixture content" }));
    const events: ModelAgentEvent[] = [];
    const result = await runModelAgent({
      provider,
      authorizedContext,
      tools: [publicTool({ authorize, execute })],
      onEvent: (event) => {
        events.push(event);
      },
    });
    expect(result).toMatchObject({
      status: "completed",
      turns: 2,
      toolCalls: 1,
      text: "The fixture says hello",
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(authorize.mock.calls.map((call) => call[2])).toEqual(["execute", "result"]);
    expect(requests[1]).toContain("Public fixture content");
    expect(events).toContainEqual({
      type: "tool_finished",
      id: "call_1",
      name: "read_public",
      success: true,
    });
    expect(JSON.stringify(events)).not.toContain("Public fixture content");
  });

  it("checks authorization at execution and excludes denied contents", async () => {
    const { provider, requests } = fixture([
      () => toolResponse(protocol),
      () => textResponse(protocol, "Access was denied"),
    ]);
    const execute = vi.fn(async () => ({ text: "OWNER_PRIVATE_CANARY" }));
    const result = await runModelAgent({
      provider,
      authorizedContext,
      tools: [publicTool({ authorize: async () => false, execute })],
    });
    expect(result.status).toBe("completed");
    expect(execute).not.toHaveBeenCalled();
    expect(requests[1]).toContain("Tool operation failed");
    expect(JSON.stringify({ result, requests })).not.toContain("OWNER_PRIVATE_CANARY");
  });

  it("rechecks after a tool finishes so revocation discards its result", async () => {
    const { provider, requests } = fixture([
      () => toolResponse(protocol),
      () => textResponse(protocol, "Result unavailable"),
    ]);
    const result = await runModelAgent({
      provider,
      authorizedContext,
      tools: [
        publicTool({
          authorize: async (_args, _signal, phase) => phase === "execute",
          execute: async () => ({ text: "REVOKED_PRIVATE_CANARY" }),
        }),
      ],
    });
    expect(result.status).toBe("completed");
    expect(JSON.stringify({ result, requests })).not.toContain("REVOKED_PRIVATE_CANARY");
  });

  it("rejects invalid arguments before authorization or execution", async () => {
    const { provider } = fixture([
      () =>
        toolResponse(protocol, "read_public", { path: "allowed.txt", extra: "PRIVATE_CANARY" } as {
          path: string;
        }),
      () => textResponse(protocol, "Arguments rejected"),
    ]);
    const authorize = vi.fn(async () => true);
    const execute = vi.fn(async () => ({ text: "unexpected" }));
    const events: ModelAgentEvent[] = [];
    const result = await runModelAgent({
      provider,
      authorizedContext,
      tools: [publicTool({ authorize, execute })],
      onEvent: (event) => {
        events.push(event);
      },
    });
    expect(result.status).toBe("completed");
    expect(authorize).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toContain("PRIVATE_CANARY");
  });

  it("stops repeated tool requests at the turn budget", async () => {
    const { provider, requests } = fixture([
      () => toolResponse(protocol),
      () => toolResponse(protocol),
    ]);
    const result = await runModelAgent({
      provider,
      authorizedContext,
      tools: [publicTool()],
      maxTurns: 2,
    });
    expect(result).toMatchObject({
      status: "limit_reached",
      error: "turn_limit",
      turns: 2,
      toolCalls: 2,
    });
    expect(requests).toHaveLength(2);
  });

  it("stops at the tool budget without executing excess calls", async () => {
    const { provider } = fixture([() => toolResponse(protocol), () => toolResponse(protocol)]);
    const execute = vi.fn(async () => ({ text: "public" }));
    const result = await runModelAgent({
      provider,
      authorizedContext,
      tools: [publicTool({ execute })],
      maxToolCalls: 1,
    });
    expect(result).toMatchObject({ status: "limit_reached", error: "tool_limit", toolCalls: 1 });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not install implicit host tools", async () => {
    const { provider, requests } = fixture([
      () => toolResponse(protocol, "bash"),
      () => textResponse(protocol, "No such tool"),
    ]);
    const result = await runModelAgent({ provider, authorizedContext });
    expect(result).toMatchObject({ status: "completed", toolCalls: 0 });
    expect(JSON.parse(requests[0])).not.toHaveProperty("tools");
  });

  it("hides a tool exception payload from both model and visible events", async () => {
    const { provider, requests } = fixture([
      () => toolResponse(protocol),
      () => textResponse(protocol, "Tool failed"),
    ]);
    const events: ModelAgentEvent[] = [];
    const result = await runModelAgent({
      provider,
      authorizedContext,
      tools: [
        publicTool({
          execute: async () => {
            throw new Error("TOOL_SECRET_CANARY");
          },
        }),
      ],
      onEvent: (event) => {
        events.push(event);
      },
    });
    expect(result.status).toBe("completed");
    expect(JSON.stringify({ result, events, requests })).not.toContain("TOOL_SECRET_CANARY");
  });

  it("cancels during a tool and waits for it to settle", async () => {
    let start!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { provider, requests } = fixture([() => toolResponse(protocol)]);
    const controller = new AbortController();
    let settled = false;
    const pending = runModelAgent({
      provider,
      authorizedContext,
      signal: controller.signal,
      tools: [
        publicTool({
          execute: async () => {
            start();
            await finished;
            return { text: "LATE_PRIVATE_RESULT" };
          },
        }),
      ],
    }).then((result) => {
      settled = true;
      return result;
    });
    await started;
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(JSON.stringify(result)).not.toContain("LATE_PRIVATE_RESULT");
    expect(requests).toHaveLength(1);
  });
});
