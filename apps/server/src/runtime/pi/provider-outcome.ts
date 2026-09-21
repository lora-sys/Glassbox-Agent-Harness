/**
 * Reading a provider call result as a Tool execution outcome.
 *
 * The provider already distinguishes "the call was refused", "the bridge is not connected"
 * and "the request timed out", but until now every one of those came back to the model as a
 * *successful* Tool call carrying a failure envelope. A model handed
 * `{"status":"failed","code":"not_connected"}` inside a non-error result can describe it as
 * data, and a required-evidence check that only looks at "did the call fail?" would count it
 * as having answered the question.
 *
 * So a provider result that is not `ok` is not a Tool result at all: it is thrown, which makes
 * the call fail visibly, and the failure is classified into the same outcome vocabulary the
 * rest of the Tool plane uses. The message a thrown call carries is a fixed Glassbox code —
 * provider error text, retcodes and parameter values never reach the model or the Trace.
 */

import type { OneBotCapabilityResult } from "../../channels/onebot/adapter.js";
import type { ToolExecutionOutcome } from "./tool-plane.js";

/**
 * A provider call that did not succeed.
 *
 * Distinct from `ToolInputError`: a refusal here is not something the model can correct by
 * calling differently, so it carries a fixed code rather than a diagnosis. `createProtectedTool`
 * re-throws it unchanged instead of collapsing it into the generic execution failure, because
 * "the bridge is not connected" and "the Tool broke" are different facts about the world.
 */
export class ProviderCallError extends Error {
  constructor(
    readonly outcome: ToolExecutionOutcome,
    code: string,
  ) {
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(code)) throw new Error("invalid_provider_error_code");
    super(code);
    this.name = "ProviderCallError";
  }
}

/**
 * The outcome a provider result stands for.
 *
 * `not_connected` is separated from the other failures because it is the one case where the
 * Tool is healthy and the *provider* cannot accept a call — the distinction between a broken
 * Tool and an unavailable one is exactly what a Run has to be able to report.
 */
export function providerOutcome(result: OneBotCapabilityResult): ToolExecutionOutcome {
  switch (result.status) {
    case "ok":
      return "success";
    case "rejected":
      return "denied";
    case "failed":
      return result.code === "not_connected" ? "provider_unavailable" : "provider_failed";
    case "unknown":
      return "unknown";
  }
}

/**
 * The fixed code a provider result is recorded under. Never provider text.
 *
 * A non-successful code is spelled as the outcome it stands for, so the code on the Trace and
 * the outcome on the Run result cannot disagree about what happened.
 */
export function providerFailureCode(result: OneBotCapabilityResult): string {
  switch (result.status) {
    case "ok":
      return "provider_call_succeeded";
    case "rejected":
      return "provider_denied";
    case "failed":
      return result.code === "not_connected" ? "provider_unavailable" : "provider_failed";
    case "unknown":
      return "provider_unknown";
  }
}

/**
 * Return a successful provider result, or fail the Tool call.
 *
 * Called on the one outbound provider path, so no capability Tool can return a provider
 * failure as though it were an answer.
 */
export function requireProviderSuccess(result: OneBotCapabilityResult): OneBotCapabilityResult {
  const outcome = providerOutcome(result);
  if (outcome === "success") return result;
  throw new ProviderCallError(outcome, providerFailureCode(result));
}
