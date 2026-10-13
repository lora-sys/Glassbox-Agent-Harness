import { describe, expect, it } from "vite-plus/test";
import {
  projectContextBudget,
  type ContextDemandEstimate,
  type ModelCapacity,
} from "../../efficiency/index.js";
import { availableRequestInputHeadroom, deriveRequestCapacity } from "./request-budget.js";

const equal256kCapacity: ModelCapacity = {
  contextWindowTokens: 256_000,
  outputReserveTokens: 128_000,
  thinkingReserveTokens: 128_000,
  safetyMarginTokens: 4_096,
};

function demand(overrides: Partial<ContextDemandEstimate> = {}): ContextDemandEstimate {
  return {
    estimatedMaterialTokens: 72_000,
    estimateSource: "unicode_conservative",
    hasLargeAuthorizedContext: false,
    requiredOutputClass: "standard",
    hasToolOrRetrieval: true,
    hasAttachmentsOrArtifacts: false,
    trustedPolicyFlags: [],
    systemTokens: 24_000,
    currentMessageTokens: 8_000,
    toolSchemaTokens: 6_000,
    requiredFloorTokens: 2_000,
    exchanges: [{ id: "prior", userTokens: 16_000, assistantTokens: 16_000 }],
    ...overrides,
  };
}

describe("Pi request capacity", () => {
  it("preserves the static reserve for models whose combined reserve is below the window", () => {
    const base: ModelCapacity = {
      contextWindowTokens: 256_000,
      outputReserveTokens: 24_576,
      thinkingReserveTokens: 0,
      safetyMarginTokens: 4_096,
    };
    const result = deriveRequestCapacity(base, demand(), null);
    expect(result).toMatchObject({
      ok: true,
      budget: { dynamic: false, capacity: base },
    });
  });

  it("derives a split request reserve from full current input without mutating the model ceiling", () => {
    const base = { ...equal256kCapacity };
    const result = deriveRequestCapacity(base, demand(), "medium");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const derived = result.budget.capacity;
    expect(result.budget.fullInputDemandTokens).toBe(72_000);
    expect(derived.outputReserveTokens + derived.thinkingReserveTokens).toBe(
      256_000 - 4_096 - 72_000,
    );
    expect(derived.thinkingReserveTokens).toBe(8_192);
    expect(derived.outputReserveTokens).toBeGreaterThanOrEqual(1_024);
    expect(base).toEqual(equal256kCapacity);
  });

  it("recomputes request reserve and future Tool-result headroom as input changes", () => {
    const short = deriveRequestCapacity(equal256kCapacity, demand(), "minimal");
    const long = deriveRequestCapacity(
      equal256kCapacity,
      demand({
        estimatedMaterialTokens: 172_000,
        exchanges: [{ id: "prior", userTokens: 66_000, assistantTokens: 66_000 }],
      }),
      "minimal",
    );
    expect(short.ok && long.ok).toBe(true);
    if (!short.ok || !long.ok) return;
    expect(short.budget.capacity.outputReserveTokens).toBeGreaterThan(
      long.budget.capacity.outputReserveTokens,
    );
    expect(availableRequestInputHeadroom(short.budget, 72_000)).toBe(
      256_000 - 4_096 - 2_048 - 72_000,
    );
  });

  it("uses the full material estimate and keeps reasoning disabled for non-reasoning models", () => {
    const materialIncludesLearning = demand({
      estimatedMaterialTokens: 90_000,
    });
    const result = deriveRequestCapacity(
      {
        ...equal256kCapacity,
        outputReserveTokens: 256_000,
        thinkingReserveTokens: 0,
      },
      materialIncludesLearning,
      null,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.budget.fullInputDemandTokens).toBe(90_000);
    expect(result.budget.capacity.thinkingReserveTokens).toBe(0);
    expect(result.budget.capacity.outputReserveTokens).toBe(256_000 - 4_096 - 90_000);
  });

  it("rejects an over-window required input floor instead of projecting it as fitting", () => {
    const oversized = demand({
      estimatedMaterialTokens: 260_000,
      systemTokens: 24_000,
      currentMessageTokens: 8_000,
      toolSchemaTokens: 6_000,
      requiredFloorTokens: 222_000,
      exchanges: [],
    });
    const result = deriveRequestCapacity(equal256kCapacity, oversized, "minimal");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(projectContextBudget(oversized, result.budget.capacity)).toMatchObject({
      ok: false,
      overflow: { kind: "fixed_floor_exceeds_capacity" },
    });
  });

  it("rejects unknown reasoning floor when dynamic capacity is required", () => {
    expect(deriveRequestCapacity(equal256kCapacity, demand(), "unrecognized")).toEqual({
      ok: false,
      reason: "invalid_thinking_level",
    });
  });
});
