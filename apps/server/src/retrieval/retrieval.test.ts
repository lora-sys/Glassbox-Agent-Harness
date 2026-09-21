import { describe, expect, it } from "vitest";
import type { SearchResultItem } from "@glassbox/contracts";
import {
  MemoryRetriever,
  type RetrievalCandidate,
  type RetrievalCandidateStore,
} from "./retriever.js";
import { tokenizeText } from "./tokenizer.js";

/**
 * Ported / adapted from:
 * 1. HKUDS/MGP (54ce6c00e3d0aa731ecbe17e74407cbbb5a96f10)
 *    compliance/search/test_search_results.py
 *    compliance/access/test_access_control.py
 * 2. TokenRhythm/opensquilla (75a7085960ee57bc7a17acde5ce08071af4e7632)
 *    tests/test_memory_store_keyword_fallback.py
 *    tests/test_memory_search_defaults.py
 *    tests/test_memory_retention.py
 * 3. HKUDS/OpenHarness (9b2efd795c6aa09f88b0c257d269a9e518da6ae7)
 *    src/openharness/memory/search.py
 *    src/openharness/memory/relevance.py
 */

class MockCandidateStore implements RetrievalCandidateStore {
  searchedSourceIds: string[][] = [];

  constructor(public candidates: RetrievalCandidate[] = []) {}

  async searchCandidates(params: {
    query: string;
    allowedSourceIds: readonly string[];
    limit?: number;
    since?: string;
    until?: string;
  }): Promise<RetrievalCandidate[]> {
    this.searchedSourceIds.push([...params.allowedSourceIds]);
    const allowedSet = new Set(params.allowedSourceIds);
    return this.candidates.filter((c) => {
      if (!allowedSet.has(c.sourceId)) return false;
      if (params.since && c.timestamp < params.since) return false;
      if (params.until && c.timestamp > params.until) return false;
      return true;
    });
  }
}

describe("P4B MGP-compatible contracts and SearchResultItem", () => {
  it("conforms to MGP SearchResultItem structure with required fields", () => {
    const item: SearchResultItem<{ id: string; text: string }> = {
      memory: { id: "mem-1", text: "Important fact" },
      score: 0.95,
      score_kind: "normalized",
      backend_origin: "glassbox-history",
      retrieval_mode: "lexical",
      return_mode: "raw",
      redaction_info: null,
      consumable_text: "Important fact",
      matched_terms: ["important", "fact"],
      explanation: "Lexical match on text",
    };

    expect(item.score).toBe(0.95);
    expect(item.score_kind).toBe("normalized");
    expect(item.backend_origin).toBe("glassbox-history");
    expect(item.retrieval_mode).toBe("lexical");
    expect(item.return_mode).toBe("raw");
    expect(item.redaction_info).toBeNull();
    expect(item.consumable_text).toBe("Important fact");
    expect(item.matched_terms).toEqual(["important", "fact"]);
  });

  it("produces safe consumable_text and clears matched_terms for metadata_only results (MGP compliance)", async () => {
    const store = new MockCandidateStore([
      {
        id: "cand-restricted",
        sourceId: "group-1",
        sourceKind: "channel_message",
        text: "secret-token-kiwi-42: top secret message",
        timestamp: new Date().toISOString(),
        sensitivity: "restricted",
        returnMode: "metadata_only",
      },
    ]);

    const retriever = new MemoryRetriever({
      store,
      backendOrigin: "test-backend",
    });

    const results = await retriever.search("secret-token-kiwi-42", {
      allowedSourceIds: ["group-1"],
    });

    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.return_mode).toBe("metadata_only");
    expect(result.consumable_text).not.toContain("secret-token-kiwi-42");
    expect(result.consumable_text).toContain("metadata only");
    // The placeholder is model-visible, so it names no internal identifier either.
    expect(result.consumable_text).not.toContain("cand-restricted");
    expect(result.matched_terms).toEqual([]);
    expect(result.explanation).toBe("Result metadata only due to policy.");
  });

  it("supports mixed return modes in a single search result set (MGP compliance)", async () => {
    const store = new MockCandidateStore([
      {
        id: "cand-visible",
        sourceId: "group-1",
        sourceKind: "channel_message",
        text: "visible info token-xyz",
        timestamp: new Date().toISOString(),
        returnMode: "raw",
      },
      {
        id: "cand-restricted",
        sourceId: "group-1",
        sourceKind: "channel_message",
        text: "restricted info token-xyz",
        timestamp: new Date().toISOString(),
        returnMode: "metadata_only",
      },
    ]);

    const retriever = new MemoryRetriever({
      store,
      backendOrigin: "test-backend",
    });

    const results = await retriever.search("token-xyz", {
      allowedSourceIds: ["group-1"],
    });

    const modes = new Set(results.map((r) => r.return_mode));
    expect(modes.has("raw")).toBe(true);
    expect(modes.has("metadata_only")).toBe(true);
  });
});

describe("P4B OpenSquilla-shaped MemoryRetriever & OpenHarness Fallback", () => {
  it("enforces lexical defaults: vector_weight = 0 and text_weight = 1", () => {
    const store = new MockCandidateStore();
    const retriever = new MemoryRetriever({ store });
    expect(retriever.vectorWeight).toBe(0);
    expect(retriever.textWeight).toBe(1);
  });

  it("filters sources before candidate loading — store is never queried with unauthorized sources", async () => {
    const store = new MockCandidateStore([
      {
        id: "cand-unauth",
        sourceId: "unauthorized-group",
        sourceKind: "channel_message",
        text: "private secret message",
        timestamp: new Date().toISOString(),
      },
      {
        id: "cand-auth",
        sourceId: "authorized-group",
        sourceKind: "channel_message",
        text: "authorized group message",
        timestamp: new Date().toISOString(),
      },
    ]);

    const retriever = new MemoryRetriever({ store });
    const results = await retriever.search("message", {
      allowedSourceIds: ["authorized-group"],
    });

    expect(store.searchedSourceIds).toHaveLength(1);
    expect(store.searchedSourceIds[0]).toEqual(["authorized-group"]);
    expect(results).toHaveLength(1);
    expect(results[0]?.consumable_text).toBe("authorized group message");
  });

  it("tokenizes mixed ASCII and Han/CJK ideographs correctly (OpenHarness & OpenSquilla)", () => {
    const tokens = tokenizeText("Hello World! 这是一个测试 123");
    expect(tokens.has("hello")).toBe(true);
    expect(tokens.has("world")).toBe(true);
    expect(tokens.has("123")).toBe(true);
    // Han characters
    expect(tokens.has("这")).toBe(true);
    expect(tokens.has("是")).toBe(true);
    expect(tokens.has("一")).toBe(true);
    expect(tokens.has("个")).toBe(true);
    expect(tokens.has("测")).toBe(true);
    expect(tokens.has("试")).toBe(true);
  });

  it("applies temporal decay to dated/timed candidates unless evergreen (OpenSquilla)", async () => {
    const now = new Date();
    const fortyDaysAgo = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const today = now.toISOString();

    const store = new MockCandidateStore([
      {
        id: "cand-recent",
        sourceId: "group-1",
        sourceKind: "channel_message",
        text: "test keyword match alpha",
        timestamp: today,
        isEvergreen: false,
      },
      {
        id: "cand-old",
        sourceId: "group-1",
        sourceKind: "channel_message",
        text: "test keyword match beta",
        timestamp: fortyDaysAgo,
        isEvergreen: false,
      },
      {
        id: "cand-old-evergreen",
        sourceId: "group-1",
        sourceKind: "channel_message",
        text: "test keyword match gamma",
        timestamp: fortyDaysAgo,
        isEvergreen: true,
      },
    ]);

    const retriever = new MemoryRetriever({
      store,
      temporalDecayEnabled: true,
      halfLifeDays: 30,
    });

    const results = await retriever.search("keyword", {
      allowedSourceIds: ["group-1"],
    });

    const recent = results.find((r) => (r.memory as RetrievalCandidate).id === "cand-recent");
    const old = results.find((r) => (r.memory as RetrievalCandidate).id === "cand-old");
    const oldEvergreen = results.find(
      (r) => (r.memory as RetrievalCandidate).id === "cand-old-evergreen",
    );

    expect(recent).toBeDefined();
    expect(old).toBeDefined();
    expect(oldEvergreen).toBeDefined();

    expect(recent!.score).toBeGreaterThan(old!.score);
    // Evergreen does not experience temporal decay
    expect(oldEvergreen!.score).toBeGreaterThan(old!.score);
  });

  it("applies source weighting to candidate scoring (OpenSquilla)", async () => {
    const store = new MockCandidateStore([
      {
        id: "cand-low-weight",
        sourceId: "group-low",
        sourceKind: "channel_message",
        text: "common matching term from low source",
        timestamp: new Date().toISOString(),
      },
      {
        id: "cand-high-weight",
        sourceId: "group-high",
        sourceKind: "channel_message",
        text: "common matching term from high source",
        timestamp: new Date().toISOString(),
      },
    ]);

    const retriever = new MemoryRetriever({
      store,
      sourceWeights: {
        "group-low": 0.5,
        "group-high": 1.5,
      },
    });

    const results = await retriever.search("common", {
      allowedSourceIds: ["group-low", "group-high"],
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score);
    expect(results[0]?.memory).toMatchObject({ sourceId: "group-high" });
  });

  it("suppresses exact duplicate candidate texts (OpenHarness / OpenSquilla)", async () => {
    const store = new MockCandidateStore([
      {
        id: "cand-1",
        sourceId: "group-1",
        sourceKind: "channel_message",
        text: "Identical message content duplicated across turns",
        timestamp: "2026-09-01T10:00:00Z",
      },
      {
        id: "cand-2",
        sourceId: "group-1",
        sourceKind: "channel_message",
        text: "Identical message content duplicated across turns",
        timestamp: "2026-09-01T10:05:00Z",
      },
    ]);

    const retriever = new MemoryRetriever({
      store,
      dedupeDuplicates: true,
    });

    const results = await retriever.search("identical", {
      allowedSourceIds: ["group-1"],
    });

    expect(results).toHaveLength(1);
  });

  it("enforces time bounds via since and until filters", async () => {
    const store = new MockCandidateStore([
      {
        id: "cand-early",
        sourceId: "group-1",
        sourceKind: "channel_message",
        text: "early message",
        timestamp: "2026-09-01T00:00:00Z",
      },
      {
        id: "cand-mid",
        sourceId: "group-1",
        sourceKind: "channel_message",
        text: "mid message",
        timestamp: "2026-09-10T00:00:00Z",
      },
      {
        id: "cand-late",
        sourceId: "group-1",
        sourceKind: "channel_message",
        text: "late message",
        timestamp: "2026-09-20T00:00:00Z",
      },
    ]);

    const retriever = new MemoryRetriever({ store });

    const results = await retriever.search("message", {
      allowedSourceIds: ["group-1"],
      since: "2026-09-05T00:00:00Z",
      until: "2026-09-15T00:00:00Z",
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.memory).toMatchObject({ id: "cand-mid" });
  });

  it("enforces Top K / max_results limit", async () => {
    const candidates = Array.from({ length: 15 }, (_, i) => ({
      id: `cand-${i}`,
      sourceId: "group-1",
      sourceKind: "channel_message",
      text: `sample message number ${i}`,
      timestamp: new Date().toISOString(),
    }));

    const store = new MockCandidateStore(candidates);
    const retriever = new MemoryRetriever({ store });

    const results = await retriever.search("sample", {
      allowedSourceIds: ["group-1"],
      limit: 5,
    });

    expect(results).toHaveLength(5);
  });

  it("supports MMR diversity reranking (OpenSquilla)", async () => {
    const store = new MockCandidateStore([
      {
        id: "cand-a1",
        sourceId: "group-1",
        sourceKind: "channel_message",
        text: "apple fruit harvest in the autumn farm orchard",
        timestamp: new Date().toISOString(),
      },
      {
        id: "cand-a2",
        sourceId: "group-1",
        sourceKind: "channel_message",
        text: "apple fruit harvest in the autumn farm field",
        timestamp: new Date().toISOString(),
      },
      {
        id: "cand-b1",
        sourceId: "group-1",
        sourceKind: "channel_message",
        text: "banana tropical fruit shipped by cargo container",
        timestamp: new Date().toISOString(),
      },
    ]);

    const retriever = new MemoryRetriever({
      store,
      mmrEnabled: true,
      mmrLambda: 0.5,
    });

    const results = await retriever.search("fruit", {
      allowedSourceIds: ["group-1"],
      limit: 2,
    });

    expect(results).toHaveLength(2);
    // When MMR is enabled with lambda=0.5, the second item should be diverse (banana rather than almost identical apple a2)
    const texts = results.map((r) => r.consumable_text);
    expect(texts.some((t) => t.includes("apple"))).toBe(true);
    expect(texts.some((t) => t.includes("banana"))).toBe(true);
  });
});
