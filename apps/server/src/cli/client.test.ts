import { describe, expect, it, vi } from "vite-plus/test";
import { createManagementClient, type ManagementRequest } from "./client.ts";

const connection = { baseUrl: "http://127.0.0.1:8741", token: "management-test-credential" };
const request = { method: "GET", path: "/manage/status" } as const;
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("local management HTTP client", () => {
  it.each([
    { cursor: "abc", token: "not-allowed" },
    { cursor: "abc&token=private" },
    { cursor: "../escape" },
    { cursor: "" },
    { cursor: "a".repeat(1025) },
  ])("rejects unsafe or extra query parameters", async (query) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      createManagementClient(connection, { fetch }).request({
        ...request,
        query,
      } as ManagementRequest),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("accepts only the explicit group-role audit query", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ audit: null }));
    await createManagementClient(connection, { fetch }).request({
      method: "GET",
      path: "/manage/group-role-audit",
      query: { channelId: "p3-qq", groupId: "1126022432" },
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8741/manage/group-role-audit?channelId=p3-qq&groupId=1126022432",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it.each([
    { channelId: "p3-qq", groupId: "1126022432", principalId: "visitor" },
    { channelId: "p3-qq", groupId: "0" },
    { channelId: "p3-qq", groupId: "1126022432&token=secret" },
    { channelId: "../private", groupId: "1126022432" },
  ])("rejects malformed group-role audit queries", async (query) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      createManagementClient(connection, { fetch }).request({
        method: "GET",
        path: "/manage/group-role-audit",
        query,
      } as ManagementRequest),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses the configured origin, bearer token, and redirect rejection", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ status: "ready" }));
    const client = createManagementClient(connection, { fetch });
    expect(await client.request(request)).toEqual({ status: "ready" });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "http://127.0.0.1:8741/manage/status",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        signal: expect.any(AbortSignal),
        headers: { Accept: "application/json", Authorization: "Bearer management-test-credential" },
      }),
    );
  });

  it.each([
    "https://example.com",
    "http://127.0.0.1.example.com",
    "ftp://127.0.0.1",
    "http://127.0.0.1/path",
    "http://user:password@127.0.0.1",
    "http://localhost/?token=hidden",
    "http://[::2]",
  ])("rejects non-loopback or credential-bearing origins before fetch: %s", (baseUrl) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(() => createManagementClient({ ...connection, baseUrl }, { fetch })).toThrow(
      /loopback/u,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["", "bad\r\nAuthorization", "spaces not allowed"])(
    "rejects invalid management credentials",
    (token) => {
      expect(() => createManagementClient({ ...connection, token })).toThrow(/credential/u);
    },
  );

  it.each([
    "//example.com/manage/status",
    "/other/status",
    "/manage/../secrets",
    "/manage/%2e%2e/status",
    "/manage/runs/%2Fprivate",
  ])("rejects paths outside the management namespace", async (path) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      createManagementClient(connection, { fetch }).request({ ...request, path }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds request bytes before contacting the server", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createManagementClient(connection, { fetch, maxRequestBytes: 8 });
    await expect(
      client.request({ method: "POST", path: "/manage/models", body: { message: "oversized" } }),
    ).rejects.toMatchObject({ code: "REQUEST_TOO_LARGE" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    new Response("not JSON", { headers: { "content-type": "application/json" } }),
    new Response("<html>secret upstream content</html>", {
      headers: { "content-type": "text/html" },
    }),
    jsonResponse(null),
    jsonResponse("string"),
    new Response(new Uint8Array([255]), { headers: { "content-type": "application/json" } }),
  ])("rejects malformed and non-object JSON responses", async (response) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    await expect(
      createManagementClient(connection, { fetch }).request(request),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects a declared oversized response", async () => {
    const response = jsonResponse({ state: "ready" });
    response.headers.set("content-length", "1000");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    await expect(
      createManagementClient(connection, { fetch, maxResponseBytes: 20 }).request(request),
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  it("bounds streamed bytes even without a content-length header", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ data: "x".repeat(200) }));
    await expect(
      createManagementClient(connection, { fetch, maxResponseBytes: 50 }).request(request),
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  it("rejects redirect responses and never retries at another origin", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://example.com/collect" },
      }),
    );
    await expect(
      createManagementClient(connection, { fetch }).request(request),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("aborts a stalled request by its deadline", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetch = vi.fn<typeof globalThis.fetch>((_url, options) => {
        signal = options?.signal ?? undefined;
        return new Promise(() => undefined);
      });
      const result = createManagementClient(connection, { fetch, timeoutMs: 20 }).request(request);
      const assertion = expect(result).rejects.toMatchObject({ code: "TIMEOUT" });
      await vi.advanceTimersByTimeAsync(20);
      await assertion;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the deadline active while response content is stalled", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
        },
        cancel,
      });
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          new Response(stream, { headers: { "content-type": "application/json" } }),
        );
      const result = createManagementClient(connection, { fetch, timeoutMs: 20 }).request(request);
      const assertion = expect(result).rejects.toMatchObject({ code: "TIMEOUT" });
      await vi.advanceTimersByTimeAsync(20);
      await assertion;
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [401, "AUTH_REQUIRED"],
    [403, "FORBIDDEN"],
    [404, "NOT_AVAILABLE"],
    [409, "CONFLICT"],
    [500, "SERVER_ERROR"],
  ] as const)("maps HTTP %s to a non-secret error", async (status, code) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "UNSAFE_SERVER_CODE",
            message: "secret-key-value",
            stack: "private stack",
          },
        },
        status,
      ),
    );
    await expect(
      createManagementClient(connection, { fetch }).request(request),
    ).rejects.toMatchObject({ code });
  });

  it("recognizes a structured error returned with a successful HTTP status", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        jsonResponse({ error: { code: "NOT_AVAILABLE", message: "upstream secret" } }),
      );
    await expect(
      createManagementClient(connection, { fetch }).request(request),
    ).rejects.toMatchObject({
      code: "NOT_AVAILABLE",
      message: "This operation is not available on the connected server.",
    });
  });

  it("does not expose arbitrary transport error text", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error("token=secret-key-value"));
    await expect(
      createManagementClient(connection, { fetch }).request(request),
    ).rejects.toMatchObject({
      code: "CONNECTION_FAILED",
      message: "Could not reach the configured local server. Check glassbox serve.",
    });
  });
});
