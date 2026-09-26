import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TrustedChannelScope } from "../identity/scope.js";
import type { ModelProfileStore } from "../config/model-profiles.js";
import { eventStream, textResponse } from "../model/testing/streams.js";
import { createApplicationFixtureScope } from "./application-test-helpers.js";
import type { ManagementApplication } from "./application.js";
import { OWNER_MODEL_ADMIN_TOOL } from "../runtime/pi/owner-model-tools.js";
import { piModelProfileId } from "../runtime/pi/model-catalog.js";

const { fixture, afterEachCleanup } = createApplicationFixtureScope();
afterEach(async () => {
  vi.unstubAllGlobals();
  await afterEachCleanup();
});

const privateOwnerScope: TrustedChannelScope = {
  connectionId: "fixture",
  botId: "10001",
  chatType: "private",
  chatId: "10002",
  senderId: "10002",
};

function modelStore(application: unknown): ModelProfileStore {
  return (application as { options: { models: ModelProfileStore } }).options.models;
}

function stubModelFetch(seenUrls: string[]) {
  vi.stubGlobal("fetch", async (input: string | URL) => {
    seenUrls.push(String(input));
    return textResponse("openai-completions", "routing fixture answer");
  });
}

async function configureModelRoute(
  application: ManagementApplication,
  profiles: readonly {
    id: string;
    routingEnabled?: boolean;
    allowRouting?: boolean;
    routingAvailable?: boolean;
    routePriority?: number;
    capabilityRank?: number;
    contextWindowTokens?: number;
    maxOutputTokens?: number;
    supportsTools?: boolean;
  }[],
) {
  const models = modelStore(application);
  for (const profile of profiles) {
    await models.save({
      ...profile,
      label: profile.id,
      protocol: "openai-completions",
      baseUrl: `http://127.0.0.1:9898/${profile.id}/v1`,
      model: `fixture-${profile.id}`,
      apiKey: null,
    });
  }
  const current = application.channels.resolve("fixture");
  await application.disconnectChannel("fixture");
  await application.saveChannel({
    id: "fixture",
    label: current.config.label,
    kind: "qq-onebot",
    endpoint: current.config.endpoint,
    botId: current.config.botId,
    ownerId: current.config.ownerId,
    visitorIds: [...current.config.visitorIds],
    groupIds: [...current.config.groupIds],
    token: current.token,
    executionRef: "model:origin",
  });
  await application.connectChannel("fixture");
}

async function executePrivateRun(
  application: Awaited<ReturnType<typeof fixture>>["app"],
  messageId: string,
  text: string,
  executionRef = "model:origin",
) {
  const accepted = await application.store.conversations.acceptIncoming({
    agentId: "personal",
    scope: privateOwnerScope,
    messageId,
    text,
    executionRef,
  });
  await application.runs.enqueueAccepted(accepted);
  const run = await application.runs.waitForRun(accepted.caller, accepted.run.id);
  await application.runs.drain();
  const page = await application.trace.readPage(run.id, { limit: 100 });
  const indexed = await application.store.evidence.getTrace(accepted.caller, run.id);
  return {
    accepted,
    run,
    events: page.records.map((record) => record.event as Record<string, unknown>),
    indexed,
  };
}

describe("Management model routing wrapper", () => {
  it("switches to a Pi-configured model and runs the next QQ execution through Pi", async () => {
    const directory = await mkdtemp(join(tmpdir(), "glassbox-pi-route-"));
    try {
      const secret = "pi-router-fixture-secret";
      await writeFile(
        join(directory, "models.json"),
        JSON.stringify({
          providers: {
            fixture: {
              name: "Fixture Provider",
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:9898/pi-fixture/v1",
              apiKey: secret,
              models: [
                {
                  id: "default-model",
                  name: "Default Pi Model",
                  contextWindow: 65_536,
                  maxTokens: 8_192,
                  input: ["text"],
                },
                {
                  id: "alternate-model",
                  name: "Alternate Pi Model",
                  contextWindow: 131_072,
                  maxTokens: 16_384,
                  input: ["text"],
                },
              ],
            },
          },
        }),
        "utf8",
      );
      const urls: string[] = [];
      stubModelFetch(urls);
      const f = await fixture(async () => ({ status: "failed" }), {
        piAgentDirectory: directory,
      });
      const defaultProfileId = piModelProfileId("fixture", "default-model");
      const alternateProfileId = piModelProfileId("fixture", "alternate-model");
      const current = f.app.channels.resolve("fixture");
      await f.app.disconnectChannel("fixture");
      await f.app.saveChannel({
        id: "fixture",
        label: current.config.label,
        kind: "qq-onebot",
        endpoint: current.config.endpoint,
        botId: current.config.botId,
        ownerId: current.config.ownerId,
        visitorIds: [...current.config.visitorIds],
        groupIds: [...current.config.groupIds],
        token: current.token,
        executionRef: `pi:${defaultProfileId}`,
      });
      await f.app.connectChannel("fixture");

      const accepted = await f.app.store.conversations.acceptIncoming({
        agentId: "personal",
        scope: privateOwnerScope,
        messageId: "switch-to-pi-native-model",
        text: "Bob，切换到 Fixture Provider / Alternate Pi Model 模型",
        executionRef: `pi:${defaultProfileId}`,
      });
      const toolContext = {
        caller: accepted.caller,
        conversationId: accepted.conversation.id,
        runId: accepted.run.id,
        requiredToolName: OWNER_MODEL_ADMIN_TOOL,
        requiredToolInput: { action: "select", profileId: alternateProfileId },
      };
      const app = f.app as unknown as {
        createRuntimeTools(getContext: () => typeof toolContext): Array<{
          name: string;
          execute(id: string, params: unknown): Promise<{ details?: unknown }>;
        }>;
      };
      const modelTool = app
        .createRuntimeTools(() => toolContext)
        .find((tool) => tool.name === OWNER_MODEL_ADMIN_TOOL);
      if (!modelTool) throw new Error("missing Owner model Tool");
      const inventory = await modelTool.execute("list", { action: "list" });
      expect(JSON.stringify(inventory.details)).toContain("Alternate Pi Model");
      expect(JSON.stringify(inventory.details)).toContain("131072");
      expect(JSON.stringify(inventory.details)).not.toContain(secret);
      await modelTool.execute("select", {
        action: "select",
        profileId: alternateProfileId,
      });
      expect(f.app.channels.resolve("fixture").modelOverrideProfileId).toBe(alternateProfileId);

      const switched = await executePrivateRun(
        f.app,
        "run-pi-native-alternate",
        "private fixture request",
        `pi:${alternateProfileId}`,
      );
      expect(switched.run.status).toBe("succeeded");
      expect(switched.run.executionRef).toBe(`pi:${alternateProfileId}`);
      expect(urls).toContain("http://127.0.0.1:9898/pi-fixture/v1/chat/completions");
      expect(switched.events.find((event) => event.type === "routing_decision")).toMatchObject({
        selectedProfileId: alternateProfileId,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("pins later Runs to the Owner-selected profile while keeping route evidence", async () => {
    const urls: string[] = [];
    stubModelFetch(urls);
    const f = await fixture(async () => ({ status: "failed" }));
    await configureModelRoute(f.app, [
      {
        id: "origin",
        routingEnabled: true,
        allowRouting: true,
        contextWindowTokens: 32_768,
        maxOutputTokens: 4_096,
      },
      {
        id: "alternate",
        contextWindowTokens: 65_536,
        maxOutputTokens: 8_192,
        supportsTools: true,
      },
    ]);
    await f.app.channels.setModelOverride("fixture", "alternate");

    const result = await executePrivateRun(
      f.app,
      "manual-model-override",
      "private fixture request",
      "model:alternate",
    );
    const decision = result.events.find((event) => event.type === "routing_decision");
    const evaluation = result.events.find((event) => event.type === "routing_eval_evidence");

    expect(result.run.status).toBe("succeeded");
    expect(urls.length).toBeGreaterThan(0);
    expect(
      urls.every((url) => url.includes("/alternate/v1/")),
      JSON.stringify(urls),
    ).toBe(true);
    expect(decision).toMatchObject({
      selectedProfileId: "alternate",
      executionRef: "model:alternate",
      reason: "selected",
    });
    expect(evaluation).toMatchObject({
      decisionExecutionRef: "model:alternate",
      actualExecutionRef: "model:alternate",
    });
  });

  it("switches the QQ model through the Owner Tool and persists it for subsequent Runs", async () => {
    const urls: string[] = [];
    stubModelFetch(urls);
    const f = await fixture(async () => ({ status: "failed" }));
    await configureModelRoute(f.app, [
      {
        id: "origin",
        routingEnabled: false,
        contextWindowTokens: 32_768,
        maxOutputTokens: 4_096,
        supportsTools: true,
      },
      {
        id: "alternate",
        contextWindowTokens: 65_536,
        maxOutputTokens: 8_192,
        supportsTools: true,
      },
    ]);
    const accepted = await f.app.store.conversations.acceptIncoming({
      agentId: "personal",
      scope: privateOwnerScope,
      messageId: "switch-model-tool",
      text: "Bob，切换到 fixture-alternate 模型",
      executionRef: "model:origin",
    });
    const toolContext = {
      caller: accepted.caller,
      conversationId: accepted.conversation.id,
      runId: accepted.run.id,
      requiredToolName: OWNER_MODEL_ADMIN_TOOL,
      requiredToolInput: { action: "select", profileId: "alternate" },
    };
    const appTools = (
      f.app as unknown as {
        createRuntimeTools(getContext: () => typeof toolContext): Array<{
          name: string;
          execute(id: string, params: unknown): Promise<{ details?: unknown }>;
        }>;
      }
    ).createRuntimeTools(() => toolContext);
    const modelTool = appTools.find((tool) => tool.name === OWNER_MODEL_ADMIN_TOOL);
    expect(await f.app.resolveRunToolNames(toolContext)).toContain(OWNER_MODEL_ADMIN_TOOL);
    if (!modelTool) throw new Error("missing Owner model Tool");
    const inventory = await modelTool.execute("list-models", { action: "list" });
    expect(JSON.stringify(inventory.details)).toContain("fixture-alternate");
    expect(JSON.stringify(inventory.details)).not.toContain("9898");
    await modelTool.execute("select-alternate", {
      action: "select",
      profileId: "alternate",
    });
    expect(f.app.channels.resolve("fixture").modelOverrideProfileId).toBe("alternate");
    urls.length = 0;

    const switchedRun = await executePrivateRun(
      f.app,
      "after-model-switch",
      "private fixture request",
      "model:alternate",
    );
    expect(switchedRun.run.status).toBe("succeeded");
    expect(switchedRun.run.executionRef).toBe("model:alternate");
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.at(-1)).toContain("/alternate/v1/");
    expect(switchedRun.events.find((event) => event.type === "routing_decision")).toMatchObject({
      selectedProfileId: "alternate",
      executionRef: "model:alternate",
    });

    const trace = await f.app.trace.readPage(accepted.run.id, { limit: 100 });
    expect(trace.records.map((record) => record.event)).toContainEqual(
      expect.objectContaining({
        type: "model_route_override",
        profileId: "alternate",
        appliesTo: "later_owner_private_runs_on_this_qq_connection",
      }),
    );
  });

  it("fails closed when a manually selected model has unknown context capacity", async () => {
    const urls: string[] = [];
    stubModelFetch(urls);
    const f = await fixture(async () => ({ status: "failed" }));
    await configureModelRoute(f.app, [
      {
        id: "origin",
        contextWindowTokens: 32_768,
        maxOutputTokens: 4_096,
      },
      { id: "uncertain", supportsTools: true },
    ]);
    await f.app.channels.setModelOverride("fixture", "uncertain");

    const result = await executePrivateRun(
      f.app,
      "manual-model-unknown-capacity",
      "private fixture request",
      "model:uncertain",
    );

    expect(result.run.status).toBe("failed");
    expect(urls).toEqual([]);
    expect(result.events.find((event) => event.type === "routing_decision")).toMatchObject({
      selectedProfileId: null,
      executionRef: null,
      reason: "no_route",
      candidates: [{ profileId: "uncertain", eligible: false, reason: "context_unknown" }],
    });
  });

  it("keeps the default execution when routing is disabled and persists scoped evidence", async () => {
    const urls: string[] = [];
    stubModelFetch(urls);
    const f = await fixture(async () => ({ status: "failed" }));
    await configureModelRoute(f.app, [
      {
        id: "origin",
        routingEnabled: false,
        contextWindowTokens: 32_768,
        maxOutputTokens: 4_096,
      },
    ]);

    const result = await executePrivateRun(f.app, "routing-disabled", "private fixture request");
    const decision = result.events.find((event) => event.type === "routing_decision");
    const evaluation = result.events.find((event) => event.type === "routing_eval_evidence");

    expect(result.run.status).toBe("succeeded");
    expect(result.run.executionRef).toBe("model:origin");
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/origin/v1/");
    expect(decision).toMatchObject({
      principalId: result.accepted.caller.principalId,
      conversationId: result.accepted.conversation.id,
      executionRef: "model:origin",
      reason: "routing_disabled",
    });
    expect(evaluation).toMatchObject({
      decisionExecutionRef: "model:origin",
      actualExecutionRef: "model:origin",
    });
    expect(result.indexed?.eventCount).toBe(result.events.length);
    expect(
      result.events.some((event) => event.type === "tool_started" || event.type === "tool_call"),
    ).toBe(false);
    expect(JSON.stringify(result.events)).not.toContain("private fixture request");
  });

  it("executes the selected opted-in profile and records the actual route", async () => {
    const urls: string[] = [];
    stubModelFetch(urls);
    const f = await fixture(async () => ({ status: "failed" }));
    await configureModelRoute(f.app, [
      {
        id: "origin",
        routingEnabled: true,
        routePriority: 100,
        contextWindowTokens: 32_768,
        maxOutputTokens: 4_096,
      },
      {
        id: "alternate",
        allowRouting: true,
        routePriority: 0,
        capabilityRank: 1,
        contextWindowTokens: 32_768,
        maxOutputTokens: 4_096,
      },
    ]);

    const result = await executePrivateRun(f.app, "routing-enabled", "private fixture request");
    const decision = result.events.find((event) => event.type === "routing_decision");
    const evaluation = result.events.find((event) => event.type === "routing_eval_evidence");

    expect(result.run.status).toBe("succeeded");
    expect(result.run.executionRef).toBe("model:origin");
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/alternate/v1/");
    expect(decision).toMatchObject({
      principalId: result.accepted.caller.principalId,
      conversationId: result.accepted.conversation.id,
      selectedProfileId: "alternate",
      executionRef: "model:alternate",
      reason: "selected",
      usedFallback: false,
    });
    expect(evaluation).toMatchObject({
      decisionExecutionRef: "model:alternate",
      actualExecutionRef: "model:alternate",
    });
    const scored = await f.app.evaluator.evaluate(
      result.accepted.caller,
      result.run.id,
      "routing-safety-v1",
    );
    expect(
      scored.assessment?.scores.find((score) => score.id === "decision_actual_model")?.value,
    ).toBe("pass");
    expect(
      scored.assessment?.scores.find((score) => score.id === "unknown_quota_honesty")?.value,
    ).toBe("pass");
    expect(result.indexed?.eventCount).toBe(result.events.length);
    expect(
      result.events.some((event) => event.type === "tool_started" || event.type === "tool_call"),
    ).toBe(false);
    expect(JSON.stringify(result.events)).not.toContain("private fixture request");
  });

  it("fails closed when enabled routing has no candidate that satisfies the context floor", async () => {
    const urls: string[] = [];
    stubModelFetch(urls);
    const f = await fixture(async () => ({ status: "failed" }));
    await configureModelRoute(f.app, [
      {
        id: "origin",
        routingEnabled: true,
        routePriority: 100,
        contextWindowTokens: 6_144,
        maxOutputTokens: 2_048,
      },
      {
        id: "alternate",
        allowRouting: true,
        routePriority: 0,
        capabilityRank: 1,
        contextWindowTokens: 6_144,
        maxOutputTokens: 2_048,
      },
    ]);

    const result = await executePrivateRun(f.app, "routing-no-candidate", "x");
    const decision = result.events.find((event) => event.type === "routing_decision");
    const evaluation = result.events.find((event) => event.type === "routing_eval_evidence");

    expect(result.run.status).toBe("failed");
    expect(urls).toEqual([]);
    expect(decision).toMatchObject({
      principalId: result.accepted.caller.principalId,
      executionRef: null,
      reason: "no_route",
      usedFallback: false,
    });
    expect(evaluation).toMatchObject({
      decisionExecutionRef: null,
      actualExecutionRef: null,
    });
    expect(result.indexed?.eventCount).toBe(result.events.length);
  });

  it("skips an operator-disabled model and records a successful safe fallback", async () => {
    const urls: string[] = [];
    stubModelFetch(urls);
    const f = await fixture(async () => ({ status: "failed" }));
    await configureModelRoute(f.app, [
      {
        id: "origin",
        routingEnabled: true,
        routingAvailable: false,
        routePriority: 0,
        contextWindowTokens: 32_768,
        maxOutputTokens: 4_096,
      },
      {
        id: "alternate",
        allowRouting: true,
        routePriority: 1,
        capabilityRank: 1,
        contextWindowTokens: 32_768,
        maxOutputTokens: 4_096,
      },
    ]);
    const result = await executePrivateRun(f.app, "routing-unavailable", "fixture request");
    expect(result.run.status).toBe("succeeded");
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/alternate/v1/");
    expect(result.events.find((event) => event.type === "routing_decision")).toMatchObject({
      executionRef: "model:alternate",
      candidates: [
        { profileId: "origin", eligible: false, reason: "health_unavailable" },
        { profileId: "alternate", eligible: true, reason: "eligible" },
      ],
    });
    const scored = await f.app.evaluator.evaluate(
      result.accepted.caller,
      result.run.id,
      "routing-safety-v1",
    );
    expect(
      scored.assessment?.scores.find((score) => score.id === "unavailable_fallback")?.value,
    ).toBe("pass");
  });

  it("records provider health and routes the next Run away from a failed profile", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      urls.push(url);
      return url.includes("/origin/v1/")
        ? Response.json({ error: { message: "fixture unavailable" } }, { status: 503 })
        : textResponse("openai-completions", "alternate answer");
    });
    const f = await fixture(async () => ({ status: "failed" }));
    await configureModelRoute(f.app, [
      {
        id: "origin",
        routingEnabled: true,
        allowRouting: true,
        routePriority: 0,
        contextWindowTokens: 32_768,
        maxOutputTokens: 4_096,
      },
      {
        id: "alternate",
        allowRouting: true,
        routePriority: 1,
        contextWindowTokens: 32_768,
        maxOutputTokens: 4_096,
      },
    ]);

    const failed = await executePrivateRun(f.app, "routing-health-failed", "fixture request");
    const recovered = await executePrivateRun(f.app, "routing-health-fallback", "fixture request");

    expect(failed.run.status).toBe("failed");
    expect(failed.events).toContainEqual(
      expect.objectContaining({
        type: "runtime_health_observation",
        executionRef: "model:origin",
        state: "unavailable",
        freshnessWindowMs: 60_000,
        reasonCode: "execution_failed",
      }),
    );
    expect(recovered.run.status).toBe("succeeded");
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("/origin/v1/");
    expect(urls[1]).toContain("/alternate/v1/");
    expect(recovered.events.find((event) => event.type === "routing_decision")).toMatchObject({
      executionRef: "model:alternate",
      candidates: [
        { profileId: "origin", eligible: false, reason: "health_unavailable" },
        { profileId: "alternate", eligible: true, reason: "eligible" },
      ],
    });
  });

  it("keeps SDK-derived token totals out of provider-reported usage evidence", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL) => {
      urls.push(String(input));
      return eventStream([
        {
          id: "derived-usage",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "answer" },
              finish_reason: null,
            },
          ],
        },
        {
          id: "derived-usage",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 3 },
        },
      ]);
    });
    const f = await fixture(async () => ({ status: "failed" }));
    await configureModelRoute(f.app, [
      {
        id: "origin",
        contextWindowTokens: 32_768,
        maxOutputTokens: 4_096,
      },
    ]);

    const result = await executePrivateRun(f.app, "routing-derived-usage", "fixture request");
    const evaluation = result.events.find((event) => event.type === "routing_eval_evidence");

    expect(result.run.status).toBe("succeeded");
    expect(urls).toHaveLength(1);
    expect(evaluation).toMatchObject({
      usage: {
        actualTokens: null,
        reportedTokens: null,
        reportedSource: "unknown",
      },
    });
  });

  it("upgrades only a pre-provider capacity overflow to a larger eligible profile", async () => {
    const urls: string[] = [];
    stubModelFetch(urls);
    const f = await fixture(async () => ({ status: "failed" }));
    await configureModelRoute(f.app, [
      {
        id: "origin",
        routingEnabled: true,
        routePriority: 0,
        contextWindowTokens: 10_000,
        maxOutputTokens: 8_192,
      },
      {
        id: "alternate",
        allowRouting: true,
        routePriority: 1,
        capabilityRank: 1,
        contextWindowTokens: 32_768,
        maxOutputTokens: 4_096,
      },
    ]);
    const result = await executePrivateRun(f.app, "routing-capacity-upgrade", "x".repeat(2_000));
    expect(result.run.status).toBe("succeeded");
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/alternate/v1/");
    expect(result.events.filter((event) => event.type === "routing_decision")).toMatchObject([
      { executionRef: "model:origin" },
      {
        trigger: "pre_provider_context_overflow",
        previousExecutionRef: "model:origin",
        executionRef: "model:alternate",
      },
    ]);
    expect(result.events.find((event) => event.type === "routing_eval_evidence")).toMatchObject({
      decisionExecutionRef: "model:alternate",
      actualExecutionRef: "model:alternate",
    });
  });
});
