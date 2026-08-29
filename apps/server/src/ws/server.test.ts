// apps/server/src/ws/server.test.ts
// Tests for the WebSocket server module.
//
// 1. Functional: broadcastEvent / broadcastDerivedState deliver messages
//    to subscribers by sessionId (verified via direct ws attach).
// 2. Unit: itemFileChange populates artifacts, preserves currentWork, and
//    increments traceSummary in the reducer.
// 3. WS protocol: invalid action returns an error.
// 4. Session isolation: broadcasts to one sessionId do not leak to another.

import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  attachWebSocketServer,
  broadcastEvent,
  broadcastDerivedState,
  broadcastSessionEnded,
} from "./server.js";
import { initialDerivedState } from "../state/types.js";
import { reduce } from "../state/reducer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spin up a fresh HTTP server with the Glassbox WS handler attached.
 */
async function spawnWSServer() {
  const httpServer = http.createServer();
  const wss = attachWebSocketServer(httpServer, async () => {});
  const port = await new Promise<number>((resolve) => {
    httpServer.listen(0, () => {
      resolve((httpServer.address() as { port: number }).port);
    });
  });
  const ctx = { httpServer, wss, port };
  return ctx;
}

async function cleanupServer(ctx: { httpServer: http.Server; wss: WebSocketServer }) {
  ctx.wss.close();
  await new Promise<void>((r) => ctx.httpServer.close(() => r()));
}

/**
 * Connect a WebSocket client with the message handler registered BEFORE
 * the TCP handshake completes (so the server's synchronous `send("subscribed")`
 * is not silently dropped).
 */
async function connectWS(port: number, sessionId: string): Promise<WebSocket> {
  const msgs: unknown[] = [];
  const ws = new WebSocket(`ws://localhost:${port}/ws?sessionId=${sessionId}`);
  ws.on("message", (raw) => msgs.push(JSON.parse(raw.toString())));

  const ack = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 2000);
    const interval = setInterval(() => {
      if (msgs.some((m) => (m as { type: string }).type === "subscribed")) {
        clearInterval(interval);
        clearTimeout(timer);
        resolve(true);
      }
    }, 50);
    // Also check messages that may already have arrived
    if (msgs.some((m) => (m as { type: string }).type === "subscribed")) {
      clearInterval(interval);
      clearTimeout(timer);
      resolve(true);
    }
  });

  (ws as unknown as { _msgs: unknown[] })._msgs = msgs;
  (ws as unknown as { _ack: boolean })._ack = ack;
  return ws;
}

// ---------------------------------------------------------------------------
// Functional broadcast tests
// ---------------------------------------------------------------------------

describe("ws: functional broadcast", () => {
  it("delivers event, derivedState, and sessionEnded", async () => {
    const { httpServer, wss, port } = await spawnWSServer();
    try {
      const sessionId = "s-" + Math.random().toString(36).slice(2, 8);
      const ws = await connectWS(port, sessionId);
      const msgs = (ws as unknown as { _msgs: unknown[] })._msgs;
      const ack = (ws as unknown as { _ack: boolean })._ack;

      expect(ack).toBe(true);

      // Broadcast three message types
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

      await new Promise<void>((resolve) => setTimeout(resolve, 80));

      const types = msgs.map((m) => (m as { type: string }).type);
      expect(types).toContain("subscribed");
      expect(types).toContain("event");
      expect(types).toContain("derivedState");
      expect(types).toContain("sessionEnded");

      const ev = msgs.find(
        (m) => (m as { type: string }).type === "event"
      ) as { event: { method: string } } | undefined;
      expect(ev?.event.method).toBe("item/agentMessage/delta");

      const ds = msgs.find(
        (m) => (m as { type: string }).type === "derivedState"
      ) as { derivedState: { task: string; traceSummary: { totalEvents: number } } } | undefined;
      expect(ds?.derivedState.task).toBe("say hi");
      expect(ds?.derivedState.traceSummary.totalEvents).toBe(5);

      ws.close();
    } finally {
      await cleanupServer({ httpServer, wss });
    }
  }, 8000);

  it("returns error for unknown action", async () => {
    const { httpServer, wss, port } = await spawnWSServer();
    try {
      const ws = await connectWS(port, "s-err");
      const msgs = (ws as unknown as { _msgs: unknown[] })._msgs;
      const errors: unknown[] = [];

      setTimeout(() => {
        // Collect errors that arrive after subscription
        // We already registered the ws.on("message") handler in connectWS
      }, 100);

      // Add error listener to existing messages
      const origHandler = ws.listeners("message")[0];
      ws.off("message", origHandler);
      ws.on("message", (raw) => {
        origHandler(raw);
        const msg = JSON.parse(raw.toString());
        if (msg.type === "error") errors.push(msg);
      });

      ws.send(JSON.stringify({ action: "notReal" }));
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect((errors[0] as { message: string }).message).toContain("notReal");

      ws.close();
    } finally {
      await cleanupServer({ httpServer, wss });
    }
  }, 4000);

  it("does not broadcast to a different session", async () => {
    const { httpServer, wss, port } = await spawnWSServer();
    try {
      const sessionId = "s-other-" + Math.random().toString(36).slice(2, 8);
      const ws = await connectWS(port, sessionId);
      const msgs = (ws as unknown as { _msgs: unknown[] })._msgs;

      // Clear the subscribed message from msgs to focus on extra broadcasts
      const filtered = msgs.filter(
        (m) => (m as { type: string }).type !== "subscribed"
      );

      // Broadcast to a DIFFERENT session
      broadcastEvent("other-session", { method: "turn/completed" });
      broadcastDerivedState("other-session", { traceSummary: {} });

      await new Promise<void>((resolve) => setTimeout(resolve, 80));

      const extra = msgs.filter(
        (m) => (m as { type: string }).type !== "subscribed"
      );
      expect(extra.length).toBe(0);

      ws.close();
    } finally {
      await cleanupServer({ httpServer, wss });
    }
  });
});

// ---------------------------------------------------------------------------
// Reducer unit tests: itemFileChange
// ---------------------------------------------------------------------------

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
    expect(state.artifacts[0].changes[0].path).toBe("a.ts");
    expect(state.artifacts[1].changes[0].path).toBe("b.ts");
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

// ---------------------------------------------------------------------------
// WS subscription + broadcast round-trip (no adapter needed)
// ---------------------------------------------------------------------------

describe("ws: subscription + broadcast round-trip", () => {
  it("receives subscribed ack then live event + derived-state via broadcast", async () => {
    const { httpServer, wss, port } = await spawnWSServer();
    try {
      const sessionId = "rt-" + Math.random().toString(36).slice(2, 8);
      const ws = await connectWS(port, sessionId);
      const msgs = (ws as unknown as { _msgs: unknown[] })._msgs;
      const ack = (ws as unknown as { _ack: boolean })._ack;

      expect(ack).toBe(true);

      // Simulate what /run-test does: broadcast each decoded event
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

      await new Promise<void>((resolve) => setTimeout(resolve, 80));

      const types = msgs.map((m) => (m as { type: string }).type);
      expect(types).toContain("subscribed");
      expect(types).toContain("event");
      expect(types).toContain("derivedState");
      expect(types).toContain("sessionEnded");

      // At least one event should be an agentMessage/delta
      const deltaMsgs = msgs.filter(
        (m) =>
          (m as { type: string }).type === "event" &&
          (m as { event: { method: string } }).event?.method === "item/agentMessage/delta"
      );
      expect(deltaMsgs.length).toBeGreaterThanOrEqual(1);

      ws.close();
    } finally {
      await cleanupServer({ httpServer, wss });
    }
  }, 8000);
});
