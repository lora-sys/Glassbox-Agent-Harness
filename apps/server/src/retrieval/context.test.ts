import { describe, expect, it } from "vitest";
import type { SearchResultItem } from "@glassbox/contracts";
import { selectBoundedContext } from "./context.js";
import type { RetrievalCandidate } from "./retriever.js";

function result(
  id: string,
  sourceId: string,
  consumableText: string,
  score = 1,
  timestamp = "2026-09-20T10:00:00Z",
): SearchResultItem<RetrievalCandidate> {
  return {
    memory: {
      id,
      sourceId,
      sourceKind: "channel_message",
      text: consumableText,
      timestamp,
    },
    score,
    score_kind: "normalized",
    backend_origin: "glassbox-retrieval",
    retrieval_mode: "lexical",
    return_mode: "raw",
    redaction_info: null,
    consumable_text: consumableText,
  };
}

describe("P4B bounded Context selection", () => {
  it("caps items per source and reports truncation", () => {
    const bounded = selectBoundedContext(
      [
        result("a", "100", "one"),
        result("b", "100", "two"),
        result("c", "100", "three"),
        result("d", "100", "four"),
        result("e", "200", "five"),
      ],
      { perSourceCap: 2 },
    );

    expect(bounded.items.map((i) => i.id)).toEqual(["a", "b", "e"]);
    expect(bounded.considered).toBe(5);
    expect(bounded.truncated).toBe(true);
  });

  it("suppresses already-surfaced items and applies Top K", () => {
    const bounded = selectBoundedContext(
      [result("a", "100", "one"), result("b", "200", "two"), result("c", "300", "three")],
      { alreadySurfaced: ["b"], topK: 1 },
    );

    expect(bounded.items.map((i) => i.id)).toEqual(["a"]);
    expect(bounded.truncated).toBe(true);
  });

  it("snippets long text and never exceeds the snippet budget", () => {
    const long = "x".repeat(500);
    const bounded = selectBoundedContext([result("a", "100", long)], { snippetChars: 100 });

    expect(bounded.items[0]?.snippet).toHaveLength(101); // 100 chars + ellipsis
    expect(bounded.items[0]?.snippet.endsWith("…")).toBe(true);
  });

  it("keeps a requested exact term inside the model-visible snippet", () => {
    const identifier = "P4B-A-1349";
    const text = `${"prefix ".repeat(60)}${identifier} after the identifier`;
    const bounded = selectBoundedContext([result("a", "100", text)], {
      snippetChars: 40,
      preserveTerms: [identifier],
    });

    expect(bounded.items[0]?.snippet).toContain(identifier);
    expect(bounded.items[0]?.snippet.length).toBeLessThanOrEqual(42); // 40 chars + edge ellipses
  });

  it("keeps every item a single-source search asked for instead of starving it", () => {
    const results = Array.from({ length: 8 }, (_, index) =>
      result(`m${index}`, "100", `message ${index}`),
    );
    const bounded = selectBoundedContext(results, { topK: 8, perSourceCap: null });

    expect(bounded.items).toHaveLength(8);
    expect(bounded.truncated).toBe(false);
    expect(bounded.truncationReasons).toEqual([]);
    expect(bounded.dropped).toBe(0);
    expect(bounded.sources).toEqual([
      { sourceId: "100", returned: 8, considered: 8, capped: false },
    ]);
  });

  it("names why items were dropped instead of only reporting that they were", () => {
    const bounded = selectBoundedContext(
      [
        result("a", "100", "one"),
        result("b", "100", "two"),
        result("c", "100", "three"),
        result("d", "100", "four"),
        result("e", "200", "five"),
      ],
      { perSourceCap: 2 },
    );

    expect(bounded.items.map((i) => i.id)).toEqual(["a", "b", "e"]);
    expect(bounded.truncated).toBe(true);
    expect(bounded.truncationReasons).toEqual(["per_source_cap_reached"]);
    expect(bounded.dropped).toBe(2);
    expect(bounded.sources).toEqual([
      { sourceId: "100", returned: 2, considered: 4, capped: true },
      { sourceId: "200", returned: 1, considered: 1, capped: false },
    ]);
  });

  it("reports the bounds it applied so a partial answer is explainable", () => {
    const bounded = selectBoundedContext([result("a", "100", "one")], {
      topK: 5,
      perSourceCap: null,
      snippetChars: 50,
    });

    expect(bounded.bounds).toEqual({ requestedLimit: 5, perSourceCap: null, snippetChars: 50 });
    expect(bounded.truncationReasons).toEqual([]);
  });

  it("distinguishes an already-surfaced suppression from a bound", () => {
    const bounded = selectBoundedContext([result("a", "100", "one"), result("b", "100", "two")], {
      alreadySurfaced: ["a"],
      topK: 5,
      perSourceCap: null,
    });

    expect(bounded.items.map((i) => i.id)).toEqual(["b"]);
    expect(bounded.truncated).toBe(true);
    expect(bounded.truncationReasons).toEqual(["already_surfaced_suppressed"]);
    expect(bounded.dropped).toBe(1);
  });

  it("names Top K as the reason when the bound that stopped it was the limit", () => {
    const bounded = selectBoundedContext(
      [result("a", "100", "one"), result("b", "200", "two"), result("c", "300", "three")],
      { topK: 2, perSourceCap: null },
    );

    expect(bounded.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(bounded.truncationReasons).toEqual(["top_k_reached"]);
    expect(bounded.dropped).toBe(1);
    expect(bounded.sources).toEqual([
      { sourceId: "100", returned: 1, considered: 1, capped: false },
      { sourceId: "200", returned: 1, considered: 1, capped: false },
      { sourceId: "300", returned: 0, considered: 1, capped: false },
    ]);
  });

  it("bounds only consumable_text so withheld policy text cannot re-enter Context", () => {
    const metadataOnly: SearchResultItem<RetrievalCandidate> = {
      ...result("a", "100", "SECRET BODY"),
      return_mode: "metadata_only",
      consumable_text: "[Result metadata only due to policy: a]",
      redaction_info: { policy_view: "metadata_only", reason_code: "policy_metadata_only" },
    };

    const bounded = selectBoundedContext([metadataOnly]);
    expect(bounded.items[0]?.snippet).toBe("[Result metadata only due to policy: a]");
    expect(JSON.stringify(bounded)).not.toContain("SECRET BODY");
  });
});
