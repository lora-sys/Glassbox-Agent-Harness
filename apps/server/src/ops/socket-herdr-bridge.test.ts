import net from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vite-plus/test";
import { SocketHerdrBridge } from "./socket-herdr-bridge.js";
import type { HerdrEvent } from "./herdr-bridge.js";

it("rejects a replaced worker before reading output or sending input", async () => {
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\glassbox-test-${randomUUID()}`
      : join(tmpdir(), `herdr-${randomUUID()}.sock`);
  const sockets = new Set<net.Socket>();
  const methods: string[] = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      methods.push(request.method);
      const result =
        request.method === "session.snapshot"
          ? {
              workspaces: [{ workspace_id: "w" }],
              panes: [{ workspace_id: "w", pane_id: "p" }],
              agents: [{ pane_id: "p", name: "replacement" }],
            }
          : {
              agent: {
                name: "replacement",
                pane_id: "p",
                interactive_ready: true,
                agent_status: "idle",
              },
            };
      socket.write(
        JSON.stringify({
          id: request.id,
          result,
        }) + "\n",
      );
    });
  });
  server.listen(endpoint);
  await once(server, "listening");
  const bridge = new SocketHerdrBridge({ socketPath: endpoint, sessionId: "s" });
  try {
    await bridge.connect();
    methods.length = 0;
    const target = { paneId: "p", agentName: "bound-worker" };
    await expect(bridge.readAgent(target)).rejects.toThrow("identity mismatch");
    await expect(bridge.promptAgent({ ...target, prompt: "PRIVATE_INSTRUCTION" })).rejects.toThrow(
      "identity mismatch",
    );
    await expect(bridge.stopAgent(target)).rejects.toThrow("identity mismatch");
    await expect(bridge.closeAgent({ ...target, herdrSession: "s" })).rejects.toThrow(
      "identity mismatch",
    );
    expect(methods).toEqual([
      "agent.get",
      "agent.get",
      "agent.get",
      "session.snapshot",
      "session.snapshot",
    ]);
  } finally {
    await bridge.disconnect();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("subscribes to new Worker panes before launch and waits for readiness before prompting", async () => {
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\glassbox-test-${randomUUID()}`
      : join(tmpdir(), `herdr-${randomUUID()}.sock`);
  const sockets = new Set<net.Socket>();
  const methods: string[] = [];
  let child: net.Socket | undefined;
  let name = "";
  let readinessChecks = 0;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      methods.push(request.method);
      let result: unknown = {};
      if (request.method === "session.snapshot")
        result = { workspaces: [{ workspace_id: "w" }], panes: [] };
      if (request.method === "tab.create") result = { root_pane: { pane_id: "new-pane" } };
      if (request.method === "events.subscribe" && request.params.subscriptions.length === 1)
        child = socket;
      if (request.method === "agent.start") {
        expect(child).toBeDefined();
        expect(request.params.kind).toBe("pi");
        name = request.params.name;
        result = { agent: { pane_id: "new-pane", name, launch_pending: true } };
      }
      if (request.method === "agent.get")
        result = {
          agent: {
            pane_id: "new-pane",
            name,
            agent_status: "idle",
            interactive_ready: ++readinessChecks > 1,
          },
        };
      if (request.method === "agent.prompt") {
        expect(readinessChecks).toBe(2);
        expect(request.params.target).toBe(name);
      }
      socket.write(JSON.stringify({ id: request.id, result }) + "\n");
    });
  });
  server.listen(endpoint);
  await once(server, "listening");
  const bridge = new SocketHerdrBridge({
    socketPath: endpoint,
    sessionId: "s",
    requestTimeoutMs: 1000,
    workerLaunch: async () => ({
      kind: "pi",
      args: [],
      env: {},
      runtimeEvidence: { profileName: "herdr-worker", model: "fixture" },
    }),
  });
  let receive!: (event: HerdrEvent) => void;
  const received = new Promise<HerdrEvent>((resolve) => {
    receive = resolve;
  });
  try {
    const subscription = await bridge.subscribe(receive);
    await expect(bridge.startAgent({ workspaceId: "w", agentKind: "pi" })).rejects.toThrow(
      "attempt context",
    );
    const worker = await bridge.startAgent({
      workspaceId: "w",
      agentKind: "pi",
      agentName: "glassbox-pi-attempt-123",
      workerContextFile: join(tmpdir(), "context.json"),
    });
    expect(name).toBe("glassbox-pi-attempt-123");
    expect(worker.runtimeEvidence).toEqual({ profileName: "herdr-worker", model: "fixture" });
    const requestsBeforeInvalidName = methods.length;
    await expect(
      bridge.startAgent({
        workspaceId: "w",
        agentKind: "pi",
        agentName: "bad name",
        workerContextFile: join(tmpdir(), "context.json"),
      }),
    ).rejects.toThrow("Invalid Herdr agent name");
    expect(methods).toHaveLength(requestsBeforeInvalidName);
    await expect(
      bridge.startAgent({
        workspaceId: "w",
        agentKind: "pi",
        agentName: "x".repeat(129),
        workerContextFile: join(tmpdir(), "context.json"),
      }),
    ).rejects.toThrow("Invalid Herdr agent name");
    expect(methods).toHaveLength(requestsBeforeInvalidName);
    await bridge.promptAgent({ paneId: worker.paneId, prompt: "Bounded work" });
    child!.write(
      JSON.stringify({
        event: "pane.agent_status_changed",
        data: { pane_id: "new-pane", workspace_id: "w", agent_status: "done" },
      }) + "\n",
    );
    expect(await received).toMatchObject({ paneId: "new-pane", state: "done" });
    const closed = once(child!, "close");
    bridge.unsubscribe(subscription.subscriptionId);
    await closed;
    expect(methods.filter((method) => method === "events.subscribe")).toHaveLength(2);
    expect(methods.filter((method) => method === "agent.prompt")).toHaveLength(1);
  } finally {
    await bridge.disconnect();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("closes a verified pane and requires the snapshot to confirm its removal", async () => {
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\glassbox-test-${randomUUID()}`
      : join(tmpdir(), `herdr-${randomUUID()}.sock`);
  const sockets = new Set<net.Socket>();
  const methods: string[] = [];
  let panePresent = true;
  let paneCloseParams: unknown;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      methods.push(request.method);
      let result: unknown = {};
      if (request.method === "agent.get")
        result = { agent: { name: "glassbox-pi-attempt-123", pane_id: "p" } };
      if (request.method === "pane.close") {
        paneCloseParams = request.params;
        panePresent = false;
      }
      if (request.method === "session.snapshot")
        result = {
          workspaces: [{ workspace_id: "w" }],
          panes: panePresent ? [{ workspace_id: "w", pane_id: "p" }] : [],
          agents: panePresent ? [{ pane_id: "p", name: "glassbox-pi-attempt-123" }] : [],
        };
      socket.write(JSON.stringify({ id: request.id, result }) + "\n");
    });
  });
  server.listen(endpoint);
  await once(server, "listening");
  const bridge = new SocketHerdrBridge({ socketPath: endpoint, sessionId: "s" });
  try {
    await bridge.connect();
    methods.length = 0;
    await expect(
      bridge.closeAgent({
        paneId: "p",
        agentName: "glassbox-pi-attempt-123",
        herdrSession: "s",
      }),
    ).resolves.toBeUndefined();
    expect(methods).toEqual(["session.snapshot", "agent.get", "pane.close", "session.snapshot"]);
    expect(paneCloseParams).toEqual({ pane_id: "p" });
  } finally {
    await bridge.disconnect();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("accepts an already-absent pane only with a connected matching session snapshot", async () => {
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\glassbox-test-${randomUUID()}`
      : join(tmpdir(), `herdr-${randomUUID()}.sock`);
  const sockets = new Set<net.Socket>();
  const methods: string[] = [];
  let malformedSnapshot = false;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      methods.push(request.method);
      const result =
        request.method === "session.snapshot"
          ? malformedSnapshot
            ? {}
            : { workspaces: [{ workspace_id: "w" }], panes: [], agents: [] }
          : {};
      socket.write(JSON.stringify({ id: request.id, result }) + "\n");
    });
  });
  server.listen(endpoint);
  await once(server, "listening");
  const bridge = new SocketHerdrBridge({ socketPath: endpoint, sessionId: "s" });
  try {
    await bridge.connect();
    methods.length = 0;
    await expect(
      bridge.closeAgent({
        paneId: "already-gone",
        agentName: "glassbox-pi-attempt-123",
        herdrSession: "s",
      }),
    ).resolves.toBeUndefined();
    expect(methods).toEqual(["session.snapshot"]);
    await expect(
      bridge.closeAgent({
        paneId: "already-gone",
        agentName: "glassbox-pi-attempt-123",
        herdrSession: "other-session",
      }),
    ).rejects.toThrow("session identity mismatch");
    expect(methods).toEqual(["session.snapshot"]);
    malformedSnapshot = true;
    await expect(
      bridge.closeAgent({
        paneId: "unknown",
        agentName: "glassbox-pi-attempt-123",
        herdrSession: "s",
      }),
    ).rejects.toThrow("Invalid Herdr session snapshot");
    expect(methods).toEqual(["session.snapshot", "session.snapshot"]);
    malformedSnapshot = false;
    await bridge.disconnect();
    await expect(
      bridge.closeAgent({
        paneId: "already-gone",
        agentName: "glassbox-pi-attempt-123",
        herdrSession: "s",
      }),
    ).rejects.toThrow("disconnected");
    expect(methods).toEqual(["session.snapshot", "session.snapshot"]);
  } finally {
    await bridge.disconnect();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each(["close-error", "pane-remains", "closed-during-error"])(
  "does not confirm a Worker stop when pane close fails or the snapshot still contains it (%s)",
  async (failure) => {
    const endpoint =
      process.platform === "win32"
        ? `\\\\.\\pipe\\glassbox-test-${randomUUID()}`
        : join(tmpdir(), `herdr-${randomUUID()}.sock`);
    const sockets = new Set<net.Socket>();
    const methods: string[] = [];
    let panePresent = true;
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        if (!buffer.includes("\n")) return;
        const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        methods.push(request.method);
        if (
          request.method === "pane.close" &&
          ["close-error", "closed-during-error"].includes(failure)
        ) {
          if (failure === "closed-during-error") panePresent = false;
          socket.write(
            JSON.stringify({ id: request.id, error: { code: "close_failed", message: "failed" } }) +
              "\n",
          );
          return;
        }
        const result =
          request.method === "agent.get"
            ? { agent: { name: "glassbox-pi-attempt-123", pane_id: "p" } }
            : request.method === "session.snapshot"
              ? {
                  workspaces: [{ workspace_id: "w" }],
                  panes: panePresent ? [{ workspace_id: "w", pane_id: "p" }] : [],
                  agents: panePresent ? [{ pane_id: "p", name: "glassbox-pi-attempt-123" }] : [],
                }
              : {};
        socket.write(JSON.stringify({ id: request.id, result }) + "\n");
      });
    });
    server.listen(endpoint);
    await once(server, "listening");
    const bridge = new SocketHerdrBridge({ socketPath: endpoint, sessionId: "s" });
    try {
      await bridge.connect();
      methods.length = 0;
      const close = bridge.closeAgent({
        paneId: "p",
        agentName: "glassbox-pi-attempt-123",
        herdrSession: "s",
      });
      if (failure === "closed-during-error") await expect(close).resolves.toBeUndefined();
      else
        await expect(close).rejects.toThrow(
          failure === "close-error" ? "close_failed" : "not confirmed",
        );
      expect(methods).toEqual(["session.snapshot", "agent.get", "pane.close", "session.snapshot"]);
    } finally {
      await bridge.disconnect();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it("reads protocol 22 nested output and observes worker state without losing text", async () => {
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\glassbox-test-${randomUUID()}`
      : join(tmpdir(), `herdr-${randomUUID()}.sock`);
  const sockets = new Set<net.Socket>();
  let wrongPane = false;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      if (request.method === "agent.read") expect(request.params.source).toBe("recent_unwrapped");
      const result =
        request.method === "agent.read"
          ? {
              type: "pane_read",
              read: {
                pane_id: wrongPane ? "other" : "p",
                text: "tests passed\nresult ready",
                truncated: false,
              },
            }
          : request.method === "agent.get"
            ? { type: "agent_info", agent: { pane_id: "p", agent_status: "done" } }
            : {
                type: "wait_matched",
                event: {
                  event: "pane_agent_status_changed",
                  data: {
                    type: "pane_agent_status_changed",
                    workspace_id: "w",
                    pane_id: "p",
                    agent_status: "blocked",
                  },
                },
              };
      socket.write(JSON.stringify({ id: request.id, result }) + "\n");
    });
  });
  server.listen(endpoint);
  await once(server, "listening");
  const bridge = new SocketHerdrBridge({
    socketPath: endpoint,
    sessionId: "s",
    requestTimeoutMs: 1000,
  });
  try {
    await expect(bridge.readAgent({ paneId: "p" })).resolves.toEqual({
      output: "tests passed\nresult ready",
      state: "done",
    });
    await expect(bridge.waitAgent({ paneId: "p" })).resolves.toEqual({ state: "blocked" });
    wrongPane = true;
    await expect(bridge.readAgent({ paneId: "p" })).rejects.toThrow(
      "Invalid Herdr agent.read result",
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each(["wrong-id", "early-close", "missing-result"])(
  "rejects a %s RPC response",
  async (failure) => {
    const endpoint =
      process.platform === "win32"
        ? `\\\\.\\pipe\\glassbox-test-${randomUUID()}`
        : join(tmpdir(), `herdr-${randomUUID()}.sock`);
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        if (!buffer.includes("\n")) return;
        const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        if (failure === "early-close") socket.end();
        else
          socket.write(
            JSON.stringify(
              failure === "wrong-id" ? { id: "other", result: {} } : { id: request.id },
            ) + "\n",
          );
      });
    });
    server.listen(endpoint);
    await once(server, "listening");
    const bridge = new SocketHerdrBridge({
      socketPath: endpoint,
      sessionId: "s",
      requestTimeoutMs: 1000,
    });
    try {
      await expect(bridge.connect()).rejects.toThrow(
        failure === "wrong-id"
          ? "id mismatch"
          : failure === "early-close"
            ? "closed before response"
            : "Invalid Herdr response",
      );
      expect(bridge.isConnected()).toBe(false);
    } finally {
      await bridge.disconnect();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it("subscribes with protocol 22 pane selectors, maps events and closes malformed streams once", async () => {
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\glassbox-test-${randomUUID()}`
      : join(tmpdir(), `herdr-${randomUUID()}.sock`);
  const sockets = new Set<net.Socket>();
  let subscriber: net.Socket | undefined;
  const requests: Array<{ id: string; method: string; params: { subscriptions: unknown[] } }> = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      requests.push(request);
      const result =
        request.method === "session.snapshot"
          ? {
              workspaces: [{ workspace_id: "w" }],
              panes: [
                {
                  workspace_id: "w",
                  pane_id: "p",
                  agent: "pi",
                  agent_status: "working",
                  cwd: "C:/worktree",
                },
              ],
              agents: [{ pane_id: "p", name: "glassbox-pi-instance" }],
            }
          : {};
      socket.write(JSON.stringify({ id: request.id, result }) + "\n");
      if (request.method === "events.subscribe") subscriber = socket;
    });
  });
  server.listen(endpoint);
  await once(server, "listening");
  const bridge = new SocketHerdrBridge({
    socketPath: endpoint,
    sessionId: "s",
    requestTimeoutMs: 1000,
  });
  const events: HerdrEvent[] = [];
  let notify!: () => void;
  let arrived = new Promise<void>((resolve) => {
    notify = resolve;
  });
  try {
    expect((await bridge.getSnapshot()).workspaces[0]?.panes[0]).toMatchObject({
      agentName: "glassbox-pi-instance",
      agentKind: "pi",
      state: "working",
      cwd: "C:/worktree",
    });
    await bridge.subscribe((event) => {
      events.push(event);
      notify();
    });
    expect(requests.at(-1)?.params.subscriptions).toContainEqual({
      type: "pane.agent_status_changed",
      pane_id: "p",
    });
    subscriber!.write(
      JSON.stringify({
        event: "pane.agent_status_changed",
        data: {
          workspace_id: "w",
          pane_id: "p",
          agent_status: "done",
        },
      }) + "\n",
    );
    await arrived;
    expect(events[0]).toMatchObject({
      type: "agent.state",
      sessionId: "s",
      workspaceId: "w",
      paneId: "p",
      state: "done",
    });
    arrived = new Promise<void>((resolve) => {
      notify = resolve;
    });
    subscriber!.write("{malformed\n");
    await arrived;
    expect(events.filter((event) => event.type === "session.disconnected")).toHaveLength(1);
    expect(bridge.isConnected()).toBe(false);
    const cleanEvents: HerdrEvent[] = [];
    const subscription = await bridge.subscribe((event) => cleanEvents.push(event));
    const closed = once(subscriber!, "close");
    bridge.unsubscribe(subscription.subscriptionId);
    await closed;
    expect(cleanEvents).toEqual([]);
    expect(bridge.isConnected()).toBe(true);
  } finally {
    await bridge.disconnect();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
