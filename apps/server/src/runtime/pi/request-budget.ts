import {
  DEFAULT_THINKING_BUDGETS,
  MIN_ANSWER_TOKENS,
} from "@earendil-works/pi-ai/api/simple-options";
import type { ContextDemandEstimate, ModelCapacity } from "../../efficiency/index.js";

export const REQUEST_CAPACITY_POLICY_VERSION = {
  static: "p5a-context-v1",
  dynamic: "p5a-pi-dynamic-output-v1",
} as const;

export type RequestCapacityPolicyVersion =
  (typeof REQUEST_CAPACITY_POLICY_VERSION)[keyof typeof REQUEST_CAPACITY_POLICY_VERSION];

export interface RequestCapacityBudget {
  capacity: ModelCapacity;
  policyVersion: RequestCapacityPolicyVersion;
  dynamic: boolean;
  fullInputDemandTokens: number;
  minimumOutputTokens: number;
  minimumThinkingTokens: number;
  minimumCombinedReserveTokens: number;
  headroomReserveTokens: number;
}

export type RequestCapacityResult =
  | { ok: true; budget: RequestCapacityBudget }
  | {
      ok: false;
      reason: "invalid_demand" | "invalid_thinking_level" | "output_floor_exceeds_ceiling";
    };

function thinkingFloor(level: string | null | undefined, enabled: boolean): number | undefined {
  if (!enabled) return 0;
  if (level === "max" || level === "xhigh") return DEFAULT_THINKING_BUDGETS.high;
  if (level === "minimal" || level === "low" || level === "medium" || level === "high")
    return DEFAULT_THINKING_BUDGETS[level];
  return undefined;
}

function fullInputDemandTokens(demand: ContextDemandEstimate): number | undefined {
  const components = [
    demand.systemTokens,
    demand.currentMessageTokens,
    demand.toolSchemaTokens,
    demand.requiredFloorTokens,
    ...demand.exchanges.flatMap((exchange) => [exchange.userTokens, exchange.assistantTokens]),
  ];
  if (
    components.some((tokens) => !Number.isSafeInteger(tokens) || tokens < 0) ||
    !Number.isSafeInteger(demand.estimatedMaterialTokens) ||
    demand.estimatedMaterialTokens < 0
  )
    return undefined;
  const total = components.reduce((sum, tokens) => sum + tokens, 0);
  return Number.isSafeInteger(total) ? Math.max(total, demand.estimatedMaterialTokens) : undefined;
}

/**
 * Keep static model ceilings unchanged unless the model's combined output reserve consumes its
 * entire context window. For those models, shrink this request's reserve to fit the full measured
 * input while retaining Pi's public minimum answer and selected reasoning floors.
 */
export function deriveRequestCapacity(
  baseCapacity: ModelCapacity,
  demand: ContextDemandEstimate,
  thinkingLevel?: string | null,
): RequestCapacityResult {
  const fullInputTokens = fullInputDemandTokens(demand);
  if (fullInputTokens === undefined) return { ok: false, reason: "invalid_demand" };

  const baseCombined = baseCapacity.outputReserveTokens + baseCapacity.thinkingReserveTokens;
  if (baseCombined < baseCapacity.contextWindowTokens) {
    return {
      ok: true,
      budget: {
        capacity: baseCapacity,
        policyVersion: REQUEST_CAPACITY_POLICY_VERSION.static,
        dynamic: false,
        fullInputDemandTokens: fullInputTokens,
        minimumOutputTokens: MIN_ANSWER_TOKENS,
        minimumThinkingTokens: 0,
        minimumCombinedReserveTokens: baseCombined,
        headroomReserveTokens: baseCombined,
      },
    };
  }

  const minimumOutputTokens = MIN_ANSWER_TOKENS;
  const minimumThinkingTokens = thinkingFloor(
    thinkingLevel,
    baseCapacity.thinkingReserveTokens > 0,
  );
  if (minimumThinkingTokens === undefined) return { ok: false, reason: "invalid_thinking_level" };
  const minimumCombinedReserveTokens = minimumOutputTokens + minimumThinkingTokens;
  const originalCeiling = Math.min(baseCapacity.contextWindowTokens, baseCombined);
  if (minimumCombinedReserveTokens > originalCeiling)
    return { ok: false, reason: "output_floor_exceeds_ceiling" };

  const inputRoom =
    baseCapacity.contextWindowTokens - baseCapacity.safetyMarginTokens - fullInputTokens;
  const combinedReserveTokens = Math.min(
    originalCeiling,
    Math.max(minimumCombinedReserveTokens, inputRoom),
  );
  const capacity: ModelCapacity = {
    ...baseCapacity,
    outputReserveTokens: combinedReserveTokens - minimumThinkingTokens,
    thinkingReserveTokens: minimumThinkingTokens,
  };
  return {
    ok: true,
    budget: {
      capacity,
      policyVersion: REQUEST_CAPACITY_POLICY_VERSION.dynamic,
      dynamic: true,
      fullInputDemandTokens: fullInputTokens,
      minimumOutputTokens,
      minimumThinkingTokens,
      minimumCombinedReserveTokens,
      headroomReserveTokens: minimumCombinedReserveTokens,
    },
  };
}

export function availableRequestInputHeadroom(
  budget: RequestCapacityBudget,
  projectedTokens: number,
): number {
  if (!Number.isSafeInteger(projectedTokens) || projectedTokens < 0) return 0;
  return Math.max(
    0,
    budget.capacity.contextWindowTokens -
      budget.capacity.safetyMarginTokens -
      budget.headroomReserveTokens -
      projectedTokens,
  );
}
