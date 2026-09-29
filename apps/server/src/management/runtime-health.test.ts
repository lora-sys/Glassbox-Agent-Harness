import { describe, expect, it } from "vite-plus/test";
import type { ExecutionResult } from "../execution/run-service/types.js";
import { runtimeHealthOf } from "./runtime-health.js";

const result = (over: Partial<ExecutionResult>): ExecutionResult => ({
  status: "failed",
  ...over,
});

describe("runtimeHealthOf", () => {
  it("reports a Run the provider answered", () => {
    expect(runtimeHealthOf(result({ status: "succeeded" }))).toEqual({
      state: "healthy",
      reasonCode: null,
    });
  });

  it("says nothing about a Run that never reached the provider", () => {
    // Nothing was sent, so the runtime was never given the chance to work. Recording either as
    // `unavailable` would pull a working profile out of routing for the next minute.
    expect(
      runtimeHealthOf(result({ failureCode: "pre_provider_context_overflow" })),
    ).toBeUndefined();
    expect(runtimeHealthOf(result({ failureCode: "model_capacity_unknown" }))).toBeUndefined();
  });

  it("records a refusal by Glassbox's own gates as degraded, not unavailable", () => {
    // The observed night: a Run closed by the required-action or required-evidence gate marked
    // the profile unavailable, which removed it from routing and turned the next Run into a
    // failure with no usable route at all. `degraded` keeps the observation visible without
    // removing the profile, because the runtime was never the thing that refused.
    expect(runtimeHealthOf(result({ failureCode: "required_action_not_completed" }))).toEqual({
      state: "degraded",
      reasonCode: "required_action_not_completed",
    });
    expect(runtimeHealthOf(result({ failureCode: "required_evidence_missing" }))).toEqual({
      state: "degraded",
      reasonCode: "required_evidence_missing",
    });
  });

  it("keeps an unclassified or thrown failure unavailable", () => {
    // Conservative by design: a failure that names no cause, or an executor that threw, is
    // evidence about the runtime and must keep the profile out of routing until it recovers.
    expect(runtimeHealthOf(result({}))).toEqual({
      state: "unavailable",
      reasonCode: "execution_failed",
    });
    expect(runtimeHealthOf(result({ failureCode: "execution_threw" }))).toEqual({
      state: "unavailable",
      reasonCode: "execution_threw",
    });
  });
});
