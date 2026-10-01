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
        author: "A",
        highlights: ["Fact one", "Fact two"],
      },
    ]);
  });

  it("bounds requested results and distinguishes rate limiting from quota exhaustion", async () => {
    const call = vi.fn<ExaMcpCaller["call"]>(async () => ({
      isError: true,
      content: [{ type: "text", text: "Rate limit exceeded" }],
    }));
    const result = await new ExaMcpProvider({ call }).search({ query: "test", maxResults: 100 });
    expect(result.status).toBe("rate_limited");
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

describe("MCP transport failure classification", () => {
  it.each([
    [401, "auth_missing"],
    [403, "auth_missing"],
    [402, "quota_exhausted"],
    [429, "rate_limited"],
    [500, "failed"],
    [-32001, "timeout"],
  ])("reports code %s as %s without exposing transport details", async (code, status) => {
    const call = vi.fn<ExaMcpCaller["call"]>(async () => {
      throw Object.assign(
        new Error("secret-query=https://private.invalid/token?credential=canary"),
        { code },
      );
    });
    const provider = new ExaMcpProvider({ call }, publicResolver);
    expect(await provider.search({ query: "public", maxResults: 1 })).toEqual({
      status,
      results: [],
    });
    expect(await provider.contents("https://example.com/a")).toEqual({ status, results: [] });
  });
  it("does not classify arbitrary error-body digits as an HTTP status", async () => {
    const call = vi.fn<ExaMcpCaller["call"]>(async () => {
      throw new Error("example URL /429 and a private token");
    });
    expect(await new ExaMcpProvider({ call }).search({ query: "public", maxResults: 1 })).toEqual({
      status: "failed",
      results: [],
    });
  });
});
