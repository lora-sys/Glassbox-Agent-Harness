import { describe, expect, it, vi } from "vite-plus/test";
import { createManagementApi } from "./api";

const token = "a".repeat(43);
const settings = {
  id: "claude-code" as const,
  credentialSource: "local-claude" as const,
  modelProfileId: null,
  model: null,
};
const executor = {
  ...settings,
  executableDetected: true,
  groupSupported: false,
  checking: false,
  tools: "none",
  lastCheck: null,
};
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("executor management actions", () => {
  it("reads a check started elsewhere and its completion without starting another check", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ executors: [{ ...executor, checking: true }] }))
      .mockResolvedValueOnce(
        response({
          executors: [
            {
              ...executor,
              checking: false,
              groupSupported: true,
              lastCheck: { status: "passed", checkedAt: "2026-09-12T01:02:03.000Z" },
            },
          ],
        }),
      );
    const api = createManagementApi(token, { fetch });
    expect((await api.executors())[0]?.checking).toBe(true);
    expect((await api.executors())[0]?.checking).toBe(false);
    expect(
      fetch.mock.calls.every(
        ([path, init]) => path === "/api/manage/executors" && init?.method === "GET",
      ),
    ).toBe(true);
  });
  it("reads and saves configuration without launching its check endpoint", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ executors: [executor] }))
      .mockResolvedValueOnce(response({ executor }));
    const api = createManagementApi(token, { fetch });
    await api.executors();
    await api.saveExecutor(settings);
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/manage/executors",
      "/api/manage/executors",
    ]);
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify(settings));
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(fetch.mock.calls[1]?.[1]?.method).toBe("POST");
  });
  it("checks only through the explicit action and preserves a failed result", async () => {
    const checked = {
      ...executor,
      lastCheck: {
        status: "failed",
        checkedAt: "2026-09-12T01:02:03.000Z",
        code: "EXECUTOR_CHECK_FAILED",
      },
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response({ executor: checked }));
    expect(
      (await createManagementApi(token, { fetch }).checkClaudeExecutor()).lastCheck?.status,
    ).toBe("failed");
    expect(fetch).toHaveBeenCalledWith(
      "/api/manage/executors/claude-code/check",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });
  it("allows a check to exceed the ordinary 15-second read deadline without retrying", async () => {
    vi.useFakeTimers();
    try {
      let resolve: (value: Response) => void = () => undefined;
      const fetch = vi.fn<typeof globalThis.fetch>(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      );
      let finished = false;
      const request = createManagementApi(token, { fetch })
        .checkClaudeExecutor()
        .finally(() => {
          finished = true;
        });
      await vi.advanceTimersByTimeAsync(90000);
      expect(finished).toBe(false);
      resolve(response({ executor }));
      await request;
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("bounds a hung check at 120 seconds and treats completion as unknown", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => undefined));
      const request = createManagementApi(token, { fetch }).checkClaudeExecutor();
      const assertion = expect(request).rejects.toMatchObject({ code: "TIMEOUT" });
      await vi.advanceTimersByTimeAsync(120000);
      await assertion;
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([
    [400, "INVALID_EXECUTOR"],
    [409, "EXECUTOR_BUSY"],
  ] as const)("uses safe executor-specific HTTP %s messages", async (status, code) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response({ error: { message: "private credential settings" } }, status));
    await expect(
      createManagementApi(token, { fetch }).saveExecutor(settings),
    ).rejects.toMatchObject({ code });
  });
});
