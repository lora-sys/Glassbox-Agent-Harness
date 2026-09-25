import { describe, expect, it, vi } from "vitest";
import { WebService, canonicalWebUrl, type WebProvider, type WebPlanner } from "./web-service.js";

const publicResolver = async () => ["93.184.215.14"];
const now = () => new Date("2026-09-23T12:00:00.000Z");

function provider(
  results: readonly {
    url: string;
    title: string;
    highlights?: string[];
    text?: string;
    publishedDate?: string;
  }[],
): WebProvider {
  return {
    search: vi.fn(async () => ({ status: "ready" as const, results })),
    contents: vi.fn(async () => ({ status: "ready" as const, results })),
  };
}

describe("Web service", () => {
  it("uses fast Exa search and returns bounded stable source IDs", async () => {
    const exa = provider([
      { url: "https://example.com/a?utm_source=x", title: "A", highlights: ["one"] },
      { url: "https://example.com/a?utm_source=y", title: "Duplicate", highlights: ["two"] },
      { url: "http://127.0.0.1/admin", title: "Private", highlights: [] },
    ]);
    const service = new WebService({ provider: exa, resolveHost: publicResolver, now });
    const first = await service.search("run-1", { query: " Playwright docs ", maxResults: 5 });
    const second = await service.search("run-1", { query: "Playwright docs", maxResults: 5 });
    expect(first.results).toHaveLength(1);
    expect(first.results[0]).toMatchObject({
      title: "A",
      canonicalUrl: "https://example.com/a",
      retrievedAt: "2026-09-23T12:00:00.000Z",
      providerOrigins: ["exa_mcp"],
      rank: 1,
    });
    expect(first.results[0]?.sourceId).toBe(second.results[0]?.sourceId);
    expect(first.truncated).toBe(true);
    expect(first.plan).toMatchObject({ mode: "fast", queryVariants: ["Playwright docs"] });
    expect((exa.search as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it("uses no more than three Jev variants and reranks without factual confidence", async () => {
    const exa = provider([
      { url: "https://example.com/a", title: "A", highlights: ["A"] },
      { url: "https://example.com/b", title: "B", highlights: ["B"] },
    ]);
    const planner: WebPlanner = {
      plan: async () => ({
        mode: "complex",
        queryVariants: ["query", "second", "third", "fourth"],
        jevUsed: true,
      }),
      rerank: async () => [{ url: "https://example.com/b", relevanceScore: 0.9 }],
    };
    const result = await new WebService({
      provider: exa,
      planner,
      resolveHost: publicResolver,
      now,
    }).search("run-1", { query: "query" });
    expect((exa.search as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
    expect(result.plan.queryVariants).toHaveLength(3);
    expect(result.results[0]?.url).toBe("https://example.com/b");
    expect(result.results[0]?.relevanceScore).toBe(0.9);
    expect(result.results[0]).not.toHaveProperty("confidence");
  });

  it("searches recent months without letting a newer unrelated domain outrank relevance", async () => {
    const search = vi.fn(async ({ query }: { query: string; maxResults: number }) => ({
      status: "ready" as const,
      results: query.includes("September 2026")
        ? [
            {
              url: "https://unrelated.example/news",
              title: "Unrelated September news",
              publishedDate: "2026-09-22T09:00:00.000Z",
            },
            {
              url: "https://vercel.com/blog/september-update",
              title: "September update",
              publishedDate: "2026-09-18T09:00:00.000Z",
            },
          ]
        : [
            {
              url: "https://vercel.com/blog/july-update",
              title: "July update",
              publishedDate: "2026-07-15T09:00:00.000Z",
            },
            {
              url: "https://vercel.com/blog/june-update",
              title: "June update",
              publishedDate: "2026-06-15T09:00:00.000Z",
            },
          ],
    }));
    const exa: WebProvider = {
      search,
      contents: vi.fn(async () => ({ status: "ready" as const, results: [] })),
    };
    const planner: WebPlanner = {
      plan: async () => ({ mode: "fast", queryVariants: [], jevUsed: false }),
      rerank: async () => [],
    };

    const result = await new WebService({
      provider: exa,
      planner,
      resolveHost: publicResolver,
      now,
    }).search("run-1", { query: "find the latest Vercel blog posts", maxResults: 2 });

    expect(result.plan.queryVariants).toEqual([
      "find the latest Vercel blog posts September 2026",
      "find the latest Vercel blog posts",
      "find the latest Vercel blog posts August 2026",
    ]);
    expect(result.results.map(({ title }) => title)).toEqual(["September update", "July update"]);
    expect(result.results.map(({ domain }) => domain)).toEqual(["vercel.com", "vercel.com"]);
    expect(search).toHaveBeenCalledTimes(3);
  });

  it("uses Chinese calendar words for a Chinese freshness request", async () => {
    const search = vi.fn(async () => ({ status: "ready" as const, results: [] }));
    const planner: WebPlanner = {
      plan: async () => ({ mode: "fast", queryVariants: [], jevUsed: false }),
      rerank: async () => [],
    };
    const result = await new WebService({
      provider: {
        search,
        contents: vi.fn(async () => ({ status: "ready" as const, results: [] })),
      },
      planner,
      resolveHost: publicResolver,
      now,
    }).search("run-1", { query: "vercel 最新的博客" });
    expect(result.plan.queryVariants).toEqual([
      "vercel 最新的博客 2026年9月",
      "vercel 最新的博客",
      "vercel 最新的博客 2026年8月",
    ]);
  });

  it("applies domain and publication time filters to provider results", async () => {
    const exa = provider([
      { url: "https://example.com/a", title: "Root", publishedDate: "2026-09-01T00:00:00.000Z" },
      {
        url: "https://sub.example.com/b",
        title: "Subdomain",
        publishedDate: "2026-09-01T00:00:00.000Z",
      },
      {
        url: "https://blocked.example.com/c",
        title: "Excluded subdomain",
        publishedDate: "2026-09-20T00:00:00.000Z",
      },
      {
        url: "https://other.com/d",
        title: "Outside inclusion",
        publishedDate: "2026-09-20T00:00:00.000Z",
      },
      { url: "https://sub.example.com/e", title: "Unknown date" },
    ]);
    const result = await new WebService({ provider: exa, resolveHost: publicResolver, now }).search(
      "run-1",
      {
        query: "query",
        timeRange: "month",
        includeDomains: ["example.com"],
        excludeDomains: ["blocked.example.com"],
      },
    );
    expect(result.results.map(({ title }) => title)).toEqual(["Root", "Subdomain"]);
    expect(result.discardedCount).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it("rejects language filters that hosted Exa MCP cannot guarantee", async () => {
    const search = vi.fn(async () => ({
      status: "ready" as const,
      results: [{ url: "https://example.com/a", title: "A" }],
    }));
    const exa: WebProvider = {
      search,
      contents: vi.fn(async () => ({ status: "ready" as const, results: [] })),
    };
    const service = new WebService({ provider: exa, resolveHost: publicResolver });
    await expect(service.search("run-1", { query: "query", language: "zh" })).rejects.toThrow(
      "unsupported_web_language_filter",
    );
    expect(search).not.toHaveBeenCalled();
  });

  it("rejects malformed domain filters before calling the provider", async () => {
    const search = vi.fn(async () => ({
      status: "ready" as const,
      results: [{ url: "https://example.com/a", title: "A" }],
    }));
    const exa: WebProvider = {
      search,
      contents: vi.fn(async () => ({ status: "ready" as const, results: [] })),
    };
    const service = new WebService({ provider: exa, resolveHost: publicResolver });
    await expect(
      service.search("run-1", { query: "query", includeDomains: ["https://example.com/path"] }),
    ).rejects.toThrow("invalid_web_include_domains");
    expect(search).not.toHaveBeenCalled();
  });

  it("reports quota exhaustion and can use browser search fallback", async () => {
    const exa: WebProvider = {
      search: async () => ({ status: "quota_exhausted", results: [] }),
      contents: async () => ({ status: "quota_exhausted", results: [] }),
    };
    const unavailable = await new WebService({ provider: exa, resolveHost: publicResolver }).search(
      "run-1",
      { query: "query" },
    );
    expect(unavailable).toMatchObject({
      status: "unavailable",
      providerStatus: "quota_exhausted",
      results: [],
    });
    const fallback = new WebService({
      provider: exa,
      resolveHost: publicResolver,
      browserFallback: {
        search: async () => ({
          status: "succeeded" as const,
          results: [{ url: "https://example.com/a", title: "A", highlights: ["found"] }],
        }),
        fetch: async () => ({ status: "unavailable" as const }),
      },
    });
    const result = await fallback.search("run-1", { query: "query" });
    expect(result.plan.mode).toBe("browser_fallback");
    expect(result.providerStatus).toBe("quota_exhausted");
    expect(result.results[0]?.retrievalMethod).toBe("browser_search");
  });

  it.each(["blocked", "fallback_denied", "unavailable"] as const)(
    "preserves browser search status %s without reporting zero-result success",
    async (status) => {
      const exa: WebProvider = {
        search: async () => ({ status: "rate_limited", results: [] }),
        contents: async () => ({ status: "rate_limited", results: [] }),
      };
      const result = await new WebService({
        provider: exa,
        resolveHost: publicResolver,
        browserFallback: {
          search: async () => ({ status, results: [] }),
          fetch: async () => ({ status: "unavailable" }),
        },
      }).search("run-1", { query: "query" });
      expect(result).toMatchObject({ status, providerStatus: "rate_limited", results: [] });
      expect(result.plan.mode).toBe("browser_fallback");
    },
  );

  it("preserves browser partial search output and unknown metadata", async () => {
    const exa: WebProvider = {
      search: async () => ({ status: "failed", results: [] }),
      contents: async () => ({ status: "failed", results: [] }),
    };
    const result = await new WebService({
      provider: exa,
      resolveHost: publicResolver,
      browserFallback: {
        search: async () => ({
          status: "partial",
          results: [
            {
              url: "https://example.com/a",
              title: "A",
              highlights: [],
              author: null,
              publishedAt: null,
            },
          ],
        }),
        fetch: async () => ({ status: "unavailable" }),
      },
    }).search("run-1", { query: "query" });
    expect(result).toMatchObject({ status: "partial", partial: true });
    expect(result.results[0]).toMatchObject({ author: null, publishedAt: null });
  });

  it("fetches one validated URL with the same source ID and bounded content", async () => {
    const exa = provider([{ url: "https://example.com/a", title: "A", text: "x".repeat(100) }]);
    const service = new WebService({ provider: exa, resolveHost: publicResolver, now });
    const search = await service.search("run-1", { query: "query" });
    const fetched = await service.fetch("run-1", { url: "https://example.com/a", maxChars: 20 });
    expect(fetched).toMatchObject({ status: "succeeded", text: "x".repeat(20), truncated: true });
    expect(fetched.sourceId).toBe(search.results[0]?.sourceId);
    await expect(service.fetch("run-1", { url: "http://127.0.0.1/" })).rejects.toThrow(
      "web_target_non_public",
    );
    expect((exa.contents as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("retains browser fetch status, final URL, extraction method, and avoids prose for binary content", async () => {
    const exa: WebProvider = {
      search: async () => ({ status: "ready", results: [] }),
      contents: async () => ({ status: "failed", results: [] }),
    };
    const service = new WebService({
      provider: exa,
      resolveHost: publicResolver,
      browserFallback: {
        search: async () => ({ status: "unavailable", results: [] }),
        fetch: async () => ({
          status: "partial",
          finalUrl: "https://example.com/final.pdf",
          title: "PDF",
          text: "must not be rendered as prose",
          contentType: "application/pdf",
          extractionMethod: "none",
          author: null,
          publishedAt: null,
        }),
      },
    });
    const fetched = await service.fetch("run-1", { url: "https://example.com/start" });
    expect(fetched).toMatchObject({
      status: "partial",
      url: "https://example.com/final.pdf",
      extractionMethod: "none",
      author: null,
      publishedAt: null,
      text: "",
    });
  });

  it("canonicalizes only known tracking parameters", () => {
    expect(canonicalWebUrl(new URL("https://example.com/a/?utm_source=x&id=1#part"))).toBe(
      "https://example.com/a?id=1",
    );
  });
});
