import { describe, expect, it } from "vitest";
import type { Usage } from "@earendil-works/pi-ai";
import {
  normalizePiTurnEndUsage,
  normalizeRuntimeHealth,
  normalizeRuntimeLimits,
} from "./runtime-telemetry.js";

const piUsage = (overrides: Partial<Usage> = {}): Partial<Usage> => ({
  input: 100,
  output: 40,
  cacheRead: 10,
  cacheWrite: 5,
  reasoning: 8,
  totalTokens: 155,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  ...overrides,
});

describe("runtime telemetry normalization", () => {
  it("normalizes the installed Pi Usage shape without claiming provider report provenance", () => {
    const normalized = normalizePiTurnEndUsage({ usage: piUsage() });
    expect(normalized.inputTokens).toEqual({ value: 100, source: "sdk_normalized" });
    expect(normalized.outputTokens).toEqual({ value: 40, source: "sdk_normalized" });
    expect(normalized.cacheReadTokens).toEqual({ value: 10, source: "sdk_normalized" });
    expect(normalized.cacheWriteTokens).toEqual({ value: 5, source: "sdk_normalized" });
    expect(normalized.reasoningTokens).toEqual({ value: 8, source: "sdk_normalized" });
    expect(normalized.totalTokens).toEqual({ value: 155, source: "sdk_normalized" });
  });

  it("derives missing total from known components and preserves explicitly ambiguous fields", () => {
    const usage = piUsage({
      totalTokens: undefined,
      input: 12,
      output: 7,
      cacheRead: 999,
      cacheWrite: 999,
      reasoning: 999,
    });
    const normalized = normalizePiTurnEndUsage({
      usage,
      providerReported: { cacheRead: false, cacheWrite: false, reasoning: false },
    });
    expect(normalized.totalTokens).toEqual({ value: 19, source: "derived" });
    expect(normalized.cacheReadTokens).toEqual({ value: null, source: "unknown" });
    expect(normalized.reasoningTokens).toEqual({ value: null, source: "unknown" });
  });

  it("retains provider-reported provenance when available separately", () => {
    const normalized = normalizePiTurnEndUsage({
      usage: piUsage(),
      providerReported: { input: true, totalTokens: true },
    });
    expect(normalized.inputTokens.source).toBe("reported");
    expect(normalized.outputTokens.source).toBe("sdk_normalized");
    expect(normalized.totalTokens.source).toBe("reported");
  });

  it("does not interpret Pi zero-cost placeholders as free usage", () => {
    const normalized = normalizePiTurnEndUsage({ usage: piUsage() });
    expect(normalized.cost).toEqual({
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      total: null,
      source: null,
    });
    const priced = normalizePiTurnEndUsage({
      usage: piUsage(),
      costEvidence: {
        source: "configured",
        input: 0.01,
        output: 0.02,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.03,
      },
    });
    expect(priced.cost).toMatchObject({ total: 0.03, source: "configured" });
  });

  it("calculates throughput only from known usage and a valid sample window", () => {
    const sampled = normalizePiTurnEndUsage({
      usage: piUsage(),
      sample: { startedAtMs: 1_000, completedAtMs: 3_000 },
    });
    expect(sampled.throughput).toEqual({
      tokensPerSecond: 77.5,
      sampleDurationMs: 2_000,
      source: "observed",
    });
    expect(normalizePiTurnEndUsage({ usage: piUsage() }).throughput).toEqual({
      tokensPerSecond: null,
      sampleDurationMs: null,
      source: "unknown",
    });
  });

  it("keeps absent limits and quotas unknown and labels known source", () => {
    expect(normalizeRuntimeLimits()).toEqual({
      contextWindowTokens: null,
      maxOutputTokens: null,
      maxConcurrentRuns: null,
      requestsPerMinute: null,
      tokensPerMinute: null,
      requestsRemaining: null,
      tokensRemaining: null,
      quotaResetsAt: null,
      source: null,
    });
    expect(
      normalizeRuntimeLimits({ contextWindowTokens: 16_000, requestsRemaining: 4 }),
    ).toMatchObject({ contextWindowTokens: null, requestsRemaining: null, source: null });
    expect(
      normalizeRuntimeLimits({
        contextWindowTokens: 16_000,
        requestsRemaining: 4,
        source: "provider_reported",
      }),
    ).toMatchObject({
      contextWindowTokens: 16_000,
      requestsRemaining: 4,
      source: "provider_reported",
    });
  });

  it("marks health stale or unknown when freshness cannot be established", () => {
    const fresh = normalizeRuntimeHealth({
      state: "healthy",
      checkedAt: new Date(95_000).toISOString(),
      latencyMs: 120,
      nowMs: 100_000,
      maxAgeMs: 10_000,
    });
    expect(fresh).toMatchObject({ state: "healthy", freshness: "fresh", latencyMs: 120 });

    const stale = normalizeRuntimeHealth({
      state: "healthy",
      checkedAt: new Date(80_000).toISOString(),
      latencyMs: 120,
      nowMs: 100_000,
      maxAgeMs: 10_000,
    });
    expect(stale).toMatchObject({ state: "unknown", freshness: "stale", latencyMs: null });
    expect(normalizeRuntimeHealth({ nowMs: 100_000 })).toMatchObject({
      state: "unknown",
      checkedAt: null,
      freshness: "unknown",
    });
  });
});
