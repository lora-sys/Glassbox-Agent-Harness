import { describe, expect, it } from "vite-plus/test";
import { projectRunHistory } from "./run-adapter.js";

const capacity = {
  contextWindowTokens: 12_000,
  outputReserveTokens: 2_000,
  thinkingReserveTokens: 0,
  safetyMarginTokens: 500,
};
const staticEstimate = { systemTokens: 1_000, toolSchemaTokens: 500 };

describe("Pi authorized history projection", () => {
  it("admits forty-two short exchanges and keeps complete user/assistant pairs", () => {
    const history = Array.from({ length: 42 }, (_, index) => [
      { role: "user" as const, text: `Question ${index}` },
      { role: "assistant" as const, text: `Answer ${index}` },
    ]).flat();
    const projected = projectRunHistory(
      {
        text: "Continue",
        history,
        historyRunIds: Array.from({ length: 42 }, (_, i) => `run-${i}`),
      },
      capacity,
      staticEstimate,
    );
    expect(projected.result.ok).toBe(true);
    if (!projected.result.ok) return;
    expect(projected.result.projection.includedExchangeIds).toHaveLength(42);
    expect(projected.result.projection.omittedExchangeIds).toEqual([]);
  });

  it("omits oversized optional exchanges but refuses to clip the current instruction", () => {
    const history = Array.from({ length: 12 }, (_, index) => [
      { role: "user" as const, text: `Old ${index} ${"文".repeat(2500)}` },
      { role: "assistant" as const, text: "Answer" },
    ]).flat();
    const projected = projectRunHistory({ text: "Continue", history }, capacity, staticEstimate);
    expect(projected.result.ok).toBe(true);
    if (projected.result.ok) {
      expect(projected.result.projection.includedExchangeIds.length).toBeLessThan(12);
      expect(projected.result.projection.omittedExchangeIds.length).toBeGreaterThan(0);
    }
    const oversized = projectRunHistory(
      { text: "文".repeat(12_000), history: [] },
      capacity,
      staticEstimate,
    );
    expect(oversized.result).toMatchObject({
      ok: false,
      overflow: { kind: "fixed_floor_exceeds_capacity" },
    });
  });
});
