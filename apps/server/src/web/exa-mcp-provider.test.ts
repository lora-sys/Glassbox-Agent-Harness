import { describe, expect, it, vi } from "vitest";
import { ExaMcpProvider, parseExaMcpSearch, type ExaMcpCaller } from "./exa-mcp-provider.js";

const publicResolver = async () => ["93.184.215.14"];

describe("keyless Exa MCP adapter", () => {
  it("parses source metadata without interpreting relevance as confidence", () => {
    expect(
      parseExaMcpSearch(
        "Title: Example\nURL: https://example.com/a\nPublished: 2026-09-01\nAuthor: A\nHighlights:\nFact one\nFact two",
      ),
    ).toEqual([
      {
        title: "Example",
        url: "https://example.com/a",
        publishedDate: "2026-09-01",
        highlights: ["Fact one", "Fact two"],
      },
    ]);
  });

  it("bounds requested results and distinguishes rate limit from empty results", async () => {
    const call = vi.fn<ExaMcpCaller["call"]>(async () => ({
      isError: true,
      content: [{ type: "text", text: "Rate limit exceeded" }],
    }));
    const result = await new ExaMcpProvider({ call }).search({ query: "test", maxResults: 100 });
    expect(result.status).toBe("quota_exhausted");
    expect(call).toHaveBeenCalledWith("web_search_exa", {
      query: "test",
      numResults: 10,
      objective: "Find public sources that directly answer this query: test",
    });
  });

  it("rejects private URLs before calling hosted Exa", async () => {
    const call = vi.fn<ExaMcpCaller["call"]>(async () => ({ content: [] }));
    const provider = new ExaMcpProvider({ call }, publicResolver);
    await expect(provider.contents("http://127.0.0.1/")).rejects.toThrow("web_target_non_public");
    expect(call).not.toHaveBeenCalled();
  });
});
