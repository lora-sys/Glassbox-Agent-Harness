import { expect, it, vi } from "vite-plus/test";
import { WebService } from "./web-service.js";
import { ExaProvider } from "./exa-provider.js";
import { ExaMcpProvider, HostedExaMcpCaller } from "./exa-mcp-provider.js";
import { GuardedBrowserFallback } from "./browser-fallback.js";
import { BrowserBridge } from "./browser-bridge.js";
import { JevPlanner } from "./jev-planner.js";
import { JevProvider } from "./jev-provider.js";
import { cancellableBrowserCommand } from "./cancellation.js";

it.each(["initialize", "tools/call"])("cancels the real MCP transport during %s", async (stage) => {
  const controller = new AbortController();
  const methods: string[] = [];
  let observed: AbortSignal | null | undefined;
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (typeof init?.body !== "string") throw new Error("Expected JSON fixture request");
    const request = JSON.parse(init.body);
    methods.push(request.method);
    if (request.method === stage) {
      observed = init?.signal;
      controller.abort();
      throw new DOMException("cancelled", "AbortError");
    }
    if (request.method === "initialize")
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        },
      });
    return new Response(null, { status: 202 });
  });
  vi.stubGlobal("fetch", fetcher);
  try {
    const provider = new ExaMcpProvider(new HostedExaMcpCaller());
    await expect(
      provider.search({ query: "fixture", maxResults: 1 }, controller.signal),
    ).rejects.toThrow("Operation cancelled");
    expect(observed?.aborted).toBe(true);
    expect(methods.filter((method) => method === stage)).toHaveLength(1);
    if (stage === "initialize") expect(methods).not.toContain("tools/call");
  } finally {
    vi.unstubAllGlobals();
  }
});

it("cancels only the bound Run and leaves another browser session usable", async () => {
  const cancelled: string[] = [];
  const closed: string[] = [];
  let release!: () => void;
  let started!: () => void;
  const pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const bridge = new BrowserBridge({
    authorize: async () => true,
    resolveHost: async () => ["93.184.216.34"],
    executor: {
      open: async (binding) => ({
        execute: async (args) => {
          if (binding.runId === "a" && args[3] === "read") {
            started();
            await pause;
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({ success: true, data: "https://example.com/" }),
            stderr: "",
          };
        },
        cancel: async () => {
          cancelled.push(binding.runId);
          if (binding.runId === "a") release();
        },
        close: async () => {
          closed.push(binding.runId);
        },
      }),
    },
  });
  const base = {
    principalId: "owner",
    conversationId: "private",
    workspaceId: "work",
    policyVersion: "1",
  };
  const a = { ...base, runId: "a" },
    b = { ...base, runId: "b" };
  const controller = new AbortController();
  try {
    await bridge.execute(a, { type: "open", url: "https://example.com/" });
    await bridge.execute(b, { type: "open", url: "https://example.com/" });
    const result = bridge
      .execute(a, { type: "read" }, controller.signal)
      .catch((error: unknown) => error);
    await running;
    controller.abort();
    expect(await result).toEqual(new Error("Operation cancelled"));
    expect(cancelled.length).toBeGreaterThan(0);
    expect(cancelled.every((run) => run === "a")).toBe(true);
    expect(closed).toEqual(["a"]);
    expect((await bridge.execute(b, { type: "read" })).output).toBe("https://example.com/");
  } finally {
    release();
    await bridge.cleanup(a);
    await bridge.cleanup(b);
  }
});

it("cancels real Jev planning before a search provider can start", async () => {
  const controller = new AbortController();
  let observed: AbortSignal | null | undefined;
  const search = vi.fn(async () => ({ status: "ready" as const, results: [] }));
  const jev = new JevProvider({
    apiKey: "fixture",
    fetcher: async (_url, init) => {
      observed = init?.signal;
      controller.abort();
      throw new DOMException("cancelled", "AbortError");
    },
  });
  const service = new WebService({
    planner: new JevPlanner({ provider: jev }),
    provider: { search, contents: search },
  });
  await expect(
    service.search(
      "run",
      { query: "please compare task queues and durable worker orchestration in detail" },
      controller.signal,
    ),
  ).rejects.toThrow("Operation cancelled");
  expect(observed?.aborted).toBe(true);
  expect(search).not.toHaveBeenCalled();
});

it("retains provider timeouts as timeouts rather than caller cancellation", async () => {
  const provider = new ExaProvider({
    apiKey: "fixture",
    timeoutMs: 1,
    fetcher: async (_url, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("timeout", "AbortError")),
          { once: true },
        ),
      ),
  });
  expect(await provider.search({ query: "fixture", maxResults: 1 })).toEqual({
    status: "timeout",
    results: [],
  });
});

it("removes command listeners and does not cancel settled work on a later abort", async () => {
  const controller = new AbortController();
  const add = vi.spyOn(controller.signal, "addEventListener");
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const cancel = vi.fn(async () => {});
  expect(await cancellableBrowserCommand(controller.signal, async () => "done", cancel)).toBe(
    "done",
  );
  controller.abort();
  expect(cancel).not.toHaveBeenCalled();
  expect(add).toHaveBeenCalledOnce();
  expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
});

it("closes a late browser session acquired after cancellation without navigation", async () => {
  const controller = new AbortController();
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const execute = vi.fn(async (_args: readonly string[]) => ({
    exitCode: 0,
    stdout: JSON.stringify({ success: true }),
    stderr: "",
  }));
  const close = vi.fn(async () => {});
  const bridge = new BrowserBridge({
    authorize: async () => true,
    resolveHost: async () => ["93.184.216.34"],
    executor: {
      open: async () => {
        started();
        await held;
        return { execute, close, cancel: async () => {} };
      },
    },
  });
  const binding = {
    runId: "late",
    principalId: "owner",
    conversationId: "private",
    workspaceId: "work",
    policyVersion: "1",
  };
  const result = bridge
    .execute(binding, { type: "open", url: "https://example.com/" }, controller.signal)
    .catch((error: unknown) => error);
  await entered;
  controller.abort();
  release();
  expect(await result).toEqual(new Error("Operation cancelled"));
  expect(close).toHaveBeenCalledOnce();
  expect(execute.mock.calls.every(([args]) => args[3] === "close")).toBe(true);
});

it.each(["direct", "search", "fetch"])(
  "interrupts a bound %s browser command without waiting for its queue",
  async (mode) => {
    const controller = new AbortController();
    let release!: () => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancel = vi.fn(async () => {
      release();
    });
    const close = vi.fn(async () => {});
    const commands: string[] = [];
    const bridge = new BrowserBridge({
      authorize: async () => true,
      resolveHost: async () => ["93.184.216.34"],
      executor: {
        open: async () => ({
          cancel,
          close,
          execute: async (args) => {
            commands.push(args[3]!);
            if (args[3] === (mode === "search" ? "wait" : "read")) {
              started();
              await pause;
            }
            return {
              exitCode: 0,
              stdout: JSON.stringify({ success: true, data: "https://example.com/" }),
              stderr: "",
            };
          },
        }),
      },
    });
    const binding = {
      runId: "cancel-run",
      principalId: "owner",
      conversationId: "private",
      workspaceId: "work",
      policyVersion: "1",
    };
    const service = new WebService({
      planner: planner(),
      provider: {
        search: async () => ({ status: "failed", results: [] }),
        contents: async () => ({ status: "failed", results: [] }),
      },
      browserFallback: new GuardedBrowserFallback({
        bridge,
        binding: async () => binding,
        authorize: async () => true,
        resolveHost: async () => ["93.184.216.34"],
      }),
      resolveHost: async () => ["93.184.216.34"],
    });
    if (mode === "direct")
      await bridge.execute(binding, { type: "open", url: "https://example.com/" });
    const pending =
      mode === "direct"
        ? bridge.execute(binding, { type: "read" }, controller.signal)
        : mode === "search"
          ? service.search("cancel-run", { query: "fixture" }, controller.signal)
          : service.fetch("cancel-run", { url: "https://example.com/" }, controller.signal);
    const result = pending.catch((error: unknown) => error);
    try {
      await running;
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(cancel).toHaveBeenCalled();
      expect(await result).toEqual(new Error("Operation cancelled"));
      expect(close).toHaveBeenCalledOnce();
      expect(
        commands.filter((command) => command === (mode === "search" ? "wait" : "read")),
      ).toHaveLength(1);
    } finally {
      release();
      await result;
      await bridge.cleanup(binding);
    }
  },
);

const planner = () => ({
  plan: vi.fn(async (query: string) => ({
    mode: "fast" as const,
    queryVariants: [query],
    jevUsed: false,
  })),
  rerank: vi.fn(async () => []),
});

it.each(["plan", "rerank", "dns"])(
  "rejects cancellation across the %s await without publishing a result",
  async (stage) => {
    const controller = new AbortController();
    const search = vi.fn(async () => ({
      status: "ready" as const,
      results: [
        { url: "https://example.com/one", title: "one" },
        { url: "https://example.com/two", title: "two" },
      ],
    }));
    const rerank = vi.fn(async () => {
      if (stage === "rerank") controller.abort();
      return [];
    });
    const service = new WebService({
      planner: {
        plan: async (query) => {
          if (stage === "plan") controller.abort();
          return { mode: "complex", queryVariants: [query], jevUsed: false };
        },
        rerank,
      },
      provider: { search, contents: search },
      resolveHost: async () => {
        if (stage === "dns") controller.abort();
        return ["93.184.216.34"];
      },
    });
    await expect(service.search("run", { query: "test" }, controller.signal)).rejects.toThrow(
      "Operation cancelled",
    );
    if (stage === "plan") expect(search).not.toHaveBeenCalled();
    if (stage !== "rerank") expect(rerank).not.toHaveBeenCalled();
  },
);

it("cancels after response headers while reading a provider body", async () => {
  const controller = new AbortController();
  const provider = new ExaProvider({
    apiKey: "fixture",
    fetcher: async () =>
      ({
        status: 200,
        ok: true,
        text: async () => {
          controller.abort();
          return JSON.stringify({ results: [] });
        },
      }) as Response,
  });
  await expect(
    provider.search({ query: "test", maxResults: 1 }, controller.signal),
  ).rejects.toThrow("Operation cancelled");
});

it("does not resolve hosts or fetch for an already cancelled fetch", async () => {
  const resolveHost = vi.fn(async () => ["93.184.216.34"]);
  const contents = vi.fn(async () => ({ status: "ready" as const, results: [] }));
  const service = new WebService({ resolveHost, provider: { search: contents, contents } });
  await expect(
    service.fetch("run", { url: "https://example.com/" }, AbortSignal.abort()),
  ).rejects.toThrow("Operation cancelled");
  expect(resolveHost).not.toHaveBeenCalled();
  expect(contents).not.toHaveBeenCalled();
});

it("does not start planning or providers for an already cancelled search", async () => {
  const plan = planner();
  const search = vi.fn(async () => ({ status: "ready" as const, results: [] }));
  const service = new WebService({ planner: plan, provider: { search, contents: search } });
  await expect(service.search("run", { query: "test" }, AbortSignal.abort())).rejects.toThrow(
    "Operation cancelled",
  );
  expect(plan.plan).not.toHaveBeenCalled();
  expect(search).not.toHaveBeenCalled();
});

it("passes cancellation to providers and never starts a browser fallback after cancellation", async () => {
  const controller = new AbortController();
  const fallback = vi.fn(async () => ({ status: "succeeded" as const, results: [] }));
  const seen: Array<AbortSignal | undefined> = [];
  const search = vi.fn(async (_input: unknown, signal?: AbortSignal) => {
    seen.push(signal);
    controller.abort();
    return { status: "failed" as const, results: [] as const };
  });
  const service = new WebService({
    planner: planner(),
    provider: { search, contents: async () => ({ status: "failed", results: [] }) },
    browserFallback: { search: fallback, fetch: async () => ({ status: "failed" }) },
  });
  await expect(service.search("run", { query: "test" }, controller.signal)).rejects.toThrow(
    "Operation cancelled",
  );
  expect(seen).toEqual([controller.signal]);
  expect(fallback).not.toHaveBeenCalled();
});

it("aborts an active REST request without classifying caller cancellation as provider timeout", async () => {
  const controller = new AbortController();
  let transportSignal: AbortSignal | undefined;
  const provider = new ExaProvider({
    apiKey: "fixture",
    fetcher: async (_url, init) => {
      transportSignal = init?.signal ?? undefined;
      controller.abort();
      throw new DOMException("cancelled", "AbortError");
    },
  });
  await expect(
    provider.search({ query: "test", maxResults: 1 }, controller.signal),
  ).rejects.toThrow("Operation cancelled");
  expect(transportSignal?.aborted).toBe(true);
});

it("passes the caller signal through hosted MCP provider abstraction", async () => {
  const controller = new AbortController();
  const seen: Array<AbortSignal | undefined> = [];
  const provider = new ExaMcpProvider({
    call: async (_name, _args, signal?: AbortSignal) => {
      seen.push(signal);
      controller.abort();
      return { content: [] };
    },
  });
  await expect(
    provider.search({ query: "test", maxResults: 1 }, controller.signal),
  ).rejects.toThrow("Operation cancelled");
  expect(seen).toEqual([controller.signal]);
});
