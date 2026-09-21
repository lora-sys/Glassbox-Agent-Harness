import { describe, expect, it } from "vite-plus/test";
import type { OneBotCapabilityResult } from "../../channels/onebot/adapter.js";
import { toolOutcomeFromFailure } from "./tool-plane.js";
import {
  ProviderCallError,
  providerFailureCode,
  providerOutcome,
  requireProviderSuccess,
} from "./provider-outcome.js";

describe("reading a provider result as a Tool outcome", () => {
  it("reads a successful call as success", () => {
    expect(providerOutcome({ status: "ok", data: { groups: [] } })).toBe("success");
  });

  it("reads a refusal as denied, whichever rule refused", () => {
    expect(providerOutcome({ status: "rejected", code: "action_not_allowlisted" })).toBe("denied");
    expect(providerOutcome({ status: "rejected", code: "group_not_configured" })).toBe("denied");
  });

  it("separates an unavailable bridge from a failed request", () => {
    // The Tool is healthy and the provider cannot accept a call. A Run that cannot tell this
    // from a broken Tool cannot say what actually happened.
    expect(providerOutcome({ status: "failed", code: "not_connected" })).toBe(
      "provider_unavailable",
    );
    expect(providerOutcome({ status: "failed", code: "request_limit" })).toBe("provider_failed");
    expect(providerOutcome({ status: "failed", code: "api_rejected", retcode: 100 })).toBe(
      "provider_failed",
    );
  });

  it("never upgrades an unknown provider state to a known one", () => {
    for (const code of [
      "timeout",
      "disconnected",
      "send_error",
      "invalid_response",
      "async_response",
    ] as const)
      expect(providerOutcome({ status: "unknown", code })).toBe("unknown");
  });
});

describe("the code a provider result is recorded under", () => {
  it("classifies back to the same outcome it was derived from", () => {
    // The Trace code and the Run outcome are two spellings of one fact, so a reader who only
    // has the code must reach the same conclusion the Run did.
    const results: OneBotCapabilityResult[] = [
      { status: "ok", data: null },
      { status: "rejected", code: "action_not_allowlisted" },
      { status: "rejected", code: "group_not_configured" },
      { status: "failed", code: "not_connected" },
      { status: "failed", code: "request_limit" },
      { status: "failed", code: "api_rejected", retcode: 100 },
      { status: "unknown", code: "timeout" },
      { status: "unknown", code: "invalid_response" },
    ];
    for (const result of results) {
      const outcome = providerOutcome(result);
      const code = providerFailureCode(result);
      if (outcome === "success") expect(code).toBe("provider_call_succeeded");
      else expect(toolOutcomeFromFailure(code)).toBe(outcome);
    }
  });

  it("never carries provider text, retcodes or parameter values", () => {
    const code = providerFailureCode({ status: "failed", code: "api_rejected", retcode: 100 });
    expect(code).toBe("provider_failed");
    expect(code).not.toContain("100");
  });
});

describe("requiring a successful provider call", () => {
  it("returns the result a successful call produced", () => {
    const result = { status: "ok", data: { members: [] } } as const;
    expect(requireProviderSuccess(result)).toBe(result);
  });

  it("fails the Tool call on a provider failure instead of returning it as data", () => {
    // The defect this closes: a failure envelope inside a non-error Tool result reaches the
    // model as a successful call, and an evidence check counts it as an answer.
    expect(() => requireProviderSuccess({ status: "failed", code: "not_connected" })).toThrow(
      ProviderCallError,
    );
  });

  it("carries the structured outcome and a fixed code, never provider text", () => {
    const cases: Array<[OneBotCapabilityResult, string]> = [
      [{ status: "rejected", code: "group_not_configured" }, "denied"],
      [{ status: "failed", code: "not_connected" }, "provider_unavailable"],
      [{ status: "failed", code: "request_limit" }, "provider_failed"],
      [{ status: "unknown", code: "invalid_response" }, "unknown"],
    ];
    for (const [result, outcome] of cases) {
      try {
        requireProviderSuccess(result);
        throw new Error("expected the call to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderCallError);
        const failure = error as ProviderCallError;
        expect(failure.outcome).toBe(outcome);
        expect(failure.message).toBe(providerFailureCode(result));
        expect(failure.message).toMatch(/^[a-z][a-z0-9_]{0,63}$/u);
      }
    }
  });

  it("refuses to build a failure whose code is not a fixed code", () => {
    expect(() => new ProviderCallError("provider_failed", "NapCat retcode 100")).toThrow(
      "invalid_provider_error_code",
    );
  });
});
