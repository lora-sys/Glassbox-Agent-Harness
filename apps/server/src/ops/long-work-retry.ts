import type { TaskRetryPolicy } from "@glassbox/contracts";

export type RetrySideEffectOutcome = "not_started" | "not_applied" | "applied" | "unknown";

export interface RetryDecisionInput {
  policy: TaskRetryPolicy;
  /** One-based number of the attempt that just finished. */
  attemptNumber: number;
  nowMs: number;
  errorClass?: string;
  timedOut?: boolean;
  sideEffectOutcome?: RetrySideEffectOutcome;
}

export type RetryDecision =
  | {
      action: "retry";
      reason: "retryable_error" | "retryable_timeout";
      nextAttemptNumber: number;
      delayMs: number;
      retryAtMs: number;
    }
  | {
      action: "fail";
      reason:
        | "invalid_policy"
        | "unsupported_policy_version"
        | "invalid_attempt"
        | "invalid_time"
        | "non_retryable_error"
        | "unclassified_error"
        | "failed_timeout"
        | "attempts_exhausted";
    }
  | {
      action: "unknown";
      reason: "side_effect_unknown" | "unknown_timeout";
    }
  | { action: "do_not_retry"; reason: "side_effect_applied" };

function validPolicy(policy: TaskRetryPolicy): boolean {
  return (
    Number.isInteger(policy.version) &&
    policy.version > 0 &&
    Number.isInteger(policy.maxAttempts) &&
    policy.maxAttempts > 0 &&
    Number.isFinite(policy.initialDelayMs) &&
    policy.initialDelayMs >= 0 &&
    Number.isFinite(policy.backoffMultiplier) &&
    policy.backoffMultiplier >= 1 &&
    Number.isFinite(policy.maxDelayMs) &&
    policy.maxDelayMs >= policy.initialDelayMs &&
    Array.isArray(policy.retryableErrorClasses) &&
    Array.isArray(policy.nonRetryableErrorClasses) &&
    ["retryable", "failed", "unknown"].includes(policy.timeoutOutcome)
  );
}

/** Decide whether an attempt can be retried. This function performs no I/O. */
export function decideTaskRetry(input: RetryDecisionInput): RetryDecision {
  const { policy, attemptNumber, nowMs } = input;
  if (!validPolicy(policy)) return { action: "fail", reason: "invalid_policy" };
  if (policy.version !== 1) {
    return { action: "fail", reason: "unsupported_policy_version" };
  }
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
    return { action: "fail", reason: "invalid_attempt" };
  }
  if (!Number.isFinite(nowMs)) return { action: "fail", reason: "invalid_time" };

  if (input.sideEffectOutcome === "unknown") {
    return { action: "unknown", reason: "side_effect_unknown" };
  }
  if (input.sideEffectOutcome === "applied") {
    return { action: "do_not_retry", reason: "side_effect_applied" };
  }

  let reason: "retryable_error" | "retryable_timeout";
  if (input.timedOut) {
    if (policy.timeoutOutcome === "unknown") {
      return { action: "unknown", reason: "unknown_timeout" };
    }
    if (policy.timeoutOutcome === "failed") {
      return { action: "fail", reason: "failed_timeout" };
    }
    reason = "retryable_timeout";
  } else {
    const errorClass = input.errorClass;
    if (!errorClass) return { action: "fail", reason: "unclassified_error" };
    if (policy.nonRetryableErrorClasses.includes(errorClass)) {
      return { action: "fail", reason: "non_retryable_error" };
    }
    if (!policy.retryableErrorClasses.includes(errorClass)) {
      return { action: "fail", reason: "unclassified_error" };
    }
    reason = "retryable_error";
  }

  if (attemptNumber >= policy.maxAttempts) {
    return { action: "fail", reason: "attempts_exhausted" };
  }
  if (input.sideEffectOutcome !== "not_started" && input.sideEffectOutcome !== "not_applied") {
    return { action: "unknown", reason: "side_effect_unknown" };
  }

  const exponentialDelay = policy.initialDelayMs * policy.backoffMultiplier ** (attemptNumber - 1);
  const delayMs = Math.min(policy.maxDelayMs, exponentialDelay);
  const retryAtMs = nowMs + delayMs;
  if (!Number.isFinite(retryAtMs)) return { action: "fail", reason: "invalid_time" };
  return {
    action: "retry",
    reason,
    nextAttemptNumber: attemptNumber + 1,
    delayMs,
    retryAtMs,
  };
}
