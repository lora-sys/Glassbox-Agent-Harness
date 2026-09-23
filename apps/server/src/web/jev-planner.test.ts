import { describe, expect, it, vi } from "vitest";
import { JevPlanner, expandWebQuery } from "./jev-planner.js";
import type { JevProviderClient } from "./jev-provider.js";

const candidate = (url: string) => ({ url, title: url, highlights: [url] });

describe("Jev search planner", () => {
  it("expands a query deterministically and keeps the original first", () => {
    const query =
      "Please search for current Rust async runtime performance and memory tradeoffs over the last 30 days";
    expect(expandWebQuery(query)).toEqual(expandWebQuery(query));
    expect(expandWebQuery(query)[0]).toBe(query);
    expect(expandWebQuery(query).length).toBeLessThanOrEqual(3);
  });

  it("bypasses Jev for simple queries", async () => {
    const chooseQuery = vi.fn();
    const planner = new JevPlanner({
      provider: { chooseQuery, scoreCandidates: vi.fn() } as unknown as JevProviderClient,
    });
    expect(await planner.plan("Rust async runtime")).toMatchObject({
      mode: "fast",
      queryVariants: ["Rust async runtime"],
      jevUsed: false,
    });
    expect(chooseQuery).not.toHaveBeenCalled();
  });

  it("uses the judged expansion for a bounded complex query", async () => {
    let receivedVariants: readonly string[] = [];
    const chooseQuery = vi.fn(async (_query: string, variants: readonly string[]) => {
      receivedVariants = variants;
      return { status: "ready" as const, value: 1 };
    });
    const planner = new JevPlanner({
      provider: { chooseQuery, scoreCandidates: vi.fn() } as unknown as JevProviderClient,
    });
    const result = await planner.plan(
      "Compare current Rust async runtime performance and memory tradeoffs over the last 30 days",
    );
    expect(result.mode).toBe("complex");
    expect(result.jevUsed).toBe(true);
    expect(chooseQuery).toHaveBeenCalledTimes(1);
    expect(receivedVariants.length).toBeLessThanOrEqual(3);
    expect(result.queryVariants).toHaveLength(3);
    expect(result.queryVariants[0]).toBe(
      "Compare current Rust async runtime performance and memory tradeoffs over the last 30 days",
    );
    expect(result.queryVariants[1]).toBe(receivedVariants[1]);
    expect(result.queryVariants).toContain(receivedVariants[2]);
  });

  it("falls back to the original query when query judgment fails", async () => {
    const query = "Compare current Rust async runtime performance and memory tradeoffs";
    const planner = new JevPlanner({
      provider: {
        chooseQuery: vi.fn(async () => ({ status: "timeout" as const })),
        scoreCandidates: vi.fn(),
      },
    });
    expect(await planner.plan(query)).toMatchObject({
      mode: "complex",
      queryVariants: [query],
      jevUsed: false,
    });
  });

  it("batches candidate judgments, sorts by relevance, and preserves ties", async () => {
    const scoreCandidates = vi.fn(async () => ({
      status: "ready" as const,
      value: [0.2, 0.9, 0.9],
    }));
    const planner = new JevPlanner({
      provider: { chooseQuery: vi.fn(), scoreCandidates } as unknown as JevProviderClient,
    });
    const rows = [candidate("a"), candidate("b"), candidate("c")];
    expect(await planner.rerank("query", rows)).toEqual([
      { url: "b", relevanceScore: 0.9 },
      { url: "c", relevanceScore: 0.9 },
      { url: "a", relevanceScore: 0.2 },
    ]);
    expect(scoreCandidates).toHaveBeenCalledTimes(1);
  });

  it("keeps the original ordering and zero scores after ranking failure", async () => {
    const planner = new JevPlanner({
      provider: {
        chooseQuery: vi.fn(),
        scoreCandidates: vi.fn(async () => ({ status: "failed" as const })),
      },
    });
    expect(await planner.rerank("query", [candidate("first"), candidate("second")])).toEqual([
      { url: "first", relevanceScore: 0 },
      { url: "second", relevanceScore: 0 },
    ]);
  });

  it("limits one relevance request and keeps remaining candidates in original order", async () => {
    const scoreCandidates = vi.fn(async (_query, items) => ({
      status: "ready" as const,
      value: items.map(() => 0.5),
    }));
    const planner = new JevPlanner({
      provider: { chooseQuery: vi.fn(), scoreCandidates } as unknown as JevProviderClient,
    });
    const rows = Array.from({ length: 16 }, (_, index) => candidate(String(index)));
    const ranked = await planner.rerank("query", rows);
    expect(scoreCandidates).toHaveBeenCalledTimes(1);
    expect(scoreCandidates.mock.calls[0]?.[1]).toHaveLength(12);
    expect(ranked.slice(-4)).toEqual(rows.slice(-4).map(({ url }) => ({ url, relevanceScore: 0 })));
  });
});
