import type { ExecutionFailureCode, ExecutionResult } from "../execution/run-service/types.js";
import type { RuntimeHealthState } from "../routing/index.js";

/**
 * What a cause says about the runtime behind the Run, or `undefined` when it says nothing.
 *
 * This table is exhaustive over `ExecutionFailureCode` on purpose, and it has no default branch.
 * A default is a guess, and the guess this used to make — an unnamed cause means the runtime is
 * down — is how a refusal Glassbox issued itself took a working profile out of routing for a
 * minute. Fifteen Runs did exactly that on 2026-09-29: every one of them was stopped before the
 * model was called, and each one recorded `unavailable` for a profile that had never been asked
 * to do anything. A cause added to the union later has to be given a row here, so the compiler
 * refuses the new cause instead of silently inheriting the most destructive answer.
 *
 * `unavailable` is reserved for a Run where the runtime was actually engaged and could not
 * answer. `degraded` records that the Run did not succeed — an operator can still see it, and
 * the observation still lands in the Trace — without removing the profile, because the cause
 * was not the runtime failing to answer.
 */
const healthByCause = {
  // Nothing was ever sent, so the runtime was never given the chance to work.
  pre_provider_context_overflow: undefined,
  model_capacity_unknown: undefined,
  // Glassbox declined to act on its own rules. The runtime was never put to work, or its answer
  // was refused by a gate rather than by the runtime producing no answer.
  gate_refused: { state: "degraded" },
  // The runtime answered and the work still is not done, which is worth an operator's attention
  // but says nothing about whether the profile can answer the next Run.
  required_action_not_completed: { state: "degraded" },
  claimed_change_not_performed: { state: "degraded" },
  required_evidence_missing: { state: "degraded" },
  // The runtime was engaged and failed. This is the only kind of cause that names one.
  runtime_run_errored: { state: "unavailable" },
  execution_threw: { state: "unavailable" },
  // The route itself has no executor, so the profile cannot answer anything until it is fixed.
  execution_unavailable: { state: "unavailable" },
} as const satisfies Record<ExecutionFailureCode, { state: RuntimeHealthState } | undefined>;

/**
 * What a Run's outcome says about the runtime behind it, or `undefined` when it says nothing.
 *
 * A health observation is read by routing as evidence that a profile should be dropped from
 * consideration for the next minute, so a Run the runtime had no part in must never be recorded
 * as one it failed. The observed night had a refusal at 22:07 and a second failure at 22:16,
 * inside the same window: the second Run had no usable route at all because the first one was
 * never put to the model.
 */
export function runtimeHealthOf(
  result: ExecutionResult,
): { state: RuntimeHealthState; reasonCode: string | null } | undefined {
  if (result.status === "succeeded") return { state: "healthy", reasonCode: null };
  // A cancelled, interrupted or unclassified Run says nothing about the runtime either: stopping
  // a Run is not the runtime being unable to answer.
  if (result.failureCode === undefined) return undefined;
  const health = healthByCause[result.failureCode];
  return health === undefined ? undefined : { state: health.state, reasonCode: result.failureCode };
}
