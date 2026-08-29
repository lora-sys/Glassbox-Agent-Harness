// apps/server — Glassbox runtime HTTP shell with Codex adapter endpoints.
import http from "node:http";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { CodexAdapter } from "./codex/adapter.js";

import { contractsVersion } from "@glassbox/contracts";
import { sharedVersion } from "@glassbox/shared";

import { RawTraceStore } from "./trace/store.js";
import { loadTrace } from "./trace/load.js";
import type { TraceEntry } from "./trace/store.js";
import { replayTrace } from "./state/replay.js";
import {
  attachWebSocketServer,
  broadcastEvent,
  broadcastDerivedState,
  broadcastSessionEnded,
} from "./ws/server.js";

const PORT = Number.parseInt(process.env.PORT ?? "3030", 10);
const WORKSPACE = "/tmp/glassbox-t2.2";

mkdirSync(WORKSPACE, { recursive: true });

const adapter = new CodexAdapter();
adapter.start();
let adapterReady = false;
const traceStore = new RawTraceStore();

async function ensureInitialized(): Promise<void> {
  if (adapterReady) return;
  await adapter.initialize();
  adapterReady = true;
}

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error("invalid json body")); }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Session store — one session = one long-lived thread, multiple turns
// ---------------------------------------------------------------------------

interface SessionRecord {
  /** Server-assigned thread UUID. */
  threadId: string;
  /** Client-provided thread identifier (for display/debug). */
  clientThreadId: string;
  /** Active turn UUID, or null when no turn is in progress. */
  activeTurnId: string | null;
  /** Ordered list of every turn UUID for this session. */
  turnIds: string[];
}

const sessions = new Map<string, SessionRecord>();

// ---------------------------------------------------------------------------
// /steer helper: wait for previous turn to complete, then start a new one
// ---------------------------------------------------------------------------

async function startNewTurn(
  session: SessionRecord,
  instruction: string,
  traceCollector: (method: string, params: Record<string, unknown>) => void
): Promise<{
  turnId: string;
  eventCounts: Record<string, number>;
  turnStatus: string;
  turnDurationMs: number | null;
  error?: string;
}> {
  // If a turn is already running, wait for it to end first
  if (session.activeTurnId) {
    await new Promise<void>((resolve) => {
      adapter.registerOnTurnEnd((_status: string) => resolve());
    });
  }

  // ---- Fire the turn/start request first, then collect its events.
  // The adapter emits turn/started as soon as the provider receives the
  // request, so starting first then attaching the handler still captures
  // that marker while avoiding a 30s timeout if no prior turn is in flight.
  const turn = await adapter.startTurn(session.threadId, [
    { type: "text", text: instruction },
  ], {
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    cwd: WORKSPACE,
  });

  // Now attach the event collector for the new turn.
  const evCounts: Record<string, number> = {} as Record<string, number>;
  let capturedTurnId = turn.id;
  let completed: { status: string; durationMs: number | null; error?: string } | null = null;

  const wrappedCollector = (method: string, params: Record<string, unknown>) => {
    traceCollector(method, params);
    evCounts[method] = (evCounts[method] || 0) + 1;
    if (method === "turn/started" && params.turnId && !capturedTurnId) {
      capturedTurnId = params.turnId;
    }
    if (method === "turn/completed" || method === "turn/interrupted") {
      const turnData = (params as { turn?: { status?: string; durationMs?: number | null } }).turn;
      if (turnData) {
        completed = {
          status: turnData.status || method.replace("turn/", ""),
          durationMs: turnData.durationMs ?? null,
        };
      }
    }
  };

  // Register the collection handler. pushTurnCompleted ensures the promise
  // resolves exactly once when turn/completed or turn/interrupted arrives.
  const turnEndPromise = new Promise<void>((resolve) => {
    adapter.registerOnTurnEnd((_status: string) => resolve());
  });

  await adapter.collectTurnEvents(session.threadId, turn.id, 30_000, wrappedCollector);
  await turnEndPromise;

  const finalTurnId = capturedTurnId || turn.id;
  session.activeTurnId = finalTurnId;
  session.turnIds.push(finalTurnId);

  // Derive turn status from the collected event counts
  const turnStatus =
    evCounts["turn/completed"] > 0 ? "completed" :
    evCounts["turn/interrupted"] > 0 ? "interrupted" :
    completed?.status || "completed";

  return {
    turnId: finalTurnId,
    eventCounts: evCounts,
    turnStatus,
    turnDurationMs: completed?.durationMs ?? null,
  };
}

function makeTraceCollector(sessionId: string) {
  return (method: string, params: Record<string, unknown>) => {
    traceStore.append(sessionId, { method, params });
    broadcastEvent(sessionId, { method, params });
  };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ---- Health check ----
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "application/json" });
    const recent = sessions.size > 0
      ? Array.from(sessions.entries()).slice(-3).map(([sid, rec]) => ({
          sessionId: sid,
          threadId: rec.threadId,
          activeTurnId: rec.activeTurnId,
          turnCount: rec.turnIds.length,
        }))
      : null;
    res.end(JSON.stringify({
      service: "glassbox-server",
      status: "ok",
      contractsVersion,
      sharedVersion,
      adapterReady,
      sessionCount: sessions.size,
      recentSessions: recent,
    }));
    return;
  }

  // ---- POST /run-test (first turn of a new session) ----
  // Returns sessionId immediately so the caller can interact (e.g. click Stop)
  // while the turn is active. Event collection and derived-state broadcast
  // happen in the background.
  if (req.method === "POST" && req.url === "/run-test") {
    try {
      await ensureInitialized();

      const body = await parseBody(req);
      const sessionId = randomUUID();
      const clientThreadId =
        typeof body.threadId === "string"
          ? body.threadId
          : `glassbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const prompt = typeof body.prompt === "string" ? body.prompt : "say ready";

      const traceCollector = makeTraceCollector(sessionId);

      const thread = await adapter.startThread(clientThreadId, {
        cwd: WORKSPACE,
        sandbox: "read-only",
        approvalPolicy: "on-request",
      });

      const turn = await adapter.startTurn(thread.id, [
        { type: "text", text: prompt },
      ], {
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        cwd: WORKSPACE,
      });

      sessions.set(sessionId, {
        threadId: thread.id,
        clientThreadId,
        activeTurnId: turn.id,
        turnIds: [turn.id],
      });

      // Return immediately so the caller can interact while turn is active
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        sessionId,
        threadId: thread.id,
        turnId: turn.id,
        status: "running",
      }));

      // P6.4: Collect the event stream for up to 30 s in the background
      adapter.collectTurnEvents(thread.id, turn.id, 30_000, traceCollector)
        .then(() => {
          const replayResult = replayTrace(sessionId);
          broadcastDerivedState(sessionId, replayResult.state as unknown as Record<string, unknown>);
          broadcastSessionEnded(sessionId);
          // Clear active turn once it ends
          const s = sessions.get(sessionId);
          if (s) s.activeTurnId = null;
        })
        .catch((err) => {
          console.error(`[run-test background] session ${sessionId} failed:`, err);
        });
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: String(err instanceof Error ? err.message : err),
      }));
    }
    return;
  }

  // ---- POST /run-stream (same + live WS events, no final sessionEnded) ----
  // Returns immediately with sessionId; event collection runs in background.
  if (req.method === "POST" && req.url === "/run-stream") {
    try {
      await ensureInitialized();

      const body = await parseBody(req);
      const sessionId = randomUUID();
      const clientThreadId =
        typeof body.threadId === "string"
          ? body.threadId
          : `glassbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const prompt = typeof body.prompt === "string" ? body.prompt : "say ready";

      const traceCollector = makeTraceCollector(sessionId);

      const thread = await adapter.startThread(clientThreadId, {
        cwd: WORKSPACE,
        sandbox: "read-only",
        approvalPolicy: "on-request",
      });

      const turn = await adapter.startTurn(thread.id, [
        { type: "text", text: prompt },
      ], {
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        cwd: WORKSPACE,
      });

      sessions.set(sessionId, {
        threadId: thread.id,
        clientThreadId,
        activeTurnId: turn.id,
        turnIds: [turn.id],
      });

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        sessionId,
        threadId: thread.id,
        turnId: turn.id,
        status: "running",
      }));

      adapter.collectTurnEvents(thread.id, turn.id, 30_000, traceCollector)
        .then(() => {
          const replayResult = replayTrace(sessionId);
          broadcastDerivedState(sessionId, replayResult.state as unknown as Record<string, unknown>);
          const s = sessions.get(sessionId);
          if (s) s.activeTurnId = null;
        })
        .catch((err) => {
          console.error(`[run-stream background] session ${sessionId} failed:`, err);
        });
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: String(err instanceof Error ? err.message : err),
      }));
    }
    return;
  }

  // ---- POST /pause — interrupt active turn (prepares for /steer) ----
  if (req.method === "POST" && req.url === "/pause") {
    try {
      const body = await parseBody(req);
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";

      if (!sessionId) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "sessionId required" }));
        return;
      }

      const session = sessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `no session: ${sessionId}` }));
        return;
      }

      const alreadyIdle = !session.activeTurnId;

      if (!alreadyIdle) {
        const { activeTurnId, threadId } = session;

        // Register hook: append action.pause AFTER turn/completed flows through trace,
        // giving correct ordering: provider events → action.pause
        adapter.registerOnTurnEnd((turnStatus) => {
          traceStore.append(sessionId, {
            method: "action.pause",
            params: {
              kind: "action.pause",
              source: "glassbox-user",
              sessionId,
              threadId,
              turnId: activeTurnId,
              turnStatus,
              ts: new Date().toISOString(),
            },
          });
          broadcastEvent(sessionId, {
            method: "action.pause",
            params: {
              kind: "action.pause",
              source: "glassbox-user",
              sessionId,
              threadId,
              turnId: activeTurnId,
              turnStatus,
              ts: new Date().toISOString(),
            },
          });
        });

        await adapter.interruptTurn(threadId, activeTurnId as string);
        session.activeTurnId = null;

        // Wait for interrupted turn to finish and action.pause to be recorded
        await new Promise<void>((resolve) => {
          adapter.registerOnTurnEnd((_status: string) => resolve());
        });
      }

      const replayResult = replayTrace(sessionId);
      broadcastDerivedState(sessionId, replayResult.state as unknown as Record<string, unknown>);

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        paused: !alreadyIdle,
        sessionId,
        derivedState: replayResult.state,
      }, null, 2));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: String(err instanceof Error ? err.message : err),
      }));
    }
    return;
  }

  // ---- POST /stop — interrupt active turn by session ----
  if (req.method === "POST" && req.url === "/stop") {
    try {
      const body = await parseBody(req);
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";

      if (!sessionId) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "sessionId required" }));
        return;
      }

      const session = sessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `no session: ${sessionId}` }));
        return;
      }

      const alreadyStopped = !session.activeTurnId;

      if (!alreadyStopped) {
        const { activeTurnId, threadId } = session;

        // Register a hook: append action.stop to trace AFTER the turn/completed
        // event flows through, ensuring correct ordering in the trace.
        adapter.registerOnTurnEnd((turnStatus) => {
          traceStore.append(sessionId, {
            method: "action.stop",
            params: {
              kind: "action.stop",
              source: "glassbox-user",
              ts: new Date().toISOString(),
              sessionId,
              threadId,
              turnId: activeTurnId,
              turnStatus,
            },
          });
          broadcastEvent(sessionId, {
            method: "action.stop",
            params: {
              kind: "action.stop",
              source: "glassbox-user",
              sessionId,
              threadId,
              turnId: activeTurnId,
              turnStatus,
            },
          });
        });

        await adapter.interruptTurn(threadId, activeTurnId as string);
        session.activeTurnId = null;

        // Wait for the turn to finish and action.stop to be recorded
        await new Promise<void>((resolve) => {
          adapter.registerOnTurnEnd((_status: string) => resolve());
        });
      }

      const replayResult = replayTrace(sessionId);
      broadcastDerivedState(sessionId, replayResult.state as unknown as Record<string, unknown>);

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        stopped: !alreadyStopped,
        sessionId,
        derivedState: replayResult.state,
      }, null, 2));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: String(err instanceof Error ? err.message : err),
      }));
    }
    return;
  }

  // ---- POST /steer — steering instruction for an existing session ----
  if (req.method === "POST" && req.url === "/steer") {
    try {
      await ensureInitialized();

      const body = await parseBody(req);
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const instruction = typeof body.instruction === "string" ? body.instruction : "";

      if (!sessionId) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "sessionId required" }));
        return;
      }

      const session = sessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `no session: ${sessionId}` }));
        return;
      }

      const traceCollector = makeTraceCollector(sessionId);

      // S1 protocol: if a turn is active, interrupt it first
      if (session.activeTurnId) {
        const { activeTurnId, threadId } = session;

        // Register a hook so we wait for turn completion
        await new Promise<void>((resolve) => {
          adapter.registerOnTurnEnd((_status: string) => resolve());
        });

        await adapter.interruptTurn(threadId, activeTurnId);
        session.activeTurnId = null;

        // Wait for the interrupted turn to finish recording
        await new Promise<void>((resolve) => {
          adapter.registerOnTurnEnd((_status: string) => resolve());
        });
      }

      // Record the steer action after the new turn's events are in trace
      // (trace ordering: turn1 events → action.stop → turn2 events → action.steer)
      const steerRecord = {
        method: "action.steer",
        params: {
          kind: "action.steer",
          instruction,
          source: "glassbox-user",
          sessionId,
          threadId: session.threadId,
          ts: new Date().toISOString(),
        },
      };

      // Start the new turn on the same thread
      const summary = await startNewTurn(session, instruction, traceCollector);

      // Now that startNewTurn has returned, we know the actual turnId.
      // Patch the steer record with turnId so the reducer can backfill
      // the instruction text onto the correct turn record during replay.
      steerRecord.params.turnId = summary.turnId;

      // Record action.steer AFTER the turn's provider events are in the trace
      traceStore.append(sessionId, steerRecord);
      broadcastEvent(sessionId, steerRecord.params);

      const replayResult = replayTrace(sessionId);
      broadcastDerivedState(sessionId, replayResult.state as unknown as Record<string, unknown>);

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        sessionId,
        derivedState: replayResult.state,
        turnId: summary.turnId,
        turnStatus: summary.turnStatus,
        turnDurationMs: summary.turnDurationMs,
      }, null, 2));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: String(err instanceof Error ? err.message : err),
      }));
    }
    return;
  }

  // ---- POST /send-task — edit task and start new turn on same thread ----
  if (req.method === "POST" && req.url === "/send-task") {
    try {
      await ensureInitialized();

      const body = await parseBody(req);
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const task = typeof body.task === "string" ? body.task : "";

      if (!sessionId || !task.trim()) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "sessionId and task required" }));
        return;
      }

      const session = sessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `no session: ${sessionId}` }));
        return;
      }

      const editedTask = task.trim();
      const traceCollector = makeTraceCollector(sessionId);

      // If a turn is active, interrupt it first
      if (session.activeTurnId) {
        const { activeTurnId, threadId } = session;

        await new Promise<void>((resolve) => {
          adapter.registerOnTurnEnd((_status: string) => resolve());
        });

        await adapter.interruptTurn(threadId, activeTurnId);
        session.activeTurnId = null;

        await new Promise<void>((resolve) => {
          adapter.registerOnTurnEnd((_status: string) => resolve());
        });
      }

      // Start the new turn on the same thread with the edited task text
      const summary = await startNewTurn(session, editedTask, traceCollector);

      // Record action.send AFTER the turn's provider events are in the trace
      const sendRecord = {
        method: "action.send",
        params: {
          kind: "action.send",
          source: "glassbox-user",
          sessionId,
          threadId: session.threadId,
          turnId: summary.turnId,
          task: editedTask,
          ts: new Date().toISOString(),
        },
      };

      traceStore.append(sessionId, sendRecord);
      broadcastEvent(sessionId, sendRecord.params);

      const replayResult = replayTrace(sessionId);
      broadcastDerivedState(sessionId, replayResult.state as unknown as Record<string, unknown>);

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        sessionId,
        derivedState: replayResult.state,
        turnId: summary.turnId,
        turnStatus: summary.turnStatus,
        turnDurationMs: summary.turnDurationMs,
      }, null, 2));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: String(err instanceof Error ? err.message : err),
      }));
    }
    return;
  }

  // ---- GET /trace/:sessionId ----
  if (req.method === "GET" && req.url) {
    const match = req.url.match(/^\/trace\/([^/]+)$/);
    if (match) {
      const sessionId = match[1];
      try {
        const trace: TraceEntry[] = loadTrace(sessionId);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId, entries: trace }, null, 2));
      } catch {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `no trace for session: ${sessionId}` }));
      }
      return;
    }
  }

  // ---- GET /state/:sessionId ----
  if (req.method === "GET" && req.url) {
    const match = req.url.match(/^\/state\/([^/]+)$/);
    if (match) {
      const sessionId = match[1];
      try {
        const result = replayTrace(sessionId);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId, derivedState: result.state, replay: result }, null, 2));
      } catch {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `no trace for session: ${sessionId}` }));
      }
      return;
    }
  }

  // ---- POST /interrupt (backward compat — also supports sessionId) ----
  if (req.method === "POST" && req.url === "/interrupt") {
    try {
      let body: Record<string, unknown> = {};
      try { body = await parseBody(req); } catch { /* body optional */ }

      // support either {sessionId} or {threadId, turnId}
      const sessionId = typeof body.sessionId === "string" ? body.sessionId as string : "";
      const threadId =
        typeof body.threadId === "string" ? body.threadId : (sessionId ? sessions.get(sessionId)?.threadId : undefined);
      const turnId =
        typeof body.turnId === "string" ? body.turnId : (sessionId ? sessions.get(sessionId)?.activeTurnId : undefined);

      if (!threadId || !turnId) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "no active turn — provide sessionId or threadId+turnId" }));
        return;
      }

      // If we can trace it, record the interrupt as an action
      if (sessionId) {
        adapter.registerOnTurnEnd((turnStatus) => {
          traceStore.append(sessionId, {
            method: "action.interrupt",
            params: {
              kind: "action.interrupt",
              source: "glassbox-user",
              threadId,
              turnId,
              turnStatus,
              ts: new Date().toISOString(),
            },
          });
        });
      }

      await adapter.interruptTurn(threadId, turnId);

      // Clear active turn from session if known
      if (sessionId) {
        const s = sessions.get(sessionId);
        if (s) s.activeTurnId = null;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, threadId, turnId }));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: String(err instanceof Error ? err.message : err),
      }));
    }
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

// ---- Mount WebSocket server ----

attachWebSocketServer(server, async (_sessionId: string) => {
  // S6 explicit execution: no auto-interrupt on WS subscribe.
  // /pause, /stop, and /steer endpoints handle execution changes explicitly.
  // WS subscription is read-only: receives live events and derived state only.
});

server.listen(PORT, () => {
  console.log(`glassbox-server listening on http://localhost:${PORT}`);
  console.log(`  WebSocket:          ws://localhost:${PORT}/ws?sessionId=<id>`);
  console.log(`  POST /run-test:     generate sessionId, run read-only turn`);
  console.log(`  POST /run-stream:   same + live WS events for sessionId`);
  console.log(`  POST /pause:        interrupt active turn (prepares for /steer)`);
  console.log(`  POST /stop:         interrupt active turn by sessionId`);
  console.log(`  POST /steer:        steering instruction for existing session`);
  console.log(`  POST /send-task:    edit task and start new turn on same thread`);
  console.log(`  GET  /trace/:id:    raw trace entries`);
  console.log(`  GET  /state/:id:    derived state replay`);
});

process.on("SIGINT", () => {
  adapter.stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  adapter.stop();
  process.exit(0);
});
