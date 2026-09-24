// apps/server — Glassbox runtime HTTP shell with Codex and Claude Code adapter endpoints.
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { openManagementRuntime, serverPort } from "./management/runtime.js";
import { ManagementError } from "./management/access.js";
import { resolveExecutablePath } from "./platform/executable.js";

import { createAdapter } from "./provider/index.js";
import type { ProviderAdapter } from "./provider/types.js";

import { contractsVersion } from "@glassbox/contracts";
import { sharedVersion } from "@glassbox/shared";

import { RawTraceStore, TRACE_PROVENANCE, TRACE_PROVENANCE_CLAUDECODE } from "./trace/store.js";
import { loadTrace } from "./trace/load.js";
import type { TraceEntry } from "./trace/store.js";
import { replayTrace } from "./state/replay.js";
import { screenValue } from "./screening/index.js";
import {
  attachWebSocketServer,
  broadcastEvent,
  broadcastDerivedState,
  broadcastSessionEnded,
  broadcastApproval,
} from "./ws/server.js";

import { getDefaultWorkspace, validateRepoPath, getGlassboxDataDir } from "./platform/paths.js";

let management: Awaited<ReturnType<typeof openManagementRuntime>> | undefined;

function recordSessionConfig(
  _sessionId: string,
  traceCollector: (method: string, params: Record<string, unknown>) => void,
  config: {
    provider: string;
    permissionMode?: string;
    approvalPolicy?: string;
    sandboxPolicy?: string;
    repoPath: string;
  },
) {
  traceCollector("session.config", {
    kind: "session.config",
    provider: config.provider,
    permissionMode: config.permissionMode ?? null,
    approvalPolicy: config.approvalPolicy ?? null,
    sandboxPolicy: config.sandboxPolicy ?? null,
    repoPath: config.repoPath,
    ts: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Repo-path defaults per provider
// ---------------------------------------------------------------------------

const DEFAULT_WORKSPACE_CODEX = getDefaultWorkspace("codex");
const DEFAULT_WORKSPACE_CLAUDE = getDefaultWorkspace("claude-code");
const DEFAULT_WORKSPACE_DEMO = getDefaultWorkspace("demo");

function defaultWorkspaceFor(provider: string): string {
  return provider === "claude-code" ? DEFAULT_WORKSPACE_CLAUDE : DEFAULT_WORKSPACE_CODEX;
}

function defaultApprovalPolicy(_provider: string): string {
  return "on-request";
}

function defaultPermissionMode(): string {
  return "auto";
}

// ---------------------------------------------------------------------------
// Build provider-specific session/turn options
// ---------------------------------------------------------------------------

interface SessionRunOptions {
  provider: string;
  workspace: string;
  approvalPolicy: string;
  sandboxType: string;
  permissionMode: string;
  appendSystemPrompt?: string;
}

function sessionStartOpts(opts: SessionRunOptions): Record<string, unknown> {
  if (opts.provider === "claude-code") {
    return {
      cwd: opts.workspace,
      permissionMode: opts.permissionMode,
      ...(opts.appendSystemPrompt ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
    };
  }
  // thread/start validates the `sandbox` param in kebab-case (CLI-arg style):
  // "unknown variant `readOnly`, expected one of `read-only`, ...".
  // turn/start's SandboxPolicy.type (see turnStartOpts) validates camelCase.
  // The two call sites genuinely differ; keep the maps separate.
  const sandboxWireMap: Record<string, string> = {
    "read-only": "read-only",
    "workspace-write": "workspace-write",
    "danger-full-access": "danger-full-access",
    readOnly: "read-only",
    workspaceWrite: "workspace-write",
    dangerFullAccess: "danger-full-access",
  };
  const wireResult = sandboxWireMap[opts.sandboxType] || opts.sandboxType;
  return {
    cwd: opts.workspace,
    sandbox: wireResult,
    approvalPolicy: opts.approvalPolicy,
  };
}

function turnStartOpts(opts: SessionRunOptions, _workspace: string): Record<string, unknown> {
  if (opts.provider === "claude-code") {
    return { permissionMode: opts.permissionMode };
  }
  // Normalize kebab-case panel labels to the camelCase wire variants.
  const sandboxWireMap: Record<string, string> = {
    "read-only": "readOnly",
    "workspace-write": "workspaceWrite",
    "danger-full-access": "dangerFullAccess",
  };
  const sandboxType = sandboxWireMap[opts.sandboxType] || opts.sandboxType;
  return {
    sandboxPolicy: { type: sandboxType, networkAccess: false },
    approvalPolicy: opts.approvalPolicy,
  };
}

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

const traceStore = new RawTraceStore();

// Session → provider adapter map (created when session starts, cleaned up on end)
const sessionAdapters = new Map<string, ProviderAdapter>();

interface ProviderSlot {
  adapter: ProviderAdapter;
  ready: boolean;
  initPromise: Promise<ProviderAdapter> | null;
}

const providerSlots = new Map<string, ProviderSlot>();

export async function getOrInitAdapter(
  provider: "codex" | "claude-code",
): Promise<ProviderAdapter> {
  let slot = providerSlots.get(provider);
  if (!slot) {
    const adapter = createAdapter(provider);
    slot = { adapter, ready: false, initPromise: null };
    providerSlots.set(provider, slot);
  }

  if (slot.ready) {
    return slot.adapter;
  }

  if (slot.initPromise) {
    return slot.initPromise;
  }

  const initializingSlot = slot;
  slot.initPromise = Promise.resolve().then(async () => {
    try {
      initializingSlot.adapter.start();
      await initializingSlot.adapter.initialize();
      initializingSlot.ready = true;
      return initializingSlot.adapter;
    } catch (err) {
      try {
        initializingSlot.adapter.stop();
      } catch {
        /* Preserve the initialization error. */
      }
      providerSlots.delete(provider);
      const providerName = provider === "claude-code" ? "Claude Code" : "Codex";
      const errorMsg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to initialize ${providerName} provider: ${errorMsg}. ` +
          `Ensure the executable is installed and available in PATH, or choose another configured provider.`,
      );
    } finally {
      initializingSlot.initPromise = null;
    }
  });

  return slot.initPromise;
}

export async function ensureInitialized(
  provider: "codex" | "claude-code" = "claude-code",
): Promise<ProviderAdapter> {
  return getOrInitAdapter(provider);
}

function getSessionAdapter(sessionId: string): ProviderAdapter {
  const adapter = sessionAdapters.get(sessionId);
  if (!adapter) throw new Error("The session has no active provider");
  return adapter;
}

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      chunks = [];
      reject(new ManagementError("INVALID_REQUEST", message));
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > 1024 * 1024) fail("Request body exceeds 1 MiB");
      else chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolve({});
      try {
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          fail("Expected a JSON object");
          return;
        }
        settled = true;
        chunks = [];
        resolve(value as Record<string, unknown>);
      } catch {
        fail("Invalid JSON body");
      }
    });
    req.once("error", () => fail("Request could not be read"));
    req.once("aborted", () => fail("Request was interrupted"));
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
  /** Which provider backs this session ("codex" | "claude-code"). */
  provider: string;
  /** Workspace path for this session (used for git diff scanning). */
  workspace: string;
  /** Effective startup policy is reused for every subsequent explicit action. */
  runOptions: Readonly<SessionRunOptions>;
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
  traceCollector: (method: string, params: Record<string, unknown>) => void,
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
      getSessionAdapter(session.threadId).registerOnTurnEnd((_status: string) => resolve());
    });
  }

  // S8: Snapshot workspace before turn — detects file changes missed by event stream
  getSessionAdapter(session.threadId).snapshotWorkspace(workspace);

  // ---- Fire the turn/start request first, then collect its events.
  // The adapter emits turn/started as soon as the provider receives the
  // request, so starting first then attaching the handler still captures
  // that marker while avoiding a 30s timeout if no prior turn is in flight.
  const turn = await getSessionAdapter(session.threadId).startTurn(
    session.threadId,
    [{ type: "text", text: instruction }],
    { ...turnStartOpts(session.runOptions, workspace), cwd: workspace },
  );
  session.activeTurnId = turn.id;

  // Now attach the event collector for the new turn.
  const evCounts: Record<string, number> = {} as Record<string, number>;
  let capturedTurnId = turn.id;
  // Use separate fields to avoid TS narrowing completed to never after
  // assignment inside the wrappedCollector closure.
  let turnCompletedDuration: number | null | undefined;

  const wrappedCollector = (method: string, params: Record<string, unknown>) => {
    traceCollector(method, params);
    evCounts[method] = (evCounts[method] || 0) + 1;
    if (method === "turn/started" && params.turnId && !capturedTurnId) {
      capturedTurnId = params.turnId as string;
    }
    if (method === "turn/completed" || method === "turn/interrupted") {
      const turnData = (params as { turn?: { status?: string; durationMs?: number | null } }).turn;
      if (turnData) {
        turnCompletedDuration = turnData.durationMs ?? null;
      }
    }
  };

  const collected = await getSessionAdapter(session.threadId).collectTurnEvents(
    session.threadId,
    turn.id,
    30_000,
    wrappedCollector,
  );
  if (session.activeTurnId === turn.id) session.activeTurnId = null;

  // S8: Post-turn workspace scan — detects file changes codex omitted from events
  const scanResult = getSessionAdapter(session.threadId).scanAndFireHooks(workspace);
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
  session.turnIds.push(finalTurnId);

  // Derive turn status from the collected event counts
  const turnStatus = collected.turnStatus;

  return {
    turnId: finalTurnId,
    eventCounts: evCounts,
    turnStatus,
    turnDurationMs: collected.turnDurationMs ?? turnCompletedDuration ?? null,
    ...(collected.error ? { error: collected.error } : {}),
  };
}

const defaultProvenance = TRACE_PROVENANCE;

function makeTraceCollector(sessionId: string, provenance = defaultProvenance) {
  let sinceLastDerive = 0;
  return (method: string, params: Record<string, unknown>) => {
    traceStore.append(sessionId, { method, params }, provenance);
    broadcastEvent(sessionId, { method, params });
    sinceLastDerive++;
    if (sinceLastDerive >= 25 || method === "turn/completed") {
      sinceLastDerive = 0;
      try {
        const replayResult = replayTrace(sessionId);
        broadcastDerivedState(sessionId, replayResult.state as unknown as Record<string, unknown>);
      } catch {
        /* best-effort */
      }
    }
  };
}

// Attach an approval-event listener to the adapter for this session.
// When codex requests approval, we surface it to the UI and record it
// as a pending decision in the session. The /decide endpoint consumes
// these pending approvals.
function registerApprovalHandler(
  sessionId: string,
  _onDecide: (itemId: string, approved: boolean) => void,
) {
  getSessionAdapter(sessionId).on(
    "approval",
    (ev: {
      itemId: string;
      turnId: string;
      threadId: string;
      reason: string | null;
      grantRoot: string | null;
      startedAtMs: number;
    }) => {
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
    },
  );
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!management) throw new ManagementError("NOT_READY", "The service is starting", 503);
  if (await management.handle(req, res)) return;
  // The retained Workbench is an Owner management client, including legacy Trace routes.
  management.authorize(req);
  res.setHeader("cache-control", "no-store");

  // ---- Health check ----
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "application/json" });
    const recent =
      sessions.size > 0
        ? Array.from(sessions.entries())
            .slice(-3)
            .map(([sid, rec]) => ({
              sessionId: sid,
              threadId: rec.threadId,
              activeTurnId: rec.activeTurnId,
              turnCount: rec.turnIds.length,
            }))
        : null;
    const anyAdapterReady = Array.from(providerSlots.values()).some((s) => s.ready);
    res.end(
      JSON.stringify({
        service: "glassbox-server",
        status: "ok",
        contractsVersion,
        sharedVersion,
        adapterReady: anyAdapterReady,
        sessionCount: sessions.size,
        recentSessions: recent,
      }),
    );
    return;
  }

  // ---- POST /run-test or /run-claude (first turn of a new session) ----
  // Returns sessionId immediately so the caller can interact (e.g. click Stop)
  // while the turn is active. Event collection and derived-state broadcast
  // happen in the background.
  if (req.method === "POST" && (req.url === "/run-test" || req.url === "/run-claude")) {
    try {
      const body = await parseBody(req);
      const sessionId = randomUUID();
      const provider =
        req.url === "/run-claude"
          ? "claude-code"
          : typeof body.provider === "string" && ["codex", "claude-code"].includes(body.provider)
            ? body.provider
            : "claude-code";

      let sessionAdapter: ProviderAdapter;
      try {
        sessionAdapter = await getOrInitAdapter(provider as "codex" | "claude-code");
      } catch (initErr) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: initErr instanceof Error ? initErr.message : String(initErr),
          }),
        );
        return;
      }
      sessionAdapters.set(sessionId, sessionAdapter);

      const clientThreadId =
        typeof body.threadId === "string"
          ? body.threadId
          : `glassbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const prompt = typeof body.prompt === "string" ? body.prompt : "say ready";

      // --- P2.4: provider-aware options with server-side guardrails ---
      const defaultWs = defaultWorkspaceFor(provider);
      let workspace = typeof body.repoPath === "string" ? body.repoPath : defaultWs;
      const approvalPolicy =
        typeof body.approvalPolicy === "string"
          ? body.approvalPolicy
          : defaultApprovalPolicy(provider);
      const sandboxPolicyType =
        typeof body.sandboxPolicy === "string" ? body.sandboxPolicy : "read-only";
      const permissionMode =
        typeof body.permissionMode === "string" ? body.permissionMode : defaultPermissionMode();

      // Validate custom repo paths — guardrails server-side, never trust client
      if (workspace !== defaultWs) {
        const pathCheck = validateRepoPath(workspace);
        if (!pathCheck.ok) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: pathCheck.error }));
          return;
        }
        workspace = pathCheck.realPath;
      }
      const traceProvenance =
        provider === "claude-code" ? TRACE_PROVENANCE_CLAUDECODE : TRACE_PROVENANCE;
      const traceCollector = makeTraceCollector(sessionId, traceProvenance);
      const runOpts: SessionRunOptions = {
        provider,
        workspace,
        approvalPolicy,
        sandboxType: sandboxPolicyType,
        permissionMode,
      };

      // --- P2.4: record session.config in trace for provenance ---
      recordSessionConfig(sessionId, traceCollector, {
        provider,
        permissionMode: provider === "claude-code" ? permissionMode : undefined,
        approvalPolicy: provider === "codex" ? approvalPolicy : undefined,
        sandboxPolicy: provider === "codex" ? sandboxPolicyType : undefined,
        repoPath: workspace,
      });
      // --- end P2.4 ---

      const thread = await sessionAdapter.startSession(clientThreadId, sessionStartOpts(runOpts));
      sessionAdapters.set(thread.id, sessionAdapter);

      sessionAdapter.snapshotWorkspace(workspace);

      const turn = await sessionAdapter.startTurn(
        thread.id,
        [{ type: "text", text: prompt }],
        turnStartOpts(runOpts, workspace),
      );

      sessions.set(sessionId, {
        threadId: thread.id,
        clientThreadId,
        provider,
        workspace,
        runOptions: Object.freeze({ ...runOpts }),
        activeTurnId: turn.id,
        turnIds: [turn.id],
        pendingApprovals: [],
      });

      registerApprovalHandler(sessionId, (_itemId, _approved) => {
        // Default no-op: the /decide endpoint handles decisions explicitly
      });

      // Return immediately so the caller can interact while turn is active
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          sessionId,
          threadId: thread.id,
          turnId: turn.id,
          status: "running",
        }),
      );

      // P6.4: Collect the event stream for up to 30 s in the background
      sessionAdapter
        .collectTurnEvents(thread.id, turn.id, 30_000, traceCollector)
        .then(() => {
          // S8: post-turn workspace scan for file changes omitted from events
          try {
            var scanResult = sessionAdapter.scanAndFireHooks(workspace);
            if (scanResult.changes.length > 0) {
              var fileItemId = "git-" + (turn.id || "").slice(0, 8);
              traceStore.append(sessionId, {
                method: "item/fileChange",
                params: { itemId: fileItemId, turnId: turn.id, changes: scanResult.changes },
              });
              traceCollector("item/fileChange", {
                itemId: fileItemId,
                turnId: turn.id,
                changes: scanResult.changes,
              });
            }
          } catch {
            /* best-effort */
          }

          const replayResult = replayTrace(sessionId);
          broadcastDerivedState(
            sessionId,
            replayResult.state as unknown as Record<string, unknown>,
          );
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
      res.end(
        JSON.stringify({
          error: String(err instanceof Error ? err.message : err),
        }),
      );
    }
    return;
  }
  // Returns immediately with sessionId; event collection runs in background.
  if (req.method === "POST" && req.url === "/run-stream") {
    try {
      const body = await parseBody(req);
      console.error(
        "[e2e-log] body=" +
          JSON.stringify({
            provider: body.provider,
            sandboxPolicy: body.sandboxPolicy,
            permissionMode: body.permissionMode,
            approvalPolicy: body.approvalPolicy,
          }),
      );
      const sessionId = randomUUID();
      const provider =
        typeof body.provider === "string" && ["codex", "claude-code"].includes(body.provider)
          ? body.provider
          : "claude-code";

      let sessionAdapter: ProviderAdapter;
      try {
        sessionAdapter = await getOrInitAdapter(provider as "codex" | "claude-code");
      } catch (initErr) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: initErr instanceof Error ? initErr.message : String(initErr),
          }),
        );
        return;
      }
      sessionAdapters.set(sessionId, sessionAdapter);

      const clientThreadId =
        typeof body.threadId === "string"
          ? body.threadId
          : `glassbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const prompt = typeof body.prompt === "string" ? body.prompt : "say ready";

      // --- P2.4: provider-aware options with server-side guardrails ---
      const defaultWs = defaultWorkspaceFor(provider);
      let workspace = typeof body.repoPath === "string" ? body.repoPath : defaultWs;
      const approvalPolicy =
        typeof body.approvalPolicy === "string"
          ? body.approvalPolicy
          : defaultApprovalPolicy(provider);
      const sandboxPolicyType =
        typeof body.sandboxPolicy === "string" ? body.sandboxPolicy : "read-only";
      const permissionMode =
        typeof body.permissionMode === "string" ? body.permissionMode : defaultPermissionMode();

      if (workspace !== defaultWs) {
        const pathCheck = validateRepoPath(workspace);
        if (!pathCheck.ok) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: pathCheck.error }));
          return;
        }
        workspace = pathCheck.realPath;
      }
      // --- end P2.4 ---

      const traceProvenance =
        provider === "claude-code" ? TRACE_PROVENANCE_CLAUDECODE : TRACE_PROVENANCE;
      const traceCollector = makeTraceCollector(sessionId, traceProvenance);
      const runOpts: SessionRunOptions = {
        provider,
        workspace,
        approvalPolicy,
        sandboxType: sandboxPolicyType,
        permissionMode,
      };

      recordSessionConfig(sessionId, traceCollector, {
        provider,
        permissionMode: provider === "claude-code" ? permissionMode : undefined,
        approvalPolicy: provider === "codex" ? approvalPolicy : undefined,
        sandboxPolicy: provider === "codex" ? sandboxPolicyType : undefined,
        repoPath: workspace,
      });

      const thread = await sessionAdapter.startSession(clientThreadId, sessionStartOpts(runOpts));
      sessionAdapters.set(thread.id, sessionAdapter);

      sessionAdapter.snapshotWorkspace(workspace);

      const turn = await sessionAdapter.startTurn(
        thread.id,
        [{ type: "text", text: prompt }],
        turnStartOpts(runOpts, workspace),
      );

      sessions.set(sessionId, {
        threadId: thread.id,
        clientThreadId,
        provider,
        workspace,
        runOptions: Object.freeze({ ...runOpts }),
        activeTurnId: turn.id,
        turnIds: [turn.id],
        pendingApprovals: [],
      });

      registerApprovalHandler(sessionId, (_itemId, _approved) => {
        // Default no-op: the /decide endpoint handles decisions explicitly
      });

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          sessionId,
          threadId: thread.id,
          turnId: turn.id,
          status: "running",
        }),
      );

      sessionAdapter
        .collectTurnEvents(thread.id, turn.id, 30_000, traceCollector)
        .then(() => {
          // S8: post-turn workspace scan for file changes omitted from events
          try {
            var scanResult = sessionAdapter.scanAndFireHooks(workspace);
            if (scanResult.changes.length > 0) {
              var fileItemId = "git-" + (turn.id || "").slice(0, 8);
              traceStore.append(sessionId, {
                method: "item/fileChange",
                params: { itemId: fileItemId, turnId: turn.id, changes: scanResult.changes },
              });
              traceCollector("item/fileChange", {
                itemId: fileItemId,
                turnId: turn.id,
                changes: scanResult.changes,
              });
            }
          } catch {
            /* best-effort */
          }

          const replayResult = replayTrace(sessionId);
          broadcastDerivedState(
            sessionId,
            replayResult.state as unknown as Record<string, unknown>,
          );
          broadcastSessionEnded(sessionId);
          const s = sessions.get(sessionId);
          if (s) s.activeTurnId = null;
        })
        .catch((err) => {
          console.error(`[run-stream background] session ${sessionId} failed:`, err);
        });
    } catch (err) {
      console.error(
        "[e2e-error] /run-stream FAILED:",
        err instanceof Error ? err.message : String(err),
      );
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: String(err instanceof Error ? err.message : err),
        }),
      );
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
        getSessionAdapter(threadId).registerOnTurnEnd((turnStatus) => {
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

        await getSessionAdapter(threadId).interruptTurn(threadId, activeTurnId as string);
        session.activeTurnId = null;

        // Wait for interrupted turn to finish and action.pause to be recorded
        await new Promise<void>((resolve) => {
          getSessionAdapter(threadId).registerOnTurnEnd((_status: string) => resolve());
        });
      }

      const replayResult = replayTrace(sessionId);
      broadcastDerivedState(sessionId, replayResult.state as unknown as Record<string, unknown>);

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          {
            ok: true,
            paused: !alreadyIdle,
            sessionId,
            derivedState: replayResult.state,
          },
          null,
          2,
        ),
      );
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: String(err instanceof Error ? err.message : err),
        }),
      );
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
        getSessionAdapter(threadId).registerOnTurnEnd((turnStatus) => {
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

        await getSessionAdapter(threadId).interruptTurn(threadId, activeTurnId as string);
        session.activeTurnId = null;

        // Wait for the turn to finish and action.stop to be recorded
        await new Promise<void>((resolve) => {
          getSessionAdapter(threadId).registerOnTurnEnd((_status: string) => resolve());
        });
      }

      const replayResult = replayTrace(sessionId);
      broadcastDerivedState(sessionId, replayResult.state as unknown as Record<string, unknown>);

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          {
            ok: true,
            stopped: !alreadyStopped,
            sessionId,
            derivedState: replayResult.state,
          },
          null,
          2,
        ),
      );
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: String(err instanceof Error ? err.message : err),
        }),
      );
    }
    return;
  }

  // ---- POST /steer — steering instruction for an existing session ----
  if (req.method === "POST" && req.url === "/steer") {
    try {
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
          getSessionAdapter(threadId).registerOnTurnEnd(() => resolve());
        });
        try {
          await getSessionAdapter(threadId).interruptTurn(threadId, activeTurnId);
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
      // @ts-ignore — TS inference bug: inferred type conflates with steerRecord.params
      const turnSummary = (await startNewTurn(
        session,
        instruction,
        session.workspace,
        traceCollector,
      )) as any;

      // Now that startNewTurn has returned, we know the actual turnId.
      // Patch the steer record with turnId so the reducer can backfill
      // the instruction text onto the correct turn record during replay.
      // @ts-expect-error — TS fails to propagate any / explicit cast from async return
      steerRecord.params.turnId = turnSummary.turnId;

      // Record action.steer AFTER the turn's provider events are in the trace
      traceStore.append(sessionId, steerRecord);
      broadcastEvent(sessionId, steerRecord.params);

      const replayResult = replayTrace(sessionId);
      broadcastDerivedState(sessionId, replayResult.state as unknown as Record<string, unknown>);

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          {
            ok: true,
            sessionId,
            derivedState: replayResult.state,
            turnId: turnSummary.turnId,
            turnStatus: turnSummary.turnStatus,
            turnDurationMs: turnSummary.turnDurationMs,
          },
          null,
          2,
        ),
      );
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: String(err instanceof Error ? err.message : err),
        }),
      );
    }
    return;
  }

  // ---- POST /send-task — edit task and start new turn on same thread ----
  if (req.method === "POST" && req.url === "/send-task") {
    try {
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
          getSessionAdapter(threadId).registerOnTurnEnd(() => resolve());
        });
        try {
          await getSessionAdapter(threadId).interruptTurn(threadId, activeTurnId);
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
      const _sendTurnSummary = (await startNewTurn(
        session,
        editedTask,
        session.workspace,
        traceCollector,
      )) as any;
      const sendTurnSummary = _sendTurnSummary;

      // Record action.send AFTER the turn's provider events are in the trace
      const sendRecord = {
        method: "action.send",
        params: {
          kind: "action.send",
          source: "glassbox-user",
          sessionId,
          threadId: session.threadId,
          turnId: sendTurnSummary.turnId,
          task: editedTask,
          ts: new Date().toISOString(),
        },
      };

      traceStore.append(sessionId, sendRecord);
      broadcastEvent(sessionId, sendRecord.params);

      const replayResult = replayTrace(sessionId);
      broadcastDerivedState(sessionId, replayResult.state as unknown as Record<string, unknown>);

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          {
            ok: true,
            sessionId,
            derivedState: replayResult.state,
            turnId: sendTurnSummary.turnId,
            turnStatus: sendTurnSummary.turnStatus,
            turnDurationMs: sendTurnSummary.turnDurationMs,
          },
          null,
          2,
        ),
      );
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: String(err instanceof Error ? err.message : err),
        }),
      );
    }
    return;
  }

  // ---- POST /edit-input — edit a research input and start new turn on same thread ---- //
  if (req.method === "POST" && req.url === "/edit-input") {
    try {
      const body = await parseBody(req);
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const inputKind = typeof body.inputKind === "string" ? body.inputKind : "";
      const value = typeof body.value === "string" ? body.value : "";

      if (!sessionId || !inputKind || value === undefined) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "sessionId, inputKind, and value required" }));
        return;
      }

      const session = sessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `no session: ${sessionId}` }));
        return;
      }

      // Codex does not support editing system instructions yet.
      if (session.provider === "codex") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: "input not supported for this provider yet: " + inputKind }),
        );
        return;
      }

      // Only systemInstruction is supported in P2.5.
      if (inputKind !== "systemInstruction") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unsupported inputKind: " + inputKind }));
        return;
      }

      const traceCollector = makeTraceCollector(sessionId);
      const threadId = session.threadId;

      // Set the new instruction on the adapter before starting the next turn
      (getSessionAdapter(threadId) as any).setAppendSystemPrompt(threadId, value);

      // If a turn is active, interrupt it first (bounded wait)
      if (session.activeTurnId) {
        const { activeTurnId } = session;
        const turnEnded = new Promise<void>((resolve) => {
          getSessionAdapter(threadId).registerOnTurnEnd(() => resolve());
        });
        try {
          await getSessionAdapter(threadId).interruptTurn(threadId, activeTurnId);
        } catch {
          // turn may already have finished
        }
        await Promise.race([
          turnEnded,
          new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
        ]);
        session.activeTurnId = null;
      }

      // Start the new turn on the same thread
      const editTurnSummary = await startNewTurn(
        session,
        "say ready",
        session.workspace,
        traceCollector,
      );

      // Record action.editInput AFTER the turn's provider events are in the trace
      const editRecord = {
        method: "action.editInput",
        params: {
          kind: "action.editInput",
          source: "glassbox-user",
          sessionId,
          threadId,
          turnId: editTurnSummary.turnId,
          inputKind,
          value,
          ts: new Date().toISOString(),
        },
      };
      traceStore.append(sessionId, editRecord);
      broadcastEvent(sessionId, editRecord.params);

      const replayResult = replayTrace(sessionId);
      broadcastDerivedState(sessionId, replayResult.state as unknown as Record<string, unknown>);

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          {
            ok: true,
            sessionId,
            derivedState: replayResult.state,
            turnId: editTurnSummary.turnId,
            turnStatus: editTurnSummary.turnStatus,
            turnDurationMs: editTurnSummary.turnDurationMs,
          },
          null,
          2,
        ),
      );
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: String(err instanceof Error ? err.message : err),
        }),
      );
    }
    return;
  }
  if (req.method === "POST" && req.url === "/run-demo") {
    try {
      const body = await parseBody(req);
      const sessionId = randomUUID();
      const clientThreadId =
        typeof body.threadId === "string"
          ? body.threadId
          : `demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const prompt =
        typeof body.prompt === "string" ? body.prompt : "update utils.js so the tests pass";

      // --- P2.4: provider-aware options with server-side guardrails ---
      const provider =
        typeof body.provider === "string" && ["codex", "claude-code"].includes(body.provider)
          ? body.provider
          : "codex";

      let sessionAdapter: ProviderAdapter;
      try {
        sessionAdapter = await getOrInitAdapter(provider as "codex" | "claude-code");
      } catch (initErr) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: initErr instanceof Error ? initErr.message : String(initErr),
          }),
        );
        return;
      }
      sessionAdapters.set(sessionId, sessionAdapter);

      const defaultWs = DEFAULT_WORKSPACE_DEMO;
      let workspace = typeof body.repoPath === "string" ? body.repoPath : defaultWs;
      const approvalPolicy =
        typeof body.approvalPolicy === "string" ? body.approvalPolicy : "on-request";
      const sandboxPolicyType =
        typeof body.sandboxPolicy === "string" ? body.sandboxPolicy : "workspace-write";
      const permissionMode = typeof body.permissionMode === "string" ? body.permissionMode : "auto";

      // Validate custom repo paths
      if (workspace !== defaultWs) {
        const pathCheck = validateRepoPath(workspace);
        if (!pathCheck.ok) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: pathCheck.error }));
          return;
        }
        workspace = pathCheck.realPath;
      }
      // --- end P2.4 ---

      const traceProvenance =
        provider === "claude-code" ? TRACE_PROVENANCE_CLAUDECODE : TRACE_PROVENANCE;
      const traceCollector = makeTraceCollector(sessionId, traceProvenance);

      const runOpts: SessionRunOptions = {
        provider,
        workspace,
        approvalPolicy,
        sandboxType: sandboxPolicyType,
        permissionMode,
      };

      // --- P2.4: record session.config in trace ---
      recordSessionConfig(sessionId, traceCollector, {
        provider,
        permissionMode: provider === "claude-code" ? permissionMode : undefined,
        approvalPolicy: provider === "codex" ? approvalPolicy : undefined,
        sandboxPolicy: provider === "codex" ? sandboxPolicyType : undefined,
        repoPath: workspace,
      });
      // --- end P2.4 ---

      const thread = await sessionAdapter.startSession(clientThreadId, sessionStartOpts(runOpts));

      // Reset the demo fixture so every run starts from the same broken
      // state (a previous run may have already fixed the file in place).
      writeFileSync(join(workspace, "utils.js"), BROKEN_UTILS_JS);
      sessionAdapters.set(thread.id, sessionAdapter);

      sessionAdapter.snapshotWorkspace(workspace);

      const turn = await sessionAdapter.startTurn(
        thread.id,
        [{ type: "text", text: prompt }],
        turnStartOpts(runOpts, workspace),
      );

      sessions.set(sessionId, {
        threadId: thread.id,
        clientThreadId,
        provider,
        workspace,
        runOptions: Object.freeze({ ...runOpts }),
        activeTurnId: turn.id,
        turnIds: [turn.id],
        pendingApprovals: [],
      });

      registerApprovalHandler(sessionId, (_itemId, _approved) => {
        // handled by /decide
      });

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          sessionId,
          threadId: thread.id,
          turnId: turn.id,
          workspace,
          status: "running",
        }),
      );

      sessionAdapter
        .collectTurnEvents(thread.id, turn.id, 30_000, traceCollector)
        .then(() => {
          // S8: post-turn workspace scan for file changes omitted from events
          try {
            var scanResult = sessionAdapter.scanAndFireHooks(workspace);
            if (scanResult.changes.length > 0) {
              var fileItemId = "git-" + (turn.id || "").slice(0, 8);
              traceStore.append(sessionId, {
                method: "item/fileChange",
                params: { itemId: fileItemId, turnId: turn.id, changes: scanResult.changes },
              });
              traceCollector("item/fileChange", {
                itemId: fileItemId,
                turnId: turn.id,
                changes: scanResult.changes,
              });
            }
          } catch {
            /* best-effort */
          }

          const replayResult = replayTrace(sessionId);
          broadcastDerivedState(
            sessionId,
            replayResult.state as unknown as Record<string, unknown>,
          );
          broadcastSessionEnded(sessionId);
          const s = sessions.get(sessionId);
          if (s) s.activeTurnId = null;
        })
        .catch((err) => {
          console.error(`[run-demo background] session ${sessionId} failed:`, err);
        });
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: String(err instanceof Error ? err.message : err),
        }),
      );
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
      session.pendingApprovals = session.pendingApprovals.filter((a) => a.itemId !== itemId);

      // Find the adapter requestId for this itemId and respond
      const requestId = getSessionAdapter(session.threadId).findApprovalRequestId(itemId);
      if (requestId !== null) {
        getSessionAdapter(session.threadId).respondToApproval(requestId, approved);
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
      res.end(
        JSON.stringify(
          {
            ok: true,
            sessionId,
            approved,
            removedPending: beforeCount - session.pendingApprovals.length,
            derivedState: replayResult.state,
          },
          null,
          2,
        ),
      );
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: String(err instanceof Error ? err.message : err),
        }),
      );
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
        // Screen entry params for secrets at the API boundary — raw trace on disk stays intact
        const screened = screenValue(trace) as TraceEntry[];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId, entries: screened }, null, 2));
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
        // Screen derived state for secrets at the API boundary
        const safeState = screenValue(result.state) as Record<string, unknown>;
        const safeReplay = { ...result, state: safeState };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ sessionId, derivedState: safeState, replay: safeReplay }, null, 2),
        );
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
      try {
        body = await parseBody(req);
      } catch {
        /* body optional */
      }

      // support either {sessionId} or {threadId, turnId}
      const sessionId = typeof body.sessionId === "string" ? (body.sessionId as string) : "";
      const threadId =
        typeof body.threadId === "string"
          ? body.threadId
          : sessionId
            ? sessions.get(sessionId)?.threadId
            : undefined;
      const turnId =
        typeof body.turnId === "string"
          ? body.turnId
          : sessionId
            ? sessions.get(sessionId)?.activeTurnId
            : undefined;

      if (!threadId || !turnId) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "no active turn — provide sessionId or threadId+turnId" }));
        return;
      }

      // If we can trace it, record the interrupt as an action
      if (sessionId) {
        getSessionAdapter(threadId).registerOnTurnEnd((turnStatus) => {
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

      await getSessionAdapter(threadId).interruptTurn(threadId, turnId);

      // Clear active turn from session if known
      if (sessionId) {
        const s = sessions.get(sessionId);
        if (s) s.activeTurnId = null;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, threadId, turnId }));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: String(err instanceof Error ? err.message : err),
        }),
      );
    }
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}

const server = http.createServer((req, res) => {
  void handleRequest(req, res).catch((error: unknown) => {
    req.resume();
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const status = error instanceof ManagementError ? error.status : 500;
    const code = error instanceof ManagementError ? error.code : "INTERNAL_ERROR";
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(
      JSON.stringify({
        error: {
          code,
          message: status === 401 ? "A management key is required" : "Request could not complete",
        },
      }),
    );
  });
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;

// ---- Mount WebSocket server ----

function mountSockets() {
  return attachWebSocketServer(
    server,
    (_sessionId: string) => {
      // S6 explicit execution: no auto-interrupt on WS subscribe.
      // /pause, /stop, and /steer endpoints handle execution changes explicitly.
      // WS subscription is read-only: receives live events and derived state only.
    },
    (sessionId: string) => {
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
    },
    (request) => {
      if (!management) throw new Error("Service is not ready");
      management.authorizeSocket(request);
    },
  );
}

let sockets: ReturnType<typeof mountSockets> | undefined;
let starting: Promise<{ baseUrl: string; credentialFile: string }> | undefined;
let shutdown: Promise<void> | undefined;

export function startServer(
  options: {
    port?: number;
    quiet?: boolean;
    databasePath?: string;
    piAgentDirectory?: string | null;
  } = {},
) {
  if (starting) return starting;
  starting = (async () => {
    const port = options.port ?? serverPort();
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
    const dataDirectory = getGlassboxDataDir();
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const origins = hosts.map((host) => `http://${host}`);
    origins.push("http://localhost:5173", "http://127.0.0.1:5173");
    management = await openManagementRuntime({
      dataDirectory,
      databasePath: options.databasePath,
      piAgentDirectory: options.piAgentDirectory,
      hosts,
      origins,
      status: () => ({
        service: "glassbox",
        version: "0.0.0",
        status: "ready",
        platform: process.platform,
        defaultExecution: "claude-code",
        capabilities: {
          modelConfiguration: true,
          channels: true,
          conversations: true,
          runs: true,
          trace: true,
          eval: true,
        },
      }),
      doctor: () => ({
        checks: ["claude", "codex"].map((command) => {
          try {
            const detected = resolveExecutablePath(command);
            return {
              id: command,
              label: command === "claude" ? "Claude Code" : "Codex",
              status: detected ? "detected" : "missing",
              message: detected
                ? "Executable detected. Login and execution have not been tested."
                : "Executable was not found.",
            };
          } catch {
            return {
              id: command,
              label: command,
              status: "error",
              message: "Executable discovery failed.",
            };
          }
        }),
      }),
    });
    try {
      for (const workspace of [
        DEFAULT_WORKSPACE_CODEX,
        DEFAULT_WORKSPACE_CLAUDE,
        DEFAULT_WORKSPACE_DEMO,
      ])
        mkdirSync(workspace, { recursive: true });
      sockets = mountSockets();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Server did not bind");
      management.setBoundPort(address.port);
      const result = {
        baseUrl: `http://127.0.0.1:${address.port}`,
        credentialFile: join(dataDirectory, "management-token"),
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      if (!options.quiet) console.log(JSON.stringify(result));
      return result;
    } catch (error) {
      await stopServer();
      throw error;
    }
  })().catch((error: unknown) => {
    starting = undefined;
    throw error;
  });
  return starting;
}

function stopAllAdapters(): void {
  for (const slot of providerSlots.values()) {
    try {
      slot.adapter.stop();
    } catch {}
  }
  providerSlots.clear();
}

function onSignal() {
  void stopServer().catch(() => {
    process.exitCode = 1;
  });
}

export function stopServer(): Promise<void> {
  if (shutdown) return shutdown;
  shutdown = (async () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    stopAllAdapters();
    sessionAdapters.clear();
    sessions.clear();
    if (sockets) {
      for (const client of sockets.clients) client.terminate();
      sockets.close();
      sockets = undefined;
    }
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await management?.close();
    management = undefined;
    starting = undefined;
  })().finally(() => {
    shutdown = undefined;
  });
  return shutdown;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startServer().catch(() => {
    console.error("Glassbox could not start. Check the port and data directory ownership.");
    process.exitCode = 1;
  });
}
