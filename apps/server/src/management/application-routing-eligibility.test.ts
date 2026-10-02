import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelProfileStore } from "../config/model-profiles.js";
import { configuredModelAdapter } from "../execution/model-adapter.js";
import type { ExecutionInput, RunExecutionAdapter } from "../execution/run-service/types.js";
import { textResponse } from "../model/testing/streams.js";
import { configuredPiModel } from "../runtime/pi/configured-model.js";
import { PiModelCatalog } from "../runtime/pi/model-catalog.js";
import { PiRunExecutionAdapter } from "../runtime/pi/run-adapter.js";
import type { PiRuntimeAdapter } from "../runtime/pi/types.js";
import { ManagementApplication } from "./application.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const input = (overrides: Partial<ExecutionInput> = {}): ExecutionInput =>
  ({
    caller: {
      principalId: "owner",
      scope: {
        connectionId: "fixture",
        botId: "bot",
        chatType: "private",
        chatId: "owner",
        senderId: "owner",
      },
    },
    conversation: {
      id: "conversation",
      agentId: "personal",
      scope: {
        connectionId: "fixture",
        botId: "bot",
        chatType: "private",
        chatId: "owner",
        senderId: "owner",
      },
    },
    run: { id: "run", source: "external" },
    text: "Describe the supplied input",
    history: [],
    providerSessionId: null,
    signal: new AbortController().signal,
    ...overrides,
  }) as ExecutionInput;

const imageInput = () =>
  input({ images: [{ mimeType: "image/png", data: "aW1hZ2UtZml4dHVyZQ==" }] });

async function fixture(kind: "model" | "pi" = "model") {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-routing-eligibility-"));
  directories.push(directory);
  const models = await ModelProfileStore.open(directory);
  const save = (id: string, overrides: Record<string, unknown> = {}) =>
    models.save({
      id,
      label: id,
      protocol: "openai-completions",
      baseUrl: `https://${id}.invalid/v1`,
      model: id,
      apiKey: "test-only-key",
      contextWindowTokens: 32_768,
      maxOutputTokens: 4_096,
      supportsTools: true,
      supportsVision: id === "vision",
      allowRouting: true,
      routingEnabled: true,
      routePriority: id === "text" ? 0 : 10,
      ...overrides,
    });
  await save("vision");
  await save("text");
  const events: Record<string, unknown>[] = [];
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      requests.push(url instanceof Request ? url.url : String(url));
      return textResponse("openai-completions", "fixture answer");
    }),
  );
  const runtimeHealthByProfile = new Map<
    string,
    {
      state: "healthy" | "degraded" | "unavailable" | "unknown";
      checkedAt: number;
      latencyMs: number;
      reasonCode: string | null;
    }
  >();
  let override: string | null = null;
  let owner = true;
  let defaultRef = `${kind}:vision`;
  let catalog: PiModelCatalog | undefined;
  const self = {
    options: { models },
    get piModelCatalog() {
      return catalog;
    },
    selectableModelProfiles: (includePi = true) => [
      ...models.list(),
      ...(includePi ? (catalog?.list() ?? []) : []),
    ],
    channels: {
      resolve: () => ({
        modelOverrideProfileId: override,
        executionRef: defaultRef,
        config: { connectionId: "fixture", botId: "bot", ownerId: "owner" },
      }),
    },
    store: {
      identities: { isOwner: async () => owner },
      lifecycle: { traceCaller: async () => input().caller },
      evidence: { advanceTrace: async () => {} },
    },
    trace: {
      append: async (_id: string, event: Record<string, unknown>) => {
        events.push(event);
        return {};
      },
    },
    runtimeHealthByProfile,
    runtimeModelsByRun: new Map(),
    runtimeUsageByRun: new Map(),
    directExecution: (reference: string): RunExecutionAdapter => {
      const profileId = reference.slice(kind.length + 1);
      if (kind === "model") return configuredModelAdapter({ profiles: models, profileId });
      let selected: Awaited<ReturnType<typeof configuredPiModel>>;
      const runtime: PiRuntimeAdapter = {
        initialize: async () => {},
        createOrRestoreSession: async () => {
          selected = await configuredPiModel(models, profileId, catalog);
          return {
            conversationId: "conversation",
            runtimeSessionId: "session",
            profileName: "main-agent",
            agentDir: directory,
            createdAt: "",
            lastActiveAt: "",
          };
        },
        getModelSupportsImages: () => selected.model.input.includes("image"),
        getModelCapacity: () => ({
          contextWindowTokens: selected.model.contextWindow,
          outputReserveTokens: selected.model.maxTokens,
          thinkingReserveTokens: 0,
          safetyMarginTokens: 512,
        }),
        run: async () => {
          requests.push(profileId);
          return { status: "completed", text: "fixture answer", toolCalls: [] };
        },
        abort: async () => {},
        disposeSession: async () => {},
        cleanup: async () => {},
      };
      return new PiRunExecutionAdapter(runtime);
    },
  };
  const adapter = (reference = `${kind}:vision`) =>
    (
      ManagementApplication.prototype as unknown as {
        execution(reference: string): RunExecutionAdapter;
      }
    ).execution.call(self, reference);
  return {
    models,
    save,
    events,
    requests,
    runtimeHealthByProfile,
    adapter,
    setOwner: (value: boolean) => {
      owner = value;
    },
    setDefault: (value: string) => {
      defaultRef = value;
    },
    setOverride: (id: string) => {
      override = id;
    },
    setExecutor: (execute: RunExecutionAdapter["execute"]) => {
      self.directExecution = () => ({ supportsGroup: true, supportsTaskStepModel: true, execute });
    },
    loadCatalog: async () => {
      const piDirectory = join(directory, "pi");
      await mkdir(piDirectory);
      await writeFile(
        join(piDirectory, "models.json"),
        JSON.stringify({
          providers: {
            fixture: {
              api: "openai-completions",
              baseUrl: "https://text.invalid/v1",
              models: [
                {
                  id: "text",
                  name: "Pi text",
                  contextWindow: 32_768,
                  maxTokens: 4_096,
                  input: ["text"],
                },
              ],
            },
          },
        }),
      );
      const authPath = join(piDirectory, "auth.json");
      const setKey = (key: boolean) =>
        writeFile(
          authPath,
          JSON.stringify(key ? { fixture: { type: "api_key", key: "pi-test-only-key" } } : {}),
        );
      await setKey(true);
      catalog = await PiModelCatalog.open(piDirectory);
      return { catalog, setKey, authPath };
    },
  };
}

describe.each(["model", "pi"] as const)("%s routing eligibility", (kind) => {
  it("routes loaded images past a higher-priority text-only model", async () => {
    const f = await fixture(kind);
    expect(await f.adapter().execute(imageInput())).toMatchObject({
      status: "succeeded",
      text: "fixture answer",
    });
    expect(f.requests).toHaveLength(1);
    expect(f.events.find((event) => event.type === "routing_decision")).toMatchObject({
      executionRef: `${kind}:vision`,
      candidates: [
        { profileId: "text", eligible: false, reason: "missing_capability" },
        { profileId: "vision", eligible: true },
      ],
    });
  });

  it("keeps ordinary text on the higher-priority text model", async () => {
    const f = await fixture(kind);
    expect(await f.adapter().execute(input())).toMatchObject({ status: "succeeded" });
    expect(f.events[0]).toMatchObject({ executionRef: `${kind}:text` });
    expect(f.requests).toHaveLength(1);
  });

  it("excludes a removed remote credential on every Run and restores eligibility immediately", async () => {
    const f = await fixture(kind);
    const adapter = f.adapter();
    await f.save("text", { apiKey: null });
    for (let index = 0; index < 2; index++)
      expect(await adapter.execute(input())).toMatchObject({ status: "succeeded" });
    expect(f.events.filter((event) => event.type === "routing_decision")).toMatchObject([
      {
        executionRef: `${kind}:vision`,
        candidates: [
          { profileId: "text", reason: "not_configured" },
          { profileId: "vision", eligible: true },
        ],
      },
      {
        executionRef: `${kind}:vision`,
        candidates: [
          { profileId: "text", reason: "not_configured" },
          { profileId: "vision", eligible: true },
        ],
      },
    ]);
    expect(f.runtimeHealthByProfile.has("text")).toBe(false);
    await f.save("text", { apiKey: "restored-test-only-key" });
    expect(await adapter.execute(input())).toMatchObject({ status: "succeeded" });
    expect(f.events.filter((event) => event.type === "routing_decision").at(-1)).toMatchObject({
      executionRef: `${kind}:text`,
    });
    expect(f.requests).toHaveLength(3);
    expect(JSON.stringify(f.events)).not.toMatch(/test-only-key|\.invalid|aW1hZ2U/u);
  });

  it.each(["http://localhost:9898/v1", "http://127.0.0.1:9898/v1", "http://[::1]:9898/v1"])(
    "keeps unauthenticated loopback eligible at %s",
    async (baseUrl) => {
      const f = await fixture(kind);
      await f.save("text", { apiKey: null, baseUrl });
      expect(await f.adapter().execute(input())).toMatchObject({ status: "succeeded" });
      expect(f.events[0]).toMatchObject({ executionRef: `${kind}:text` });
      expect(f.requests).toHaveLength(1);
    },
  );

  it.each(["vision", "credential"])(
    "rejects a pinned model missing %s without changing the requested model",
    async (missing) => {
      const f = await fixture(kind);
      f.setOverride("text");
      if (missing === "credential") await f.save("text", { apiKey: null });
      const result = await f
        .adapter(`${kind}:text`)
        .execute(missing === "vision" ? imageInput() : input());
      expect(result).toMatchObject({ status: "failed" });
      expect(f.requests).toEqual([]);
      expect(f.events[0]).toMatchObject({
        executionRef: null,
        reason: "no_route",
        candidates: [
          {
            profileId: "text",
            eligible: false,
            reason: missing === "vision" ? "missing_capability" : "not_configured",
          },
        ],
      });
      expect(f.runtimeHealthByProfile.size).toBe(0);
    },
  );

  it("makes no provider request when every allowed model lacks vision", async () => {
    const f = await fixture(kind);
    await f.save("vision", { supportsVision: false });
    expect(await f.adapter().execute(imageInput())).toMatchObject({ status: "failed" });
    expect(f.events[0]).toMatchObject({ executionRef: null, reason: "no_route" });
    expect(f.requests).toEqual([]);
    expect(f.runtimeHealthByProfile.size).toBe(0);
  });

  it("does not classify a local image explanation as provider health", async () => {
    const f = await fixture(kind);
    await f.save("text", { routingEnabled: false });
    const previous = {
      state: "healthy" as const,
      checkedAt: Date.now(),
      latencyMs: 12,
      reasonCode: null,
    };
    f.runtimeHealthByProfile.set("text", previous);
    const result = await f.adapter(`${kind}:text`).execute(imageInput());
    expect(result).toMatchObject({ status: "failed", runtimeAttempted: false });
    expect(f.requests).toEqual([]);
    expect(f.runtimeHealthByProfile.get("text")).toEqual(previous);
    expect(f.events).toContainEqual(
      expect.objectContaining({
        type: "runtime_health_observation",
        state: "unknown",
        measurement: "not_attempted",
        latencyMs: null,
      }),
    );
  });
});

it("honors matching Pi-only credentials and rechecks removal and restoration", async () => {
  const f = await fixture("pi");
  await f.save("text", { apiKey: null });
  const { setKey } = await f.loadCatalog();
  const adapter = f.adapter();
  expect(await adapter.execute(input())).toMatchObject({ status: "succeeded" });
  expect(f.events[0]).toMatchObject({ executionRef: "pi:text" });
  await setKey(false);
  expect(await adapter.execute(input())).toMatchObject({ status: "succeeded" });
  expect(f.events.filter((event) => event.type === "routing_decision").at(-1)).toMatchObject({
    executionRef: "pi:vision",
  });
  await setKey(true);
  expect(await adapter.execute(input())).toMatchObject({ status: "succeeded" });
  expect(f.events.filter((event) => event.type === "routing_decision").at(-1)).toMatchObject({
    executionRef: "pi:text",
  });
  expect(f.requests).toEqual(["text", "vision", "text"]);
  expect(JSON.stringify(f.events)).not.toContain("pi-test-only-key");
});

it("uses a native Pi catalog identity without a Glassbox credential", async () => {
  const f = await fixture("pi");
  const { catalog, setKey } = await f.loadCatalog();
  const nativeId = catalog.list().find((profile) => profile.model === "text")!.id;
  f.setOverride(nativeId);
  const adapter = f.adapter(`pi:${nativeId}`);
  expect(await adapter.execute(input())).toMatchObject({ status: "succeeded" });
  expect(f.events[0]).toMatchObject({ executionRef: `pi:${nativeId}` });
  await setKey(false);
  expect(await adapter.execute(input())).toMatchObject({
    status: "failed",
    failureCode: "model_credential_missing",
    runtimeAttempted: false,
  });
  expect(f.requests).toEqual([nativeId]);
  await setKey(true);
  expect(await adapter.execute(input())).toMatchObject({ status: "succeeded" });
  expect(f.requests).toEqual([nativeId, nativeId]);
});

it.each(["model", "pi"] as const)(
  "fails safely when %s routing is disabled but the credential was removed",
  async (kind) => {
    const f = await fixture(kind);
    await f.save("text", { routingEnabled: false, apiKey: null });
    expect(await f.adapter(`${kind}:text`).execute(input())).toMatchObject({
      status: "failed",
      failureCode: "model_credential_missing",
      runtimeAttempted: false,
    });
    expect(f.requests).toEqual([]);
    expect(f.runtimeHealthByProfile.size).toBe(0);
    expect(f.events.find((event) => event.type === "routing_eval_evidence")).toMatchObject({
      actualExecutionRef: null,
      actualProvider: null,
    });
  },
);

it.each(["model", "pi"] as const)(
  "makes no provider request when %s has no credential-eligible candidate",
  async (kind) => {
    const f = await fixture(kind);
    await f.save("text", { apiKey: null });
    await f.save("vision", { apiKey: null });
    expect(await f.adapter().execute(input())).toMatchObject({
      status: "failed",
      failureCode: "model_credential_missing",
      runtimeAttempted: false,
    });
    expect(f.requests).toEqual([]);
    expect(f.events[0]).toMatchObject({
      reason: "no_route",
      executionRef: null,
      candidates: [
        { profileId: "text", eligible: false, reason: "not_configured" },
        { profileId: "vision", eligible: false, reason: "not_configured" },
      ],
    });
  },
);

it("requires vision for a Pi task-step model even when tools are excluded", async () => {
  const f = await fixture("pi");
  await f.save("vision", { supportsTools: false });
  expect(
    await f.adapter().execute({ ...imageInput(), executionMode: "task_step_model" }),
  ).toMatchObject({ status: "succeeded" });
  expect(f.events[0]).toMatchObject({ executionRef: "pi:vision" });
  expect(f.requests).toEqual(["vision"]);
});

it.each(["model", "pi"] as const)(
  "classifies a %s credential removed after admission without inventing provider health",
  async (kind) => {
    const f = await fixture(kind);
    f.setExecutor(async (executionInput) => {
      await f.save("text", { apiKey: null });
      if (kind === "pi") await configuredPiModel(f.models, "text");
      return configuredModelAdapter({ profiles: f.models, profileId: "text" }).execute(
        executionInput,
      );
    });
    expect(await f.adapter().execute(input())).toMatchObject({
      status: "failed",
      failureCode: "model_credential_missing",
      runtimeAttempted: false,
    });
    expect(f.requests).toEqual([]);
    expect(f.runtimeHealthByProfile.size).toBe(0);
    expect(f.events).toContainEqual(
      expect.objectContaining({
        type: "runtime_health_observation",
        state: "unknown",
        measurement: "not_attempted",
        reasonCode: "model_credential_missing",
      }),
    );
    expect(f.events.find((event) => event.type === "routing_eval_evidence")).toMatchObject({
      actualExecutionRef: null,
    });
  },
);

it("records an unclassified executor exception as unknown without overwriting measured health", async () => {
  const f = await fixture();
  const previous = {
    state: "healthy" as const,
    checkedAt: Date.now(),
    latencyMs: 12,
    reasonCode: null,
  };
  f.runtimeHealthByProfile.set("text", previous);
  f.setExecutor(async () => {
    throw new Error("sensitive-fixture-provider-detail");
  });
  await expect(f.adapter().execute(input())).rejects.toThrow("sensitive-fixture-provider-detail");
  expect(f.runtimeHealthByProfile.get("text")).toEqual(previous);
  expect(f.events).toContainEqual(
    expect.objectContaining({
      type: "runtime_health_observation",
      state: "unknown",
      measurement: "unknown",
      latencyMs: null,
      reasonCode: "execution_error",
    }),
  );
  expect(JSON.stringify(f.events)).not.toContain("sensitive-fixture-provider-detail");
});

it("keeps policy outcome health separate from measured provider health", async () => {
  const f = await fixture();
  const previous = {
    state: "healthy" as const,
    checkedAt: Date.now(),
    latencyMs: 12,
    reasonCode: null,
  };
  f.runtimeHealthByProfile.set("text", previous);
  f.setExecutor(async () => ({ status: "failed", failureCode: "required_action_not_completed" }));
  await f.adapter().execute(input());
  expect(f.runtimeHealthByProfile.get("text")).toEqual(previous);
  expect(f.events).toContainEqual(
    expect.objectContaining({
      type: "runtime_health_observation",
      state: "degraded",
      measurement: "policy_result",
      latencyMs: null,
      reasonCode: "required_action_not_completed",
    }),
  );
});

it("isolates an unreadable Pi credential store to that candidate and keeps diagnostics safe", async () => {
  const f = await fixture("pi");
  await f.save("text", { apiKey: null });
  const { authPath } = await f.loadCatalog();
  await writeFile(authPath, "private-fixture-invalid-auth-json");
  expect(await f.adapter().execute(input())).toMatchObject({ status: "succeeded" });
  expect(f.events[0]).toMatchObject({
    executionRef: "pi:vision",
    candidates: [
      { profileId: "text", eligible: false, reason: "not_configured" },
      { profileId: "vision", eligible: true },
    ],
  });
  expect(f.requests).toEqual(["vision"]);
  expect(JSON.stringify(f.events)).not.toContain("private-fixture-invalid-auth-json");
});

it("does not treat a successful local image-load explanation as a provider observation", async () => {
  const f = await fixture();
  expect(await f.adapter().execute(input({ imageFailureCode: "image_unavailable" }))).toMatchObject(
    { status: "succeeded", runtimeAttempted: false },
  );
  expect(f.requests).toEqual([]);
  expect(f.runtimeHealthByProfile.size).toBe(0);
  expect(f.events).toContainEqual(
    expect.objectContaining({
      type: "runtime_health_observation",
      state: "unknown",
      measurement: "not_attempted",
      reasonCode: "local_response",
    }),
  );
  expect(f.events.find((event) => event.type === "routing_eval_evidence")).toMatchObject({
    actualExecutionRef: null,
    actualProvider: null,
  });
});

it("preserves Pi's supported Anthropic token path without giving it to the copied model provider", async () => {
  const f = await fixture("pi");
  await f.save("text", { protocol: "anthropic-messages", apiKey: "sk-ant-oat-fixture-only" });
  expect(await f.adapter().execute(input())).toMatchObject({ status: "succeeded" });
  expect(f.events[0]).toMatchObject({ executionRef: "pi:text" });
  expect(f.requests).toEqual(["text"]);
});

it("excludes an unsupported Anthropic token from copied model-provider routing", async () => {
  const f = await fixture();
  await f.save("text", { protocol: "anthropic-messages", apiKey: "sk-ant-oat-fixture-only" });
  expect(await f.adapter().execute(input())).toMatchObject({ status: "succeeded" });
  expect(f.events[0]).toMatchObject({
    executionRef: "model:vision",
    candidates: [
      { profileId: "text", eligible: false, reason: "not_configured" },
      { profileId: "vision", eligible: true },
    ],
  });
  expect(f.requests).toHaveLength(1);
  expect(JSON.stringify(f.events)).not.toContain("sk-ant-oat-fixture-only");
});

describe.each(["model", "pi"] as const)("Owner persisted override recovery: %s", (kind) => {
  it("falls back only to the configured channel default when the preference is unavailable", async () => {
    const f = await fixture(kind);
    await f.save("text", { routingAvailable: false });
    f.setOverride("text");
    const request = input();
    Object.assign(request.run, {
      executionRef: `${kind}:text`,
      channelDefaultExecutionRef: `${kind}:vision`,
    });
    const result = await f.adapter(`${kind}:text`).execute(request);
    expect(result).toMatchObject({ status: "succeeded" });
    expect(f.events[0]).toMatchObject({
      executionRef: `${kind}:vision`,
      reason: "default_fallback",
      usedFallback: true,
    });
    expect(f.requests).toHaveLength(1);
  });
});

describe.each(["model", "pi"] as const)("bounded preference fallback: %s", (kind) => {
  function preferenceInput() {
    const request = input();
    Object.assign(request.run, {
      executionRef: `${kind}:text`,
      channelDefaultExecutionRef: `${kind}:vision`,
    });
    return request;
  }

  it.each(["credential", "health", "operator", "vision", "capacity"])(
    "recovers an ineligible preference: %s",
    async (reason) => {
      const f = await fixture(kind);
      f.setOverride("text");
      await f.save("unrelated", { routePriority: 0 });
      if (reason === "credential") await f.save("text", { apiKey: null });
      if (reason === "operator") await f.save("text", { routingAvailable: false });
      if (reason === "capacity") await f.save("text", { contextWindowTokens: 5120 });
      if (reason === "health")
        f.runtimeHealthByProfile.set("text", {
          state: "unavailable",
          checkedAt: Date.now(),
          latencyMs: 1,
          reasonCode: "runtime_run_errored",
        });
      const request = preferenceInput();
      if (reason === "vision") request.images = imageInput().images;
      const result = await f.adapter(`${kind}:text`).execute(request);
      expect(result.status).toBe("succeeded");
      expect(f.events[0]).toMatchObject({
        executionRef: `${kind}:vision`,
        reason: "default_fallback",
      });
      expect(f.requests).toHaveLength(1);
      expect(JSON.stringify(f.events)).not.toContain("unrelated");
      expect(request.run.executionRef).toBe(`${kind}:text`);
      expect(f.events.find((event) => event.type === "routing_eval_evidence")).toMatchObject({
        actualExecutionRef: `${kind}:vision`,
        decisionExecutionRef: `${kind}:vision`,
      });
    },
  );

  it.each(["credential", "operator", "vision", "capacity"])(
    "rejects an ineligible default: %s",
    async (reason) => {
      const f = await fixture(kind);
      f.setOverride("text");
      await f.save("text", { routingAvailable: false });
      await f.save("unrelated", { routePriority: 0 });
      await f.save(
        "vision",
        reason === "credential"
          ? { apiKey: null }
          : reason === "operator"
            ? { routingAvailable: false }
            : reason === "vision"
              ? { supportsVision: false }
              : { contextWindowTokens: 5120 },
      );
      const request = preferenceInput();
      if (reason === "vision") request.images = imageInput().images;
      expect(await f.adapter(`${kind}:text`).execute(request)).toMatchObject({
        status: "failed",
        runtimeAttempted: false,
      });
      expect(f.events[0]).toMatchObject({ reason: "no_route", executionRef: null });
      expect(f.requests).toEqual([]);
    },
  );

  it.each(["default", "override", "owner", "group", "connection", "bot", "sender", "task"])(
    "fails closed on stale or mismatched preference provenance: %s",
    async (change) => {
      const f = await fixture(kind);
      f.setOverride("text");
      const request = preferenceInput();
      if (change === "default") f.setDefault(`${kind}:unrelated`);
      if (change === "override") f.setOverride("vision");
      if (change === "owner") f.setOwner(false);
      if (change === "group") request.caller.scope.chatType = "group";
      if (change === "connection") request.caller.scope.connectionId = "other";
      if (change === "bot") request.caller.scope.botId = "other";
      if (change === "sender") request.caller.scope.senderId = "other";
      if (change === "task") request.run.source = "task_step";
      expect(await f.adapter(`${kind}:text`).execute(request)).toMatchObject({
        status: "failed",
        runtimeAttempted: false,
      });
      expect(f.events[0]).toMatchObject({ reason: "no_route", executionRef: null });
      expect(f.requests).toEqual([]);
    },
  );

  it("does not replace an explicit default selection with a persisted preference", async () => {
    const f = await fixture(kind);
    f.setOverride("text");
    await f.save("vision", { routingEnabled: false });
    const request = input();
    request.run.executionRef = `${kind}:vision`;
    expect(await f.adapter(`${kind}:vision`).execute(request)).toMatchObject({
      status: "succeeded",
    });
    expect(f.events[0]).toMatchObject({ executionRef: `${kind}:vision` });
  });

  it("passes the same authorized input to the default without retrying failures", async () => {
    const f = await fixture(kind);
    f.setOverride("text");
    await f.save("text", { routingAvailable: false });
    const request = preferenceInput();
    const execute = vi.fn(async () => ({
      status: "failed" as const,
      failureCode: "runtime_run_errored" as const,
    }));
    f.setExecutor(execute);
    expect(await f.adapter(`${kind}:text`).execute(request)).toMatchObject({ status: "failed" });
    expect(execute).toHaveBeenCalledExactlyOnceWith(request);
  });
});

it.each(["model", "pi"] as const)(
  "keeps a healthy %s preference ahead of a higher-priority default",
  async (kind) => {
    const f = await fixture(kind);
    f.setOverride("text");
    await f.save("vision", { routePriority: 0 });
    await f.save("text", { routePriority: 100 });
    const request = input();
    Object.assign(request.run, {
      executionRef: `${kind}:text`,
      channelDefaultExecutionRef: `${kind}:vision`,
    });
    expect(await f.adapter(`${kind}:text`).execute(request)).toMatchObject({ status: "succeeded" });
    expect(f.events[0]).toMatchObject({
      executionRef: `${kind}:text`,
      reason: "selected",
      usedFallback: false,
    });
    expect(f.requests).toHaveLength(1);
  },
);

it.each(["model", "pi"] as const)(
  "does not route an explicit missing %s profile to arbitrary alternatives",
  async (kind) => {
    const f = await fixture(kind);
    const request = input();
    request.run.executionRef = `${kind}:missing`;
    expect(await f.adapter(`${kind}:missing`).execute(request)).toMatchObject({
      status: "failed",
      runtimeAttempted: false,
    });
    expect(f.events[0]).toMatchObject({
      executionRef: null,
      reason: "no_route",
      candidates: [{ profileId: "missing", eligible: false, reason: "not_configured" }],
    });
    expect(f.requests).toEqual([]);
  },
);
