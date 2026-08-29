// apps/server — Glassbox runtime HTTP shell with Codex adapter endpoints.
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
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
  broadcastApproval,
} from "./ws/server.js";

const PORT = Number.parseInt(process.env.PORT ?? "3030", 10);
const WORKSPACE = "/tmp/glassbox-t2.2";

// Known-broken fixture for the demo workspace. /run-demo rewrites this file
// before every run so each demo starts from the same reproducible state.
const BROKEN_UTILS_JS = `// Demo project: a tiny module with a deliberate off-by-one bug.
// The \`sum\` function should return the sum of all numbers from 1 to n (inclusive).
// Bug: it uses \`i < n\` instead of \`i <= n\`, so it misses the last number.

export function sum(n) {
  let total = 0;
  for (let i = 1; i < n; i++) {
    total += i;
  }
  return total;
}

export function multiply(a, b) {
  return a * b;
}
`;

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
  /** Workspace path for this session (used for git diff scanning). */
  workspace: string;
  /** Active turn UUID, or null when no turn is in progress. */
  activeTurnId: string | null;
  /** Ordered list of every turn UUID for this session. */
  turnIds: string[];
  /** Pending file-change approval requests awaiting user decision. */
  pendingApprovals: Array<{
    itemId: string;
    turnId: string;
    threadId: string;
    reason: string | null;
    grantRoot: string | null;
    startedAtMs: number;
  }>;
}

const sessions = new Map<string, SessionRecord>();

// ---------------------------------------------------------------------------
// /steer helper: wait for previous turn to complete, then start a new one
// ---------------------------------------------------------------------------

async function startNewTurn(
  session: SessionRecord,
  instruction: string,
  workspace: string,
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

  // S8: Snapshot workspace before turn — detects file changes missed by event stream
  adapter.snapshotWorkspace(workspace);

  // ---- Fire the turn/start request first, then collect its events.
  // The adapter emits turn/started as soon as the provider receives the
  // request, so starting first then attaching the handler still captures
  // that marker while avoiding a 30s timeout if no prior turn is in flight.
  const turn = await adapter.startTurn(session.threadId, [
    { type: "text", text: instruction },
  ], {
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [workspace],
      networkAccess: false,
    },
    cwd: workspace,
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
  // Fall back to a 45 s timeout: the Codex CLI may omit turn/completed,
  // and the unbounded wait below would prevent action.steer/action.send
  // from ever being recorded in the trace.
  const turnEndPromise = new Promise<void>((resolve) => {
    adapter.registerOnTurnEnd((_status: string) => resolve());
  });

  await adapter.collectTurnEvents(session.threadId, turn.id, 30_000, wrappedCollector);
  await Promise.race([
    turnEndPromise,
    new Promise<void>((resolve) => setTimeout(resolve, 45_000)),
  ]);

  // S8: Post-turn workspace scan — detects file changes codex omitted from events
  const scanResult = adapter.scanAndFireHooks(workspace);
  if (scanResult.changes.length > 0) {
    const itemId = "git-" + turn.id.slice(0, 8);
    traceCollector("item/fileChange", {
      itemId,
      turnId: turn.id,
      threadId: session.threadId,
      changes: scanResult.changes,
    });
  }

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
  let sinceLastDerive = 0;
  return (method: string, params: Record<string, unknown>) => {
    traceStore.append(sessionId, { method, params });
    broadcastEvent(sessionId, { method, params });
    // Live canvas updates: re-derive and broadcast periodically so task,
    // artifact, and result shapes appear while the turn is still running,
    // not only after it completes.
    sinceLastDerive++;
    if (sinceLastDerive >= 25 || method === "turn/completed") {
      sinceLastDerive = 0;
      try {
        const replayResult = replayTrace(sessionId);
        broadcastDerivedState(sessionId, replayResult.state as unknown as Record<string, unknown>);
      } catch { /* best-effort */ }
    }
  };
}

// Attach an approval-event listener to the adapter for this session.
// When codex requests approval, we surface it to the UI and record it
// as a pending decision in the session. The /decide endpoint consumes
// these pending approvals.
function registerApprovalHandler(sessionId: string, _onDecide: (itemId: string, approved: boolean) => void) {
  adapter.on("approval", (ev: { itemId: string; turnId: string; threadId: string; reason: string | null; grantRoot: string | null; startedAtMs: number }) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.pendingApprovals.push({
        itemId: ev.itemId,
        turnId: ev.turnId,
        threadId: ev.threadId,
        reason: ev.reason,
        grantRoot: ev.grantRoot,
        startedAtMs: ev.startedAtMs,
      });
    }
    // Broadcast the approval request to WS subscribers
    broadcastApproval(sessionId, {
      threadId: ev.threadId,
      turnId: ev.turnId,
      itemId: ev.itemId,
      startedAtMs: ev.startedAtMs,
      reason: ev.reason,
      grantRoot: ev.grantRoot,
    });
  });
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

      adapter.snapshotWorkspace(WORKSPACE);

      const turn = await adapter.startTurn(thread.id, [
        { type: "text", text: prompt },
      ], {
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        cwd: WORKSPACE,
      });

      sessions.set(sessionId, {
        threadId: thread.id,
        clientThreadId,
        workspace: WORKSPACE,
        activeTurnId: turn.id,
        turnIds: [turn.id],
        pendingApprovals: [],
      });

      registerApprovalHandler(sessionId, (_itemId, _approved) => {
        // Default no-op: the /decide endpoint handles decisions explicitly
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
          // S8: post-turn workspace scan for file changes omitted from events
          try {
            var scanResult = adapter.scanAndFireHooks(WORKSPACE);
            if (scanResult.changes.length > 0) {
              var fileItemId = "git-" + (turn.id || "").slice(0, 8);
              traceStore.append(sessionId, {
                method: "item/fileChange",
                params: { itemId: fileItemId, turnId: turn.id, changes: scanResult.changes },
              });
              traceCollector("item/fileChange", { itemId: fileItemId, turnId: turn.id, changes: scanResult.changes });
            }
          } catch { /* best-effort */ }

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

      adapter.snapshotWorkspace(WORKSPACE);

      const turn = await adapter.startTurn(thread.id, [
        { type: "text", text: prompt },
      ], {
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        cwd: WORKSPACE,
      });

      sessions.set(sessionId, {
        threadId: thread.id,
        clientThreadId,
        workspace: WORKSPACE,
        activeTurnId: turn.id,
        turnIds: [turn.id],
        pendingApprovals: [],
      });

      registerApprovalHandler(sessionId, (_itemId, _approved) => {
        // Default no-op: the /decide endpoint handles decisions explicitly
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
          // S8: post-turn workspace scan for file changes omitted from events
          try {
            var scanResult = adapter.scanAndFireHooks(WORKSPACE);
            if (scanResult.changes.length > 0) {
              var fileItemId = "git-" + (turn.id || "").slice(0, 8);
              traceStore.append(sessionId, {
                method: "item/fileChange",
                params: { itemId: fileItemId, turnId: turn.id, changes: scanResult.changes },
              });
              traceCollector("item/fileChange", { itemId: fileItemId, turnId: turn.id, changes: scanResult.changes });
            }
          } catch { /* best-effort */ }

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

      // S1 protocol: if a turn is active, interrupt it first. Interrupt
      // BEFORE waiting, and bound the wait: a turn hung on an unanswered
      // approval must not deadlock steering.
      if (session.activeTurnId) {
        const { activeTurnId, threadId } = session;

        const turnEnded = new Promise<void>((resolve) => {
          adapter.registerOnTurnEnd(() => resolve());
        });
        try {
          await adapter.interruptTurn(threadId, activeTurnId);
        } catch {
          // The turn may already have finished; nothing to interrupt.
        }
        await Promise.race([
          turnEnded,
          new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
        ]);
        session.activeTurnId = null;
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
      const summary = await startNewTurn(session, instruction, session.workspace, traceCollector);

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

      // If a turn is active, interrupt it first (interrupt before waiting,
      // bounded wait so a hung turn cannot deadlock the edit-and-send path)
      if (session.activeTurnId) {
        const { activeTurnId, threadId } = session;

        const turnEnded = new Promise<void>((resolve) => {
          adapter.registerOnTurnEnd(() => resolve());
        });
        try {
          await adapter.interruptTurn(threadId, activeTurnId);
        } catch {
          // The turn may already have finished; nothing to interrupt.
        }
        await Promise.race([
          turnEnded,
          new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
        ]);
        session.activeTurnId = null;
      }

      // Start the new turn on the same thread with the edited task text
      const summary = await startNewTurn(session, editedTask, session.workspace, traceCollector);

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

  // ---- POST /run-demo — run a task against the controlled demo workspace ---- //
  if (req.method === "POST" && req.url === "/run-demo") {
    try {
      await ensureInitialized();

      const body = await parseBody(req);
      const sessionId = randomUUID();
      const clientThreadId =
        typeof body.threadId === "string"
          ? body.threadId
          : `demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const prompt = typeof body.prompt === "string" ? body.prompt : "update utils.js so the tests pass";
      const workspace = body.workspace && typeof body.workspace === "string"
        ? body.workspace
        : "/tmp/glassbox-demo-repo";

      const traceCollector = makeTraceCollector(sessionId);

      const thread = await adapter.startThread(clientThreadId, {
        cwd: workspace,
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
      });

      // Reset the demo fixture so every run starts from the same broken
      // state (a previous run may have already fixed the file in place).
      writeFileSync(`${workspace}/utils.js`, BROKEN_UTILS_JS);

      adapter.snapshotWorkspace(workspace);

      const turn = await adapter.startTurn(thread.id, [
        { type: "text", text: prompt },
      ], {
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [workspace],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
        cwd: workspace,
      });

      sessions.set(sessionId, {
        threadId: thread.id,
        clientThreadId,
        workspace: workspace,
        activeTurnId: turn.id,
        turnIds: [turn.id],
        pendingApprovals: [],
      });

      registerApprovalHandler(sessionId, (_itemId, _approved) => {
        // handled by /decide
      });

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        sessionId,
        threadId: thread.id,
        turnId: turn.id,
        workspace,
        status: "running",
      }));

      adapter.collectTurnEvents(thread.id, turn.id, 30_000, traceCollector)
        .then(() => {
          // S8: post-turn workspace scan for file changes omitted from events
          try {
            var scanResult = adapter.scanAndFireHooks(workspace);
            if (scanResult.changes.length > 0) {
              var fileItemId = "git-" + (turn.id || "").slice(0, 8);
              traceStore.append(sessionId, {
                method: "item/fileChange",
                params: { itemId: fileItemId, turnId: turn.id, changes: scanResult.changes },
              });
              traceCollector("item/fileChange", { itemId: fileItemId, turnId: turn.id, changes: scanResult.changes });
            }
          } catch { /* best-effort */ }

          const replayResult = replayTrace(sessionId);
          broadcastDerivedState(sessionId, replayResult.state as unknown as Record<string, unknown>);
          const s = sessions.get(sessionId);
          if (s) s.activeTurnId = null;
        })
        .catch((err) => {
          console.error(`[run-demo background] session ${sessionId} failed:`, err);
        });
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: String(err instanceof Error ? err.message : err),
      }));
    }
    return;
  }

  // ---- POST /decide — record user's approval/decline and forward to provider -- //
  if (req.method === "POST" && req.url === "/decide") {
    try {
      const body = await parseBody(req);
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const itemId = typeof body.itemId === "string" ? body.itemId : "";
      const approved = body.approved === true;

      if (!sessionId || !itemId) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "sessionId and itemId required" }));
        return;
      }

      const session = sessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `no session: ${sessionId}` }));
        return;
      }

      // Remove from pending approvals
      const beforeCount = session.pendingApprovals.length;
      session.pendingApprovals = session.pendingApprovals.filter(
        (a) => a.itemId !== itemId
      );

      // Find the adapter requestId for this itemId and respond
      const requestId = adapter.findApprovalRequestId(itemId);
      if (requestId !== null) {
        adapter.respondToApproval(requestId, approved);
      }

      // Record the decision in the trace
      const decideRecord = {
        method: "action.decide",
        params: {
          kind: "action.decide",
          source: "glassbox-user",
          sessionId,
          threadId: session.threadId,
          itemId,
          approved,
          ts: new Date().toISOString(),
        },
      };
      traceStore.append(sessionId, decideRecord);
      broadcastEvent(sessionId, decideRecord.params);

      const replayResult = replayTrace(sessionId);
      broadcastDerivedState(sessionId, replayResult.state as unknown as Record<string, unknown>);

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        sessionId,
        approved,
        removedPending: beforeCount - session.pendingApprovals.length,
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
}, (sessionId: string) => {
  // Catch-up for approvals that fired before the client subscribed.
  const session = sessions.get(sessionId);
  if (!session) return [];
  return session.pendingApprovals.map((a) => ({
    type: "approval" as const,
    threadId: a.threadId,
    turnId: a.turnId,
    itemId: a.itemId,
    startedAtMs: a.startedAtMs,
    reason: a.reason,
    grantRoot: a.grantRoot,
  }));
});

server.listen(PORT, () => {
  console.log(`glassbox-server listening on http://localhost:${PORT}`);
  console.log(`  WebSocket:          ws://localhost:${PORT}/ws?sessionId=<id>`);
  console.log(`  POST /run-test:     generate sessionId, run read-only turn`);
  console.log(`  POST /run-stream:   same + live WS events for sessionId`);
  console.log(`  POST /run-demo:     run task against demo workspace with workspaceWrite`);
  console.log(`  POST /pause:        interrupt active turn (prepares for /steer)`);
  console.log(`  POST /stop:         interrupt active turn by sessionId`);
  console.log(`  POST /steer:        steering instruction for existing session`);
  console.log(`  POST /send-task:    edit task and start new turn on same thread`);
  console.log(`  POST /decide:       approve/decline file-change request for session`);
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
