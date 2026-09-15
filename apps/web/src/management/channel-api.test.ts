import { describe, expect, it, vi } from "vite-plus/test";
import { createManagementApi } from "./api";

const managementToken = "a".repeat(43);
const input = {
  id: "qq-personal",
  label: "我的 QQ 助理",
  kind: "qq-onebot" as const,
  endpoint: "ws://127.0.0.1:6700/",
  botId: "12345",
  ownerId: "54321",
  groupIds: ["77777"],
  executionRef: "claude-code",
};
const channel = {
  ...input,
  tokenConfigured: true,
  autoConnect: false,
  connectionState: "disconnected" as const,
};
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("same-origin channel management requests", () => {
  it("reads public channels through the shared bearer-authenticated management boundary", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response({ channels: [channel] }));
    expect(await createManagementApi(managementToken, { fetch }).channels()).toEqual([channel]);
    expect(fetch).toHaveBeenCalledWith(
      "/api/manage/channels",
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      `Bearer ${managementToken}`,
    );
  });

  it("saves without connecting and does not allow a response to echo a submitted token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ channel }));
    await createManagementApi(managementToken, { fetch }).saveChannel({
      ...input,
      token: "private-qq-token",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "/api/manage/channels",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ ...input, token: "private-qq-token" }),
      }),
    );
    fetch.mockResolvedValue(response({ channel: { ...channel, label: "private-qq-token" } }));
    await expect(
      createManagementApi(managementToken, { fetch }).saveChannel({
        ...input,
        token: "private-qq-token",
      }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("posts separate explicit connect and disconnect actions with no credential or scope body", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => response({ channel }));
    const api = createManagementApi(managementToken, { fetch });
    await api.connectChannel(input.id);
    await api.disconnectChannel(input.id);
    expect(
      fetch.mock.calls.map(([url, init]) => ({ url, body: init?.body, method: init?.method })),
    ).toEqual([
      { url: "/api/manage/channels/qq-personal/connect", body: "{}", method: "POST" },
      { url: "/api/manage/channels/qq-personal/disconnect", body: "{}", method: "POST" },
    ]);
    expect(() => api.connectChannel("../other")).toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("maps HTTP conflict to an instruction to disconnect without reading private errors", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response({ error: { message: "private server text" } }, 409));
    await expect(
      createManagementApi(managementToken, { fetch }).saveChannel(input),
    ).rejects.toMatchObject({ code: "CHANNEL_ACTIVE" });
  });

  it("uses channel-specific validation errors without showing private server details", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response({ error: { message: "private configuration" } }, 400));
    await expect(
      createManagementApi(managementToken, { fetch }).saveChannel(input),
    ).rejects.toMatchObject({ code: "INVALID_CHANNEL" });
  });

  it("reports timeout as an uncertain operation without retrying automatically", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => undefined));
      const request = createManagementApi(managementToken, { fetch, timeoutMs: 10 }).connectChannel(
        input.id,
      );
      const assertion = expect(request).rejects.toMatchObject({ code: "TIMEOUT" });
      await vi.advanceTimersByTimeAsync(10);
      await assertion;
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
