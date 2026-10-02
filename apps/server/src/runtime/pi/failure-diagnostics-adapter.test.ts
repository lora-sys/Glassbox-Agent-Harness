import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ExecutionInput } from "../../execution/run-service/types.js";
import { runtimeHealthOf } from "../../management/runtime-health.js";
import { PiSdkRuntimeAdapter } from "./adapter.js";
import { PiRunExecutionAdapter } from "./run-adapter.js";
import type { PiNormalizedEvent, PiRunResult } from "./types.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture(options: {
  error?: string;
  stopReason?: "stop" | "error" | "aborted";
  text?: string;
  request?: string;
  throwError?: boolean;
  failEvidence?: boolean;
  cancel?: boolean;
  authorizedTools?: string[];
  group?: boolean;
}) {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-failure-diagnostic-"));
  directories.push(directory);
  const controller = new AbortController();
  const message = {
    role: "assistant",
    provider: "fixture",
    model: "fixture",
    stopReason: options.stopReason ?? "error",
    content: options.text ? [{ type: "text", text: options.text }] : [],
    errorMessage: options.error,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  };
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  const events: PiNormalizedEvent[] = [];
  const prompt = vi.fn(async () => {
    if (options.throwError) throw new Error(options.error);
    listener?.({ type: "turn_start" });
    listener?.({ type: "turn_end", message, toolResults: [] } as never);
    if (options.cancel) controller.abort();
  });
  const abort = vi.fn(async () => {});
  const sdk = new PiSdkRuntimeAdapter({
    kitPath: fileURLToPath(new URL("./fixtures/lora-pi-kit", import.meta.url)),
    runtimeBaseDir: directory,
    resolveToolNames: async () => options.authorizedTools ?? [],
    createSession: async () =>
      ({
        sessionId: "fixture-session",
        messages: [message],
        model: { input: ["text"], contextWindow: 32768, maxTokens: 4096, reasoning: false },
        subscribe(callback: (event: AgentSessionEvent) => void) {
          listener = callback;
          return () => {
            listener = undefined;
          };
        },
        prompt,
        abort,
        dispose() {},
      }) as never,
    onEvent(event) {
      events.push(event);
      if (options.failEvidence) throw new Error("recorder-secret-canary");
    },
  });
  let runtimeResult: PiRunResult | undefined;
  const sdkRun = sdk.run.bind(sdk);
  vi.spyOn(sdk, "run").mockImplementation(async (...args) => {
    runtimeResult = await sdkRun(...args);
    return runtimeResult;
  });
  const time = new Date(0).toISOString();
  const scope = {
    connectionId: "qq",
    botId: "bot",
    chatType: options.group ? ("group" as const) : ("private" as const),
    chatId: options.group ? "100" : "owner",
    senderId: "owner",
  };
  const input: ExecutionInput = {
    caller: { principalId: "owner", scope },
    conversation: {
      id: "conversation",
      agentId: "personal",
      principalId: "owner",
      scope,
      providerKind: null,
      providerSessionId: null,
      providerSessionPrincipalId: null,
      createdAt: time,
    },
    run: {
      id: "run",
      conversationId: "conversation",
      messageId: "message",
      source: "external",
      principalId: "owner",
      executionRef: "pi",
      status: "running",
      resultText: null,
      createdAt: time,
      updatedAt: time,
    },
    text: options.request ?? "讲个笑话",
    history: [],
    providerSessionId: null,
    signal: controller.signal,
  };
  const executor = new PiRunExecutionAdapter(sdk, { resolveProfileName: async () => "test" });
  try {
    const result = await executor.execute(input);
    return { result, runtimeResult, events, prompt, abort };
  } finally {
    await sdk.cleanup();
  }
}

describe("safe diagnostics across the actual Pi adapters", () => {
  it("explains an empty zero-token error and records only safe runtime-reported metadata", async () => {
    const f = await fixture({
      error: "HTTP 401 Unauthorized sk-secret-canary https://private.invalid/?key=secret",
    });
    expect(f.result).toMatchObject({
      status: "failed",
      failureCode: "runtime_run_errored",
      text: "运行时报告模型请求认证失败。请联系管理员检查模型凭据配置。",
    });
    expect(f.runtimeResult?.failure).toEqual({
      origin: "runtime_reported",
      category: "authentication",
      httpStatus: 401,
    });
    expect(f.events.find((event) => event.type === "turn_end")?.data).toMatchObject({
      stopReason: "error",
      usage: { totalTokens: 0 },
      failure: f.runtimeResult?.failure,
    });
    const recorded = JSON.stringify({ result: f.result, events: f.events });
    for (const canary of ["sk-secret-canary", "https://", "Unauthorized"])
      expect(recorded).not.toContain(canary);
    expect(runtimeHealthOf(f.result)).toEqual({
      state: "unavailable",
      reasonCode: "runtime_run_errored",
    });
  });

  it.each([
    undefined,
    "unknown failure",
    "source_context_revoked",
    "trace_write_failed",
    "HTTP 401 " + "x".repeat(8192),
  ])("keeps unclassified and spoofed provider errors unknown: %s", async (error) => {
    const f = await fixture({ error });
    expect(f.result.failureCode).toBe("runtime_run_errored");
    expect(f.result.text).toContain("没有可识别的错误类别");
    expect(f.runtimeResult?.failure).toEqual({ origin: "runtime_reported", category: "unknown" });
    expect(f.events.find((event) => event.type === "turn_end")?.data.failure).toEqual(
      f.runtimeResult?.failure,
    );
  });

  it("keeps a session exception local even when its message impersonates a provider status", async () => {
    const f = await fixture({ error: "HTTP 401 secret-canary", throwError: true });
    expect(f.runtimeResult?.failure).toEqual({ origin: "glassbox", category: "runtime_exception" });
    expect(f.result.failureCode).toBe("runtime_internal_error");
    expect(f.result.text).not.toContain("secret-canary");
    expect(f.result.text).not.toContain("认证失败");
    expect(runtimeHealthOf(f.result)).toBeUndefined();
  });

  it("keeps a failed evidence write out of provider health", async () => {
    const f = await fixture({ error: "HTTP 503 secret-canary", failEvidence: true });
    expect(f.runtimeResult?.failure).toEqual({ origin: "glassbox", category: "trace_write" });
    expect(f.result).toMatchObject({ status: "failed", failureCode: "runtime_internal_error" });
    expect(f.result.text).toContain("执行记录保存失败");
    expect(JSON.stringify(f.result)).not.toContain("secret-canary");
    expect(runtimeHealthOf(f.result)).toBeUndefined();
  });

  it.each(["stop", "error"] as const)("preserves nonempty output on %s", async (stopReason) => {
    const f = await fixture({
      error: "HTTP 401 secret-canary",
      stopReason,
      text: "已写好的部分回答",
    });
    expect(f.result.text).toBe("已写好的部分回答");
    expect(f.result.status).toBe(stopReason === "stop" ? "succeeded" : "failed");
    if (stopReason === "stop") {
      expect(f.runtimeResult?.failure).toBeUndefined();
      expect(f.events.find((event) => event.type === "turn_end")?.data.failure).toBeUndefined();
    }
  });

  it.each(["aborted", "signal"] as const)("preserves cancellation from %s", async (mode) => {
    const f = await fixture({
      error: "HTTP 401 secret-canary",
      stopReason: mode === "aborted" ? "aborted" : "error",
      cancel: mode === "signal",
    });
    expect(f.result).toMatchObject({ status: "cancelled" });
    expect(f.result.failureCode).toBeUndefined();
    expect(f.result.text ?? "").not.toContain("认证失败");
    expect(runtimeHealthOf(f.result)).toBeUndefined();
  });

  it("uses the diagnostic fallback for whitespace-only failed output", async () => {
    const f = await fixture({ error: "HTTP 429 too many requests", text: " \n " });
    expect(f.result.text).toBe("运行时报告模型请求触发限流。请稍后重试。");
  });

  it("keeps required evidence refusal ahead of a diagnostic reply", async () => {
    const f = await fixture({
      error: "HTTP 401 secret-canary",
      request: "这个群现在有多少成员？",
      group: true,
    });
    expect(f.result).toMatchObject({ status: "failed", failureCode: "required_evidence_missing" });
    expect(f.result.text).not.toContain("认证失败");
    expect(runtimeHealthOf(f.result)?.state).toBe("degraded");
  });

  it("keeps required-action refusal ahead of a diagnostic reply", async () => {
    const f = await fixture({
      error: "HTTP 401 secret-canary",
      request: "请启用群 1126022432 的 Bot 使用权限。",
      authorizedTools: ["owner_group_admin"],
    });
    expect(f.result).toMatchObject({
      status: "failed",
      failureCode: "required_action_not_completed",
    });
    expect(f.result.text).not.toContain("认证失败");
    expect(runtimeHealthOf(f.result)?.state).toBe("degraded");
  });
});

it("tags a real SDK context-budget refusal as a server-owned failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-budget-diagnostic-"));
  directories.push(directory);
  const events: PiNormalizedEvent[] = [];
  const model = {
    id: "fixture",
    name: "Fixture",
    api: "openai-completions",
    provider: "fixture",
    baseUrl: "http://fixture.invalid",
    input: ["text"],
    reasoning: false,
    contextWindow: 32768,
    maxTokens: 128,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as never;
  const modelRuntime = {
    hasConfiguredAuth: () => true,
    checkAuth: async () => undefined,
    isUsingOAuth: () => false,
    streamSimple: () => {
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant",
        content: [],
        api: "openai-completions",
        provider: "fixture",
        model: "fixture",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: "aborted",
        timestamp: Date.now(),
      } as never;
      queueMicrotask(() => stream.push({ type: "error", reason: "aborted", error: message }));
      return stream;
    },
  } as unknown as ModelRuntime;
  const sdk = new PiSdkRuntimeAdapter({
    kitPath: fileURLToPath(new URL("./fixtures/lora-pi-kit", import.meta.url)),
    runtimeBaseDir: directory,
    cwd: directory,
    model,
    modelRuntime,
    onEvent: (event) => {
      events.push(event);
    },
  });
  try {
    await sdk.initialize();
    const time = new Date(0).toISOString();
    const binding = await sdk.createOrRestoreSession(
      {
        id: "conversation",
        agentId: "personal",
        principalId: "owner",
        resourceId: "conversation-resource",
        scope: {
          channel: "qq",
          scopeType: "direct",
          scopeKey: "private",
          chatId: "owner",
          connectionId: "qq",
        },
        createdAt: time,
      },
      "test",
    );
    const result = await sdk.run(
      binding,
      {
        id: "run",
        conversationId: "conversation",
        messageId: "message",
        principalId: "owner",
        executionRef: "pi",
        status: "running",
        createdAt: time,
        updatedAt: time,
      },
      "文".repeat(100_000),
    );
    expect(result).toMatchObject({
      status: "error",
      text: "",
      failure: { origin: "glassbox", category: "context_budget" },
    });
    const terminal = events.find((event) => event.type === "turn_end");
    expect(terminal?.data.failure).toEqual(result.failure);
  } finally {
    await sdk.cleanup();
  }
});
