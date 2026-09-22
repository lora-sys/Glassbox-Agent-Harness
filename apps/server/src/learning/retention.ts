import type { RetentionFactors } from "./contracts.js";

export const retentionWeights = {
  emotion: 0.55,
  goalRelevance: 0,
  valueAlignment: 0,
  selfRelevance: 0.23,
  taskUtility: 0,
  reliability: 0.64,
  usage: 0.1,
} satisfies RetentionFactors;

function bounded(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function normalizedRetentionFactors(
  input: Partial<RetentionFactors> = {},
): RetentionFactors {
  return {
    emotion: bounded(input.emotion ?? 0),
    goalRelevance: bounded(input.goalRelevance ?? 0),
    valueAlignment: bounded(input.valueAlignment ?? 0),
    selfRelevance: bounded(input.selfRelevance ?? 0),
    taskUtility: bounded(input.taskUtility ?? 0),
    reliability: bounded(input.reliability ?? 0),
    usage: bounded(input.usage ?? 0),
  };
}

/** Behavior-compatible with Learning-Multi-Factor-Memory's interpretable V(m). */
export function retentionValue(
  input: Partial<RetentionFactors>,
  weights: RetentionFactors = retentionWeights,
): number {
  const factors = normalizedRetentionFactors(input);
  return (Object.keys(weights) as (keyof RetentionFactors)[]).reduce(
    (total, key) => total + weights[key] * factors[key],
    0,
  );
}

export function retentionReviewScore(input: {
  factors: Partial<RetentionFactors>;
  updatedAt: string;
  lastUsedAt?: string;
  useCount?: number;
  now?: Date;
  beta?: number;
}): number {
  const now = input.now ?? new Date();
  const timestamp = new Date(input.lastUsedAt ?? input.updatedAt);
  const daysSince = Number.isFinite(timestamp.getTime())
    ? Math.max(0, (now.getTime() - timestamp.getTime()) / 86_400_000)
    : 0;
  const uses = Math.max(0, input.useCount ?? 0);
  const recencyDecay = daysSince ** 0.7;
  const usagePenalty = 1 / (1 + uses);
  const valueResistance = 1 / (1 + (input.beta ?? 1) * Math.max(0, retentionValue(input.factors)));
  return recencyDecay * usagePenalty * valueResistance;
}
