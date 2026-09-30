import { describe, expect, it } from "vitest";
import type { TaskRetryPolicy } from "@glassbox/contracts";
import { decideTaskRetry } from "./long-work-retry.js";

const policy: TaskRetryPolicy = {
  version: 1,
  maxAttempts: 5,
  initialDelayMs: 1_000,
  backoffMultiplier: 2,
  maxDelayMs: 3_000,
  retryableErrorClasses: ["transport_reset", "worker_lost"],
  nonRetryableErrorClasses: ["invalid_input", "permission_denied"],
  timeoutOutcome: "retryable",
};

describe("decideTaskRetry", () => {
  it("schedules bounded exponential retry times from the current attempt", () => {
    expect(
      decideTaskRetry({
        policy,
        attemptNumber: 1,
        nowMs: 10_000,
        errorClass: "transport_reset",
        sideEffectOutcome: "not_applied",
      }),
    ).toEqual({
      action: "retry",
      reason: "retryable_error",
      nextAttemptNumber: 2,
      delayMs: 1_000,
      retryAtMs: 11_000,
    });
    expect(
      decideTaskRetry({
        policy,
        attemptNumber: 4,
        nowMs: 20_000,
        errorClass: "worker_lost",
        sideEffectOutcome: "not_started",
      }),
    ).toMatchObject({ action: "retry", delayMs: 3_000, retryAtMs: 23_000 });
  });

  it("does not retry unclassified or explicitly non-retryable errors", () => {
    expect(
      decideTaskRetry({ policy, attemptNumber: 1, nowMs: 0, errorClass: "new_error" }),
    ).toEqual({ action: "fail", reason: "unclassified_error" });
    expect(
      decideTaskRetry({ policy, attemptNumber: 1, nowMs: 0, errorClass: "invalid_input" }),
    ).toEqual({ action: "fail", reason: "non_retryable_error" });
  });

  it("gives the non-retryable classification precedence if policy lists overlap", () => {
    expect(
      decideTaskRetry({
        policy: {
          ...policy,
          retryableErrorClasses: ["same"],
          nonRetryableErrorClasses: ["same"],
        },
        attemptNumber: 1,
        nowMs: 0,
        errorClass: "same",
      }),
    ).toEqual({ action: "fail", reason: "non_retryable_error" });
  });

  it("stops when the current attempt reaches the policy maximum", () => {
    expect(
      decideTaskRetry({
        policy,
        attemptNumber: policy.maxAttempts,
        nowMs: 0,
        errorClass: "transport_reset",
      }),
    ).toEqual({ action: "fail", reason: "attempts_exhausted" });
  });

  it("applies the timeout outcome without requiring an error class", () => {
    expect(
      decideTaskRetry({
        policy,
        attemptNumber: 1,
        nowMs: 100,
        timedOut: true,
        sideEffectOutcome: "not_applied",
      }),
    ).toMatchObject({ action: "retry", reason: "retryable_timeout", retryAtMs: 1_100 });
    expect(
      decideTaskRetry({
        policy: { ...policy, timeoutOutcome: "failed" },
        attemptNumber: 1,
        nowMs: 0,
        timedOut: true,
      }),
    ).toEqual({ action: "fail", reason: "failed_timeout" });
    expect(
      decideTaskRetry({
        policy: { ...policy, timeoutOutcome: "unknown" },
        attemptNumber: 1,
        nowMs: 0,
        timedOut: true,
      }),
    ).toEqual({ action: "unknown", reason: "unknown_timeout" });
  });

  it("never replays an unknown side effect and reports already-applied effects", () => {
    expect(
      decideTaskRetry({
        policy,
        attemptNumber: 1,
        nowMs: 0,
        errorClass: "transport_reset",
        sideEffectOutcome: "unknown",
      }),
    ).toEqual({ action: "unknown", reason: "side_effect_unknown" });
    expect(
      decideTaskRetry({
        policy,
        attemptNumber: 1,
        nowMs: 0,
        errorClass: "transport_reset",
        sideEffectOutcome: "applied",
      }),
    ).toEqual({ action: "do_not_retry", reason: "side_effect_applied" });
  });

  it("returns unknown when a retryable failure has no safe side-effect evidence", () => {
    expect(
      decideTaskRetry({ policy, attemptNumber: 1, nowMs: 0, errorClass: "transport_reset" }),
    ).toEqual({ action: "unknown", reason: "side_effect_unknown" });
    expect(decideTaskRetry({ policy, attemptNumber: 1, nowMs: 0, timedOut: true })).toEqual({
      action: "unknown",
      reason: "side_effect_unknown",
    });
  });

  it("fails closed for malformed policy, attempt, or clock values", () => {
    expect(
      decideTaskRetry({ policy: { ...policy, maxAttempts: 0 }, attemptNumber: 1, nowMs: 0 }),
    ).toEqual({ action: "fail", reason: "invalid_policy" });
    expect(
      decideTaskRetry({ policy: { ...policy, version: 2 }, attemptNumber: 1, nowMs: 0 }),
    ).toEqual({ action: "fail", reason: "unsupported_policy_version" });
    expect(
      decideTaskRetry({ policy, attemptNumber: 0, nowMs: 0, errorClass: "transport_reset" }),
    ).toEqual({ action: "fail", reason: "invalid_attempt" });
    expect(
      decideTaskRetry({
        policy,
        attemptNumber: 1,
        nowMs: Number.NaN,
        errorClass: "transport_reset",
      }),
    ).toEqual({ action: "fail", reason: "invalid_time" });
    expect(
      decideTaskRetry({
        policy: { ...policy, initialDelayMs: Number.MAX_VALUE, maxDelayMs: Number.MAX_VALUE },
        attemptNumber: 1,
        nowMs: Number.MAX_VALUE,
        errorClass: "transport_reset",
        sideEffectOutcome: "not_applied",
      }),
    ).toEqual({ action: "fail", reason: "invalid_time" });
  });
});
