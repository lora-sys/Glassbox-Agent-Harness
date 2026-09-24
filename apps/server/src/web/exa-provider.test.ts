import { describe, expect, it, vi } from "vitest";
import { ExaProvider } from "./exa-provider.js";

const publicResolver = async () => ["93.184.215.14"];

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Exa provider", () => {
  it("reports missing authentication without making a request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await new ExaProvider({ fetcher }).search({ query: "test", maxResults: 2 });
    expect(result.status).toBe("auth_missing");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [401, "auth_missing"],
    [402, "quota_exhausted"],
    [429, "rate_limited"],
    [500, "failed"],
  ] as const)("maps HTTP %i to %s", async (status, expected) => {
    const provider = new ExaProvider({
      apiKey: "test",
      fetcher: vi.fn(async () => response(status, {})),
    });
    expect((await provider.search({ query: "test", maxResults: 2 })).status).toBe(expected);
  });

  it("uses one bounded Search call with highlights", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      response(200, {
        requestId: "request-1",
        results: [{ title: "Example", url: "https://example.com/a", highlights: ["Fact"] }],
      }),
    );
    const result = await new ExaProvider({ apiKey: "test", fetcher }).search({
      query: "example",
      maxResults: 3,
    });
    expect(result).toMatchObject({
      status: "ready",
      requestId: "request-1",
      results: [{ highlights: ["Fact"] }],
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.exa.ai/search");
    expect(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown).toMatchObject({
      query: "example",
      numResults: 3,
      contents: { text: false },
    });
    expect(init?.redirect).toBe("error");
  });

  it("validates a Contents URL before sending it to Exa", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      response(200, { results: [{ url: "https://example.com/a", text: "Article" }] }),
    );
    const provider = new ExaProvider({ apiKey: "test", fetcher, resolveHost: publicResolver });
    await expect(provider.contents("http://127.0.0.1/private")).rejects.toThrow(
      "web_target_non_public",
    );
    expect(fetcher).not.toHaveBeenCalled();
    const result = await provider.contents("https://example.com/a");
    expect(result).toMatchObject({ status: "ready", results: [{ text: "Article" }] });
    const requestBody = fetcher.mock.calls[0]?.[1]?.body;
    const body = JSON.parse(typeof requestBody === "string" ? requestBody : "{}");
    expect(body.urls).toEqual(["https://example.com/a"]);
    expect(body.ids).toBeUndefined();
  });

  it("distinguishes a timeout from empty results", async () => {
    const provider = new ExaProvider({
      apiKey: "test",
      timeoutMs: 1,
      fetcher: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    expect((await provider.search({ query: "test", maxResults: 1 })).status).toBe("timeout");
  });
});
