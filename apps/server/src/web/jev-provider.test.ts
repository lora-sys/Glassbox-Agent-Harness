import { describe, expect, it, vi } from "vitest";
import { JevProvider } from "./jev-provider.js";

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Jev provider", () => {
  it("does not call the service without a key", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = new JevProvider({ apiKey: "", fetcher });
    expect(
      await provider.chooseQuery("long complex query with several details", ["a", "b"]),
    ).toEqual({
      status: "auth_missing",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses one bounded System One request to select among query candidates", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      response(200, { answers: { query: { type: "choice", choice: "q1" } } }),
    );
    const provider = new JevProvider({ apiKey: "test", fetcher });
    expect(await provider.chooseQuery("long query", ["original", "compact"])).toEqual({
      status: "ready",
      value: 1,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://thejevai.com/v1/systemone");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer test",
      "content-type": "application/json",
    });
    expect(JSON.parse(typeof init?.body === "string" ? init.body : "{}")).toMatchObject({
      model: "jev-latest",
      questions: { query: { type: "choice" } },
    });
  });

  it("reads validated answers from the System One success envelope", async () => {
    const provider = new JevProvider({
      apiKey: "test",
      fetcher: vi.fn(async () =>
        response(200, {
          code: 0,
          message: "success",
          data: {
            result: {
              answers: { query: { type: "choice", choice: "q1" } },
              usage: { totalTokens: 12 },
              elapsedMs: 34,
            },
            creditsUsed: 1,
          },
        }),
      ),
    });
    expect(await provider.chooseQuery("query", ["one", "two"])).toEqual({
      status: "ready",
      value: 1,
    });
  });

  it.each([
    { code: 1, data: { result: { answers: { query: { type: "choice", choice: "q0" } } } } },
    { code: 0, data: { result: { answers: [] } } },
    { code: 0, data: { result: {} } },
    { code: 0, answers: { query: { type: "choice", choice: "q0" } } },
  ])("rejects a failed or malformed System One envelope", async (body) => {
    const provider = new JevProvider({
      apiKey: "test",
      fetcher: vi.fn(async () => response(200, body)),
    });
    expect(await provider.chooseQuery("query", ["one", "two"])).toEqual({ status: "failed" });
  });

  it("scores candidate relevance in one batched call and bounds question count", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        questions: Record<string, unknown>;
      };
      const answers = Object.fromEntries(
        Object.keys(body.questions).map((id, index) => [id, { type: "noul", noul: index / 12 }]),
      );
      return response(200, { answers });
    });
    const provider = new JevProvider({ apiKey: "test", fetcher });
    const candidates = Array.from({ length: 20 }, (_, index) => ({
      url: `https://example.com/${index}`,
      title: `Title ${index}`,
      highlights: [`Highlight ${index}`],
    }));
    const result = await provider.scoreCandidates("query", candidates);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("ready");
    if (result.status === "ready") expect(result.value).toHaveLength(13);
    const request = JSON.parse(
      typeof fetcher.mock.calls[0]?.[1]?.body === "string"
        ? (fetcher.mock.calls[0]![1]!.body as string)
        : "{}",
    ) as {
      questions: Record<string, unknown>;
    };
    expect(Object.keys(request.questions)).toHaveLength(13);
  });

  it.each([
    [401, "auth_missing"],
    [429, "quota_exhausted"],
    [529, "failed"],
    [500, "failed"],
  ] as const)("maps HTTP %i to %s", async (status, expected) => {
    const provider = new JevProvider({
      apiKey: "test",
      fetcher: vi.fn(async () => response(status, {})),
    });
    expect((await provider.chooseQuery("query", ["one", "two"])).status).toBe(expected);
  });

  it("rejects an invalid answer without returning unvalidated indexes", async () => {
    const provider = new JevProvider({
      apiKey: "test",
      fetcher: vi.fn(async () =>
        response(200, { answers: { query: { type: "choice", choice: "q9" } } }),
      ),
    });
    expect(await provider.chooseQuery("query", ["one", "two"])).toEqual({ status: "failed" });
  });

  it("distinguishes timeout from provider failure", async () => {
    const provider = new JevProvider({
      apiKey: "test",
      timeoutMs: 1,
      fetcher: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    expect((await provider.chooseQuery("query", ["one", "two"])).status).toBe("timeout");
  });
});
