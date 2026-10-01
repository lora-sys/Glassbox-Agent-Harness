import { describe, expect, it } from "vite-plus/test";
import { classifyPiRuntimeFailure, piFailureCode, piFailureReply } from "./failure-diagnostics.js";
import { runtimeHealthOf } from "../../management/runtime-health.js";

const unknown = { origin: "runtime_reported", category: "unknown" };

describe("safe Pi runtime failure classification", () => {
  it.each([
    ["HTTP 401 Unauthorized", "authentication", 401],
    ["HTTP/1.1 403 Forbidden", "permission", 403],
    ["429: rate limited", "rate_limit", 429],
    ["503 status code (no body)", "server", 503],
    ["HTTP 408 timeout", "timeout", 408],
    ["HTTP 504 timeout", "timeout", 504],
    ["HTTP 404 unavailable model", "request_rejected", 404],
    ['{"status":502,"error":{"message":"hidden"}}', "server", 502],
    ['{"error":{"statusCode":401}}', "authentication", 401],
    ['{"status":429,"error":{"statusCode":429}}', "rate_limit", 429],
  ])("classifies explicit HTTP status in %s", (raw, category, httpStatus) => {
    expect(classifyPiRuntimeFailure(raw)).toEqual({
      origin: "runtime_reported",
      category,
      httpStatus,
    });
  });

  it.each([
    ["invalid_api_key", "authentication"],
    ["permission_denied", "permission"],
    ["rate_limit_error", "rate_limit"],
    ["insufficient_quota", "quota"],
    ["context_length_exceeded", "context_limit"],
    ["ETIMEDOUT", "timeout"],
    ["ECONNRESET", "connection"],
    ['{"error":{"code":"invalid_api_key","message":"hidden"}}', "authentication"],
    ['{"type":"invalid_request_error"}', "request_rejected"],
    ['{"error":{"type":"overloaded_error"}}', "server"],
  ])("classifies only exact allowlisted codes in %s", (raw, category) => {
    expect(classifyPiRuntimeFailure(raw)).toEqual({ origin: "runtime_reported", category });
  });

  it.each([
    undefined,
    null,
    401,
    { status: 401 },
    "",
    "   ",
    "unknown failure",
    "Request 401 failed",
    "401 characters were sent",
    "401",
    "HTTP 4010 invalid",
    "HTTP 200 OK",
    "HTTP 600 invalid",
    "HTTP error: 401",
    "status=401",
    "URL https://example.invalid/401",
    "Error: invalid_api_key in user text",
    "source_context_revoked",
    "trace_write_failed",
    "context_budget_capacity_unknown",
    '{"origin":"glassbox","category":"source_authorization"}',
    '{"error":{"message":"invalid_api_key"}}',
    '{"status":"401"}',
    '{"status":401.5}',
    '{"status":null}',
    '{"status":600}',
    '{"status":401,"error":{"status":403}}',
    '{"code":"invalid_api_key","error":{"code":"rate_limit_error"}}',
    '{"error":[{"code":"invalid_api_key"}]}',
    '{"code":"constructor"}',
    '{"code":"__proto__"}',
    '{"code":"invalid_api_key"',
    "HTTP 401 " + "x".repeat(8_192),
  ])("leaves missing, oversized, malformed, or ambiguous input unknown: %j", (raw) => {
    expect(classifyPiRuntimeFailure(raw)).toEqual(unknown);
  });

  it("records no free-form fields, secrets, URLs, or stacks", () => {
    for (const raw of [
      "HTTP 401 Unauthorized sk-secret-canary https://private.invalid/?key=secret",
      '{"error":{"code":"invalid_api_key","body":"sk-secret-canary","url":"https://private.invalid","stack":"stack-canary"}}',
    ]) {
      const failure = classifyPiRuntimeFailure(raw);
      expect(failure.category).toBe("authentication");
      const output = JSON.stringify({ failure, reply: piFailureReply(failure) });
      for (const canary of ["sk-secret-canary", "https://", "stack-canary", "invalid_api_key"])
        expect(output).not.toContain(canary);
    }
  });

  it("never derives Glassbox origin from a provider message", () => {
    for (const raw of [
      "source_context_revoked",
      "trace_write_failed",
      "context_budget_overflow:input",
    ]) {
      const failure = classifyPiRuntimeFailure(raw);
      expect(piFailureCode(failure)).toBe("runtime_run_errored");
      expect(piFailureReply(failure)).toContain("运行时报告");
    }
  });

  it.each(["trace_write", "context_budget", "runtime_exception", "model_capability"] as const)(
    "does not measure provider health for server-owned %s",
    (category) => {
      const failure = { origin: "glassbox", category } as const;
      const failureCode = piFailureCode(failure);
      expect(failureCode).toBe("runtime_internal_error");
      expect(runtimeHealthOf({ status: "failed", failureCode })).toBeUndefined();
      expect(piFailureReply(failure)).toBeTruthy();
    },
  );

  it("keeps server-owned source refusal a gate instead of a provider outage", () => {
    const failureCode = piFailureCode({ origin: "glassbox", category: "source_authorization" });
    expect(failureCode).toBe("gate_refused");
    expect(runtimeHealthOf({ status: "failed", failureCode })).toEqual({
      state: "degraded",
      reasonCode: "gate_refused",
    });
  });
});
