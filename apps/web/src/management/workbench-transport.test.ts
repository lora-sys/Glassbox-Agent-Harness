import { describe, expect, it, vi } from "vite-plus/test";
import { createWorkbenchTransport } from "./workbench-transport";

const token = "a".repeat(43);
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
class FakeSocket extends EventTarget {
  closed = false;
  close() {
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }
}

describe("authenticated Workbench transport", () => {
  it("obtains a fresh ticket for every socket connection and keeps bearer tokens out of URLs", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ ticket: "first-disposable-ticket-1234" }))
      .mockResolvedValueOnce(response({ ticket: "second-disposable-ticket-5678" }));
    const sockets: FakeSocket[] = [];
    const createSocket = vi.fn((url: string) => {
      expect(url).not.toContain(token);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    });
    const transport = createWorkbenchTransport({ fetch, readToken: () => token, createSocket });
    await transport.openSocket("session-1");
    sockets[0]?.close();
    await transport.openSocket("session-1");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/manage/ws-ticket",
      "/api/manage/ws-ticket",
    ]);
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ sessionId: "session-1" }));
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      `Bearer ${token}`,
    );
    expect(createSocket.mock.calls.map(([url]) => url)).toEqual([
      "/ws?sessionId=session-1&ticket=first-disposable-ticket-1234",
      "/ws?sessionId=session-1&ticket=second-disposable-ticket-5678",
    ]);
    transport.dispose();
    expect(sockets[1]?.closed).toBe(true);
  });
  it("cancels a pending ticket request when the view is disposed", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => undefined));
    const createSocket = vi.fn();
    const transport = createWorkbenchTransport({ fetch, readToken: () => token, createSocket });
    const pending = transport.openSocket("session-1");
    const assertion = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    transport.dispose();
    await assertion;
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(createSocket).not.toHaveBeenCalled();
  });
  it("cancels a pending ticket before switching sessions", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => undefined));
    const transport = createWorkbenchTransport({ fetch, readToken: () => token });
    const controller = new AbortController();
    const pending = transport.openSocket("session-1", controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    controller.abort();
    await assertion;
    transport.dispose();
  });
  it("keeps successful legacy JSON responses compatible", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response({ sessionId: "session-1", derivedState: { task: "fixture" } }));
    const transport = createWorkbenchTransport({ fetch, readToken: () => token });
    expect(await (await transport.request("/api/state/session-1")).json()).toEqual({
      sessionId: "session-1",
      derivedState: { task: "fixture" },
    });
    transport.dispose();
  });
  it("does not expose raw HTTP error bodies", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response({ error: `private ${token}` }, 500));
    const transport = createWorkbenchTransport({ fetch, readToken: () => token });
    await expect(transport.request("/api/run-stream")).rejects.toMatchObject({
      code: "SERVER_ERROR",
    });
    transport.dispose();
  });
  it("rejects malformed and credential-bearing ticket responses", async () => {
    for (const ticket of ["bad", token, "https://example.test/collect"]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ ticket }));
      const createSocket = vi.fn();
      const transport = createWorkbenchTransport({ fetch, readToken: () => token, createSocket });
      await expect(transport.openSocket("session-1")).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
      });
      expect(createSocket).not.toHaveBeenCalled();
      transport.dispose();
    }
  });
  it("aborts after its deadline instead of leaving startup pending", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => undefined));
      const transport = createWorkbenchTransport({ fetch, readToken: () => token, timeoutMs: 20 });
      const pending = transport.request("/api/run-stream");
      const assertion = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
      await vi.advanceTimersByTimeAsync(20);
      await assertion;
      transport.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
