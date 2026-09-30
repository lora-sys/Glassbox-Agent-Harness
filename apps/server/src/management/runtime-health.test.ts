import { describe, expect, it } from "vite-plus/test";
import type { ExecutionFailureCode, ExecutionResult } from "../execution/run-service/types.js";
import type { RuntimeHealthState } from "../routing/index.js";
import { runtimeHealthOf } from "./runtime-health.js";

const result = (over: Partial<ExecutionResult>): ExecutionResult =>
  ({ status: "failed", ...over }) as ExecutionResult;

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
    // The observed night: a Run closed by a gate marked the profile unavailable, which removed
    // it from routing and turned the next Run into a failure with no usable route at all.
    // `degraded` keeps the observation visible without removing the profile, because the runtime
    // was never the thing that refused.
    expect(runtimeHealthOf(result({ failureCode: "required_action_not_completed" }))).toEqual({
      state: "degraded",
      reasonCode: "required_action_not_completed",
    });
    expect(runtimeHealthOf(result({ failureCode: "required_evidence_missing" }))).toEqual({
      state: "degraded",
      reasonCode: "required_evidence_missing",
    });
  });

  it("keeps a refusal the gates issued before the runtime was ever asked degraded too", () => {
    // Fifteen Runs on 2026-09-29 recorded `unavailable reason=execution_failed` for profiles that
    // were never put to the model. Every one of them had a `blockedMutation` from a gate of
    // Glassbox's own, or an exception out of the adapter, and none of them reached the runtime.
    expect(runtimeHealthOf(result({ failureCode: "gate_refused" }))).toEqual({
      state: "degraded",
      reasonCode: "gate_refused",
    });
  });

  it("reports a Run that stopped, was interrupted, or could not be classified as no evidence", () => {
    // Stopping a Run is not the runtime being unable to answer.
    expect(runtimeHealthOf(result({ status: "cancelled" }))).toBeUndefined();
    expect(runtimeHealthOf(result({ status: "interrupted" }))).toBeUndefined();
    expect(runtimeHealthOf(result({ status: "unknown" }))).toBeUndefined();
  });

  it("reserves unavailable for a Run where the runtime was engaged and failed", () => {
    // These are the only causes that positively assert the provider was reached and did not
    // answer, so they are the only ones allowed to remove a profile from routing.
    expect(runtimeHealthOf(result({ failureCode: "runtime_run_errored" }))).toEqual({
      state: "unavailable",
      reasonCode: "runtime_run_errored",
    });
    expect(runtimeHealthOf(result({ failureCode: "execution_threw" }))).toEqual({
      state: "unavailable",
      reasonCode: "execution_threw",
    });
  });

  it("reports a route with no executor at all as unavailable", () => {
    // Nothing can be executed on this reference, so the profile cannot answer the next Run
    // either until the configuration is fixed.
    expect(runtimeHealthOf(result({ failureCode: "execution_unavailable" }))).toEqual({
      state: "unavailable",
      reasonCode: "execution_unavailable",
    });
  });

  it("decides every cause in the union explicitly, with no default left over", () => {
    // The guard that keeps the next cause from being born destructive: this table is exhaustive
    // over `ExecutionFailureCode` — adding a cause without deciding what it says about the
    // runtime fails the `satisfies` in the source, rather than silently inheriting the
    // `unavailable` that used to be the default at three in the morning.
    const decided: readonly [ExecutionFailureCode, RuntimeHealthState | undefined][] = [
      ["pre_provider_context_overflow", undefined],
      ["model_capacity_unknown", undefined],
      ["gate_refused", "degraded"],
      ["required_action_not_completed", "degraded"],
      ["claimed_change_not_performed", "degraded"],
      ["required_evidence_missing", "degraded"],
      ["runtime_run_errored", "unavailable"],
      ["execution_threw", "unavailable"],
      ["execution_unavailable", "unavailable"],
    ];
    for (const [cause, state] of decided) {
      const observation = runtimeHealthOf(result({ failureCode: cause }));
      if (state === undefined) {
        expect(observation, `${cause} should say nothing about the runtime`).toBeUndefined();
      } else {
        expect(observation, `no decided row for ${cause}`).toEqual({ state, reasonCode: cause });
      }
    }
    // An unnamed cause used to mean `unavailable`. It now has to mean "nothing observed",
    // because from the outside there is no way to know who refused.
    expect(runtimeHealthOf({ status: "failed" } as ExecutionResult)).toBeUndefined();
  });
});
