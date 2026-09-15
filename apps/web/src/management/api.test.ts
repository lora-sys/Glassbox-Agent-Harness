import { describe, expect, it, vi } from "vite-plus/test";
import { createManagementApi, takeFragmentToken } from "./api";
import { failureMessage } from "./errors";

const token = "a".repeat(43);
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const profile = {
  id: "daily",
  label: "Daily",
  protocol: "openai-completions" as const,
  baseUrl: "https://api.example.test/v1",
  model: "example-model",
  credentialConfigured: true,
};

describe("same-origin management requests", () => {
  it("uses the same API as CLI through the development proxy", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response({ profiles: [profile] }));
    expect(await createManagementApi(token, { fetch }).models()).toEqual([profile]);
    expect(fetch).toHaveBeenCalledWith(
      "/api/manage/models",
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      `Bearer ${token}`,
    );
  });
  it("does not contact the server with an invalid token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(createManagementApi("wrong", { fetch }).models()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("submits only the explicit model save body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ profile }));
    const { credentialConfigured: _configured, ...body } = profile;
    expect(
      await createManagementApi(token, { fetch }).saveModel({ ...body, apiKey: "disposable-key" }),
    ).toEqual(profile);
    expect(fetch).toHaveBeenCalledWith(
      "/api/manage/models",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ ...body, apiKey: "disposable-key" }),
      }),
    );
  });
  it.each([
    [401, "UNAUTHORIZED"],
    [403, "FORBIDDEN"],
    [404, "NOT_AVAILABLE"],
    [400, "INVALID_CONFIGURATION"],
    [500, "SERVER_ERROR"],
  ] as const)("returns safe errors for HTTP %s", async (status, code) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        response({ error: { code: "PRIVATE", message: "sensitive upstream payload" } }, status),
      );
    await expect(createManagementApi(token, { fetch }).models()).rejects.toMatchObject({ code });
  });
  it("does not treat unavailable endpoints as an empty successful list", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response({ error: { code: "NOT_AVAILABLE", message: "not ready" } }, 404));
    await expect(createManagementApi(token, { fetch }).models()).rejects.toMatchObject({
      code: "NOT_AVAILABLE",
    });
  });
  it.each([
    new Response("<html>private error</html>", { headers: { "content-type": "text/html" } }),
    new Response("{", { headers: { "content-type": "application/json" } }),
    new Response(null, { status: 302, headers: { location: "https://example.test" } }),
    response({ profiles: [{ ...profile, label: token }] }),
  ])("rejects invalid or credential-bearing responses", async (result) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(result);
    await expect(createManagementApi(token, { fetch }).models()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
  it("rejects a response echoing the submitted model key", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response({ profile: { ...profile, label: "disposable-key" } }));
    const { credentialConfigured: _configured, ...body } = profile;
    await expect(
      createManagementApi(token, { fetch }).saveModel({ ...body, apiKey: "disposable-key" }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it("limits bytes even without content-length", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response({ profiles: [profile] }));
    await expect(
      createManagementApi(token, { fetch, maxResponseBytes: 10 }).models(),
    ).rejects.toMatchObject({ code: "TOO_LARGE" });
  });
  it("cancels stale requests", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => undefined));
    const controller = new AbortController();
    const request = createManagementApi(token, { fetch }).models(controller.signal);
    const assertion = expect(request).rejects.toMatchObject({ code: "ABORTED" });
    controller.abort();
    await assertion;
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
  it("bounds a stalled request with a deadline", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => undefined));
      const request = createManagementApi(token, { fetch, timeoutMs: 20 }).models();
      const assertion = expect(request).rejects.toMatchObject({ code: "TIMEOUT" });
      await vi.advanceTimersByTimeAsync(20);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
  it("never displays arbitrary thrown error text", () => {
    expect(failureMessage(new Error("private upstream response"))).not.toContain("private");
  });
});

describe("local access fragment", () => {
  it("removes the token from browser history before returning it", () => {
    const history = { replaceState: vi.fn(), state: { local: true } };
    expect(
      takeFragmentToken(
        { hash: `#access_token=${token}`, pathname: "/manage", search: "" },
        history,
      ),
    ).toBe(token);
    expect(history.replaceState).toHaveBeenCalledWith(history.state, "", "/manage");
  });
  it("also removes invalid credentials and preserves query state", () => {
    const history = { replaceState: vi.fn(), state: null };
    expect(
      takeFragmentToken(
        { hash: "#access_token=invalid", pathname: "/manage", search: "?view=models" },
        history,
      ),
    ).toBeNull();
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/manage?view=models");
  });
});
