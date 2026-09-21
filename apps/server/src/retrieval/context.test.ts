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
