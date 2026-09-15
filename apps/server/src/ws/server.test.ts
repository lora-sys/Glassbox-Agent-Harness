import http from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { describe, expect, it } from "vite-plus/test";
import {
  attachWebSocketServer,
  broadcastEvent,
  broadcastDerivedState,
  broadcastSessionEnded,
} from "./server.js";
import { initialDerivedState } from "../state/types.js";
import { reduce } from "../state/reducer.js";

async function spawnWSServer() {
  const httpServer = http.createServer();
  const wss = attachWebSocketServer(httpServer, () => {});
  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected a TCP listener"));
      } else {
        resolve(address.port);
      }
    });
  });
  return { httpServer, wss, port };
}

async function cleanupServer(ctx: { httpServer: http.Server; wss: WebSocketServer }) {
  for (const client of ctx.wss.clients) client.terminate();
  await new Promise<void>((resolve, reject) =>
    ctx.wss.close((error) => (error ? reject(error) : resolve())),
  );
  await new Promise<void>((resolve, reject) =>
    ctx.httpServer.close((error) => (error ? reject(error) : resolve())),
  );
}

function parseMessage(raw: RawData): Record<string, unknown> {
  const buffer = Array.isArray(raw)
    ? Buffer.concat(raw)
    : Buffer.isBuffer(raw)
      ? raw
      : Buffer.from(raw);
  const value: unknown = JSON.parse(buffer.toString("utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("type" in value) ||
    typeof value.type !== "string"
  ) {
    throw new Error("Invalid server push payload");
  }
  return value;
}

async function connectWS(port: number, sessionId: string) {
  const messages: Record<string, unknown>[] = [];
  const listeners = new Set<() => void>();
  let failure: Error | undefined;
  const ws = new WebSocket(
    "ws://127.0.0.1:" + port + "/ws?sessionId=" + encodeURIComponent(sessionId),
  );
  ws.on("message", (raw) => {
    try {
      messages.push(parseMessage(raw));
    } catch (error) {
      failure = error instanceof Error ? error : new Error("Invalid server message");
    }
    for (const notify of listeners) notify();
  });
  ws.on("error", (error) => {
    failure = error;
    for (const notify of listeners) notify();
  });

  function waitFor(predicate: (message: Record<string, unknown>) => boolean) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      function check() {
        const message = messages.find(predicate);
        if (!failure && !message) return;
        clearTimeout(timer);
        listeners.delete(check);
        if (failure) reject(failure);
        else if (message) resolve(message);
      }
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error("Timed out waiting for a server push"));
      }, 2000);
      listeners.add(check);
      check();
    });
  }

  await waitFor((message) => message.type === "subscribed");
  return { ws, messages, waitFor };
}

describe("ws: functional broadcast", () => {
  it("delivers event, derivedState, and sessionEnded in order", async () => {
    const ctx = await spawnWSServer();
    try {
      const sessionId = "broadcast-fixture";
      const client = await connectWS(ctx.port, sessionId);
      const ended = client.waitFor((message) => message.type === "sessionEnded");
      broadcastEvent(sessionId, {
        method: "item/agentMessage/delta",
        params: { itemId: "m-1", delta: "hello world" },
      });
      broadcastDerivedState(sessionId, {
        task: "say hi",
        finalResult: { status: "completed" },
        traceSummary: { totalEvents: 5 },
      });
      broadcastSessionEnded(sessionId);
      await ended;
      expect(client.messages).toMatchObject([
        { type: "subscribed", sessionId },
        { type: "event", event: { method: "item/agentMessage/delta" } },
        {
          type: "derivedState",
          derivedState: { task: "say hi", traceSummary: { totalEvents: 5 } },
        },
        { type: "sessionEnded", sessionId },
      ]);
    } finally {
      await cleanupServer(ctx);
    }
  });

  it("returns error for unknown action", async () => {
    const ctx = await spawnWSServer();
    try {
      const client = await connectWS(ctx.port, "error-fixture");
      const error = client.waitFor((message) => message.type === "error");
      client.ws.send(JSON.stringify({ action: "notReal" }));
      expect(await error).toMatchObject({
        type: "error",
        message: "invalid json message",
      });
    } finally {
      await cleanupServer(ctx);
    }
  });

  it("does not broadcast to a different session", async () => {
    const ctx = await spawnWSServer();
    try {
      const client = await connectWS(ctx.port, "isolated-fixture");
      broadcastEvent("other-session", { method: "turn/completed" });
      broadcastDerivedState("other-session", { traceSummary: {} });
      // A reply on the same socket is a delivery barrier, avoiding arbitrary sleeps.
      const barrier = client.waitFor((message) => message.type === "error");
      client.ws.send(JSON.stringify({ action: "barrier" }));
      await barrier;
      expect(
        client.messages.filter(
          (message) => message.type !== "subscribed" && message.type !== "error",
        ),
      ).toEqual([]);
    } finally {
      await cleanupServer(ctx);
    }
  });
});

describe("reduce: itemFileChange populates artifacts", () => {
  it("appends one artifact with typed change fields", () => {
    let state = reduce(initialDerivedState(), {
      _tag: "turnStarted" as const,
      threadId: "th-1",
      turn: { id: "turn-1", status: "inProgress" },
      input: [{ type: "text", text: "edit a file" }],
    });
    state = reduce(state, {
      _tag: "itemStarted" as const,
      item: { type: "fileChange", id: "fc-1", text: "editing" },
      threadId: "th-1",
      turnId: "turn-1",
      startedAtMs: 100,
    });
    state = reduce(state, {
      _tag: "itemFileChange" as const,
      threadId: "th-1",
      turnId: "turn-1",
      itemId: "fc-1",
      changes: [
        { path: "src/foo.ts", kind: "modify", diff: "+x = 1\n" },
        { path: "src/bar.ts", kind: "add" },
      ],
    });

    expect(state.artifacts).toHaveLength(1);
    expect(state.artifacts[0].itemId).toBe("fc-1");
    expect(state.artifacts[0].changes).toHaveLength(2);
    expect(state.artifacts[0].changes[0]).toEqual({
      path: "src/foo.ts",
      kind: "modify",
      diff: "+x = 1\n",
    });
    expect(state.artifacts[0].changes[1]).toEqual({
      path: "src/bar.ts",
      kind: "add",
      diff: null,
    });
  });

  it("accumulates multiple fileChange events into artifacts", () => {
    let state = initialDerivedState();
    state = reduce(state, {
      _tag: "turnStarted" as const,
      threadId: "th-1",
      turn: { id: "turn-1", status: "inProgress" },
      input: [{ type: "text", text: "refactor" }],
    });
    state = reduce(state, {
      _tag: "itemStarted" as const,
      item: { type: "fileChange", id: "fc-1" },
      threadId: "th-1",
      turnId: "turn-1",
      startedAtMs: 100,
    });
    state = reduce(state, {
      _tag: "itemFileChange" as const,
      threadId: "th-1",
      turnId: "turn-1",
      itemId: "fc-1",
      changes: [{ path: "a.ts", kind: "add" }],
    });
    state = reduce(state, {
      _tag: "itemFileChange" as const,
      threadId: "th-1",
      turnId: "turn-1",
      itemId: "fc-1",
      changes: [{ path: "b.ts", kind: "modify" }],
    });
    expect(state.artifacts).toHaveLength(2);
    expect(state.artifacts[0].changes[0]).toMatchObject({ path: "a.ts" });
    expect(state.artifacts[1].changes[0]).toMatchObject({ path: "b.ts" });
  });

  it("counts item/fileChange in traceSummary", () => {
    const state = reduce(initialDerivedState(), {
      _tag: "itemFileChange" as const,
      threadId: "th-1",
      turnId: "turn-1",
      itemId: "fc-1",
      changes: [],
    });
    expect(state.traceSummary.totalEvents).toBe(1);
    expect(state.traceSummary.eventCounts["item/fileChange"]).toBe(1);
  });

  it("preserves currentWork through fileChange events", () => {
    let state = initialDerivedState();
    state = reduce(state, {
      _tag: "turnStarted" as const,
      threadId: "th-1",
      turn: { id: "turn-1", status: "inProgress" },
      input: [{ type: "text", text: "edit files" }],
    });
    state = reduce(state, {
      _tag: "itemStarted" as const,
      item: { type: "fileChange", id: "fc-1", text: "editing src/main.ts" },
      threadId: "th-1",
      turnId: "turn-1",
      startedAtMs: 100,
    });
    state = reduce(state, {
      _tag: "itemFileChange" as const,
      threadId: "th-1",
      turnId: "turn-1",
      itemId: "fc-1",
      changes: [{ path: "src/main.ts", kind: "modify" }],
    });

    expect(state.currentWork?.itemId).toBe("fc-1");
    expect(state.currentWork?.text).toBe("editing src/main.ts");
    expect(state.artifacts).toHaveLength(1);
    expect(state.artifacts[0].itemId).toBe("fc-1");
  });
});

describe("ws: subscription + broadcast round-trip", () => {
  it("receives subscribed ack then live events and derived state", async () => {
    const ctx = await spawnWSServer();
    try {
      const sessionId = "round-trip-fixture";
      const client = await connectWS(ctx.port, sessionId);
      const ended = client.waitFor((message) => message.type === "sessionEnded");
      broadcastEvent(sessionId, {
        method: "item/agentMessage/delta",
        params: { delta: "hello!", itemId: "msg-1" },
      });
      broadcastEvent(sessionId, {
        method: "turn/completed",
        params: { status: "completed", durationMs: 4200 },
      });
      broadcastDerivedState(sessionId, {
        task: "say hello!",
        finalResult: { status: "completed" },
        traceSummary: { totalEvents: 7 },
      });
      broadcastSessionEnded(sessionId);
      await ended;
      expect(client.messages).toMatchObject([
        { type: "subscribed", sessionId },
        {
          type: "event",
          event: { method: "item/agentMessage/delta", params: { delta: "hello!" } },
        },
        { type: "event", event: { method: "turn/completed" } },
        {
          type: "derivedState",
          derivedState: { task: "say hello!", traceSummary: { totalEvents: 7 } },
        },
        { type: "sessionEnded", sessionId },
      ]);
    } finally {
      await cleanupServer(ctx);
    }
  });
});
