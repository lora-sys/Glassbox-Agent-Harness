import type { ExecutionResult } from "../execution/run-service/types.js";
import type { RuntimeHealthState } from "../routing/index.js";

/**
 * What a Run's outcome says about the runtime behind it, or `undefined` when it says nothing.
 *
 * A health observation is read by routing as evidence that a profile should be dropped from
 * consideration for the next minute. Recording a failure the runtime had no part in therefore
 * removes a working profile from routing, which is what turned one honest refusal into a Run
 * with no usable route at all: the observed night had a refusal at 22:07 and a second failure
 * at 22:16, inside the same window.
 *
 * `degraded` is the middle state. It records that the Run did not succeed — so an operator can
 * still see it, and the observation still lands in the Trace — without removing the profile,
 * because the request was refused by Glassbox's own gates rather than by the runtime failing to
 * answer.
 */
export function runtimeHealthOf(
  result: ExecutionResult,
): { state: RuntimeHealthState; reasonCode: string | null } | undefined {
  if (result.status === "succeeded") return { state: "healthy", reasonCode: null };
  switch (result.failureCode) {
    case "pre_provider_context_overflow":
    case "model_capacity_unknown":
      // Nothing was ever sent, so the runtime was never given the chance to work.
      return undefined;
    case "required_action_not_completed":
    case "required_evidence_missing":
      return { state: "degraded", reasonCode: result.failureCode };
    default:
      return { state: "unavailable", reasonCode: result.failureCode ?? "execution_failed" };
  }
}
