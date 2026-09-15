import { describe, expect, it, vi } from "vite-plus/test";
import { createManagementApi } from "./api";
import { managementFetch } from "./access";

const token = "a".repeat(43);
const time = "2026-09-12T01:02:03.000Z";
const run = {
  id: "run-1",
  conversationId: "conversation-1",
  messageId: "incoming-1",
  executionRef: "model:local",
  status: "running",
  resultText: null,
  createdAt: time,
  updatedAt: time,
};
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("management record transport boundaries", () => {
  it.each([502, 503, 504])(
    "recognizes a non-JSON proxy HTTP %s as service unavailability",
    async (status) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response("<html>Bad Gateway private details</html>", {
          status,
          headers: { "content-type": "text/html" },
        }),
      );
      await expect(createManagementApi(token, { fetch }).runs()).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
      });
    },
  );
  it("uses structured cursor and conversation filters on the same authenticated origin", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => response({ items: [], nextCursor: null }));
    const api = createManagementApi(token, { fetch });
    await api.runs({ cursor: "cursor_1", conversationId: "conversation-1" });
    await api.conversations({ cursor: "cursor-2" });
    await api.deliveries("run-1", { cursor: "cursor-3" });
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/manage/runs?cursor=cursor_1&conversationId=conversation-1",
      "/api/manage/conversations?cursor=cursor-2",
      "/api/manage/runs/run-1/deliveries?cursor=cursor-3",
    ]);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      `Bearer ${token}`,
    );
  });

  it.each([
    "/api/manage/runs?token=private",
    "/api/manage/runs?cursor=https%3A%2F%2Fremote.test",
    "/api/manage/runs?cursor=first&cursor=second",
    "/api/manage/runs?conversationId=..%2Fother",
    "/api/manage/runs?cursor=ok#fragment",
    "/api/manage/runs?cursor=one?cursor=two",
    "/api/manage/runs?%63ursor=ok",
    "/api/manage/runs?cursor=",
    "/api/manage/runs?",
  ])("rejects untrusted query URLs before disclosing authorization %s", async (path) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(managementFetch(path, {}, { token, fetch })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts cancellation explicitly and decodes the server state instead of assuming completion", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response({ run: { ...run, status: "cancelling" } }));
    expect((await createManagementApi(token, { fetch }).cancelRun("run-1")).status).toBe(
      "cancelling",
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/manage/runs/run-1/cancel",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });

  it("rejects cross-run results and unsafe identifiers", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ run }));
    const api = createManagementApi(token, { fetch });
    await expect(api.run("run-2")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(() => api.cancelRun("../other")).toThrow();
    await expect(api.runs({ cursor: "https://remote" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("supports trace cursors without sending a management credential in the URL", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response({ records: [], nextCursor: null, indexed: null }));
    expect(
      await createManagementApi(token, { fetch }).trace("run-1", { cursor: "gbxtrc_cursor" }),
    ).toEqual({ records: [], nextCursor: null, indexed: null });
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/manage/runs/run-1/trace?cursor=gbxtrc_cursor");
  });

  it("rejects a filtered run list that contains another conversation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      response({
        items: [
          {
            ...run,
            scope: {
              connectionId: "qq-main",
              botId: "12345",
              chatType: "group",
              chatId: "77777",
              senderId: "54321",
            },
          },
        ],
        nextCursor: null,
      }),
    );
    await expect(
      createManagementApi(token, { fetch }).runs({ conversationId: "conversation-2" }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it.each([
    [404, "RECORD_UNAVAILABLE"],
    [409, "RUN_CHANGED"],
    [400, "INVALID_RECORD_INPUT"],
  ] as const)("uses safe record-specific HTTP %s errors", async (status, code) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response({ error: { message: "private upstream error" } }, status));
    await expect(createManagementApi(token, { fetch }).run("run-1")).rejects.toMatchObject({
      code,
    });
  });

  it("posts only the fixed evidence suite and leaves evaluation creation uncertain on timeout", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => undefined));
      const promise = createManagementApi(token, { fetch, timeoutMs: 10 }).evaluateRun("run-1");
      const assertion = expect(promise).rejects.toMatchObject({ code: "TIMEOUT" });
      await vi.advanceTimersByTimeAsync(10);
      await assertion;
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        "/api/manage/runs/run-1/evals",
        expect.objectContaining({ method: "POST", body: '{"suiteId":"run-integrity-v1"}' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts detail loading when selection changes", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => undefined));
    const controller = new AbortController();
    const promise = createManagementApi(token, { fetch }).run("run-1", controller.signal);
    const assertion = expect(promise).rejects.toMatchObject({ code: "ABORTED" });
    controller.abort();
    await assertion;
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
