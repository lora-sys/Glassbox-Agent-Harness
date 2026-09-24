import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { TrustedChannelScope } from "../identity/scope.js";
import type { ModelProfileStore } from "../config/model-profiles.js";
import { textResponse } from "../model/testing/streams.js";
import { createApplicationFixtureScope } from "./application-test-helpers.js";
import type { ManagementApplication } from "./application.js";

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
    contextWindowTokens: number;
    maxOutputTokens: number;
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
) {
  const accepted = await application.store.conversations.acceptIncoming({
    agentId: "personal",
    scope: privateOwnerScope,
    messageId,
    text,
    executionRef: "model:origin",
  });
  await application.runs.enqueueAccepted(accepted);
  const run = await application.runs.waitForRun(accepted.caller, accepted.run.id);
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
});
