import { describe, expect, it } from "vitest";
import { selectRoute, toRoutingEvidence, type ModelCapacity, type RoutingInput } from "./index.js";

const runtime = (): ModelCapacity => ({
  profileId: "balanced",
  executionRef: "model:balanced",
  configured: true,
  capabilities: ["text", "tools", "thinking"],
  capabilityRank: 2,
  supportsThinking: true,
  usage: {
    inputTokens: null,
    outputTokens: null,
    concurrentRuns: 0,
    requestsPerMinute: null,
    tokensPerMinute: null,
  },
  limits: {
    contextWindowTokens: 32_000,
    maxOutputTokens: 4_000,
    maxConcurrentRuns: 2,
    requestsPerMinute: null,
    tokensPerMinute: null,
  },
  health: { state: "healthy", checkedAt: null, latencyMs: null, reasonCode: null },
});

const input = (overrides: Partial<RoutingInput> = {}): RoutingInput => ({
  task: {
    risk: "low",
    requiredCapabilities: ["text"],
    requiredContextTokens: 2_000,
    requiredOutputTokens: 500,
    thinking: "disabled",
  },
  candidates: [runtime()],
  options: {
    enabled: true,
    allowedProfileIds: ["balanced"],
    routeOrder: ["balanced"],
    defaultExecutionRef: "pi:default",
    capabilityFloorByRisk: { low: 0, medium: 1, high: 2 },
    allowUnknownHealth: false,
    allowUnknownCapacity: false,
  },
  ...overrides,
});

describe("selectRoute", () => {
  it("preserves the configured default route while routing is disabled", () => {
    const route = selectRoute(input({ options: { ...input().options, enabled: false } }));
    expect(route).toMatchObject({
      executionRef: "pi:default",
      selectedProfileId: null,
      reason: "routing_disabled",
      usedFallback: true,
    });
  });

  it("requires explicit profile opt-in and configured state", () => {
    const unopted = selectRoute(input({ options: { ...input().options, allowedProfileIds: [] } }));
    expect(unopted.candidates[0]?.reason).toBe("not_opted_in");
    expect(unopted).toMatchObject({ executionRef: null, reason: "no_route" });

    const unconfigured = runtime();
    unconfigured.configured = false;
    const notConfigured = selectRoute(input({ candidates: [unconfigured] }));
    expect(notConfigured.candidates[0]?.reason).toBe("not_configured");
  });

  it("enforces the risk capability floor and required capabilities", () => {
    const lowRank = runtime();
    lowRank.capabilityRank = 1;
    const route = selectRoute(
      input({
        task: { ...input().task, risk: "high", requiredCapabilities: ["text", "vision"] },
        candidates: [lowRank],
      }),
    );
    expect(route.candidates[0]?.reason).toBe("missing_capability");

    const withoutVision = runtime();
    withoutVision.capabilities = ["text"];
    withoutVision.capabilityRank = 1;
    const riskOnly = selectRoute(
      input({
        task: { ...input().task, risk: "high" },
        candidates: [withoutVision],
      }),
    );
    expect(riskOnly.candidates[0]?.reason).toBe("capability_below_floor");
  });

  it("requires known thinking support only when requested", () => {
    const noThinking = runtime();
    noThinking.supportsThinking = null;
    const route = selectRoute(
      input({ task: { ...input().task, thinking: "required" }, candidates: [noThinking] }),
    );
    expect(route.candidates[0]?.reason).toBe("thinking_unknown");
  });

  it("prefers thinking-capable candidates while preserving configured order otherwise", () => {
    const first = runtime();
    first.profileId = "first";
    first.executionRef = "model:first";
    first.supportsThinking = false;
    const second = runtime();
    second.profileId = "second";
    second.executionRef = "model:second";
    const route = selectRoute(
      input({
        task: { ...input().task, thinking: "preferred" },
        candidates: [first, second],
        options: {
          ...input().options,
          allowedProfileIds: ["first", "second"],
          routeOrder: ["first", "second"],
        },
      }),
    );
    expect(route.selectedProfileId).toBe("second");
  });

  it("uses configured route order and falls back deterministically", () => {
    const limited = runtime();
    limited.profileId = "small";
    limited.executionRef = "model:small";
    limited.limits.contextWindowTokens = 1_000;
    const selected = selectRoute(
      input({
        candidates: [limited, runtime()],
        options: { ...input().options, routeOrder: ["small", "balanced"] },
      }),
    );
    expect(selected.selectedProfileId).toBe("balanced");
    expect(selected.candidates.map(({ profileId }) => profileId)).toEqual(["small", "balanced"]);

    const fallback = selectRoute(
      input({
        options: {
          ...input().options,
          routeOrder: ["missing"],
          defaultExecutionRef: "model:balanced",
        },
      }),
    );
    expect(fallback).toMatchObject({
      executionRef: "model:balanced",
      selectedProfileId: "balanced",
      reason: "default_fallback",
      usedFallback: true,
    });

    const noDefault = selectRoute(
      input({ options: { ...input().options, routeOrder: ["missing"] } }),
    );
    expect(noDefault).toMatchObject({
      executionRef: null,
      reason: "no_route",
      usedFallback: false,
    });
  });

  it("refuses default fallback when the default candidate fails task gates", () => {
    const defaultCandidate = runtime();
    defaultCandidate.limits.contextWindowTokens = 1_000;
    const route = selectRoute(
      input({
        candidates: [defaultCandidate],
        options: {
          ...input().options,
          routeOrder: [],
          defaultExecutionRef: "model:balanced",
        },
      }),
    );
    expect(route).toMatchObject({ executionRef: null, reason: "no_route", usedFallback: false });
    expect(route.candidates).toContainEqual({
      profileId: "balanced",
      eligible: false,
      reason: "context_limit",
    });
  });

  it("treats unknown health and capacity as unknown unless explicitly allowed", () => {
    const unknown = runtime();
    unknown.health.state = "unknown";
    unknown.limits.contextWindowTokens = null;
    const conservative = selectRoute(input({ candidates: [unknown] }));
    expect(conservative.candidates[0]?.reason).toBe("health_unknown");

    const allowHealth = selectRoute(
      input({
        candidates: [unknown],
        options: { ...input().options, allowUnknownHealth: true },
      }),
    );
    expect(allowHealth.candidates[0]?.reason).toBe("context_unknown");
  });

  it("rejects known context, output, and concurrency limits", () => {
    const candidate = runtime();
    candidate.limits.maxOutputTokens = 100;
    candidate.usage.concurrentRuns = 2;
    const route = selectRoute(
      input({
        task: { ...input().task, requiredOutputTokens: 200 },
        candidates: [candidate],
      }),
    );
    expect(route.candidates[0]?.reason).toBe("output_limit");

    candidate.limits.maxOutputTokens = 4_000;
    const concurrency = selectRoute(input({ candidates: [candidate] }));
    expect(concurrency.candidates[0]?.reason).toBe("concurrency_limit");
  });

  it("emits evidence without endpoints, credentials, prompts, or result text", () => {
    const decision = selectRoute(input());
    const evidence = toRoutingEvidence(input(), decision);
    expect(evidence).toMatchObject({
      schema: "glassbox.routing-decision.v1",
      selectedProfileId: "balanced",
      observedHealth: "healthy",
      usage: { inputTokens: null, outputTokens: null },
      limits: { requestsPerMinute: null, tokensPerMinute: null },
    });
    expect(JSON.stringify(evidence)).not.toMatch(/prompt|apiKey|baseUrl|resultText|secret/u);
  });
});
