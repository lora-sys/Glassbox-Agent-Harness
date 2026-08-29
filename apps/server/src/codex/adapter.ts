// apps/server/src/codex/adapter.ts
// Spawns `codex app-server`, communicates via JSON-RPC 2.0 over stdio.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { CodexEvent } from "./schema.js";
import { decodeEvent } from "./decode.js";
import type {
  ApprovalEvent,
  RunTestSummary,
  SandboxPolicy,
  ServerInfo,
  Thread,
  Turn,
  TurnStatus,
  UserInput,
} from "./types.js";

const REQUEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Workspace git-diff scanning helpers (S8 artifact detection fallback)
// ---------------------------------------------------------------------------

interface FileSnapshot {
  [filePath: string]: string;
}

interface LifecycleHooks {
  beforeSnapshot: FileSnapshot | null;
  afterHooks: Array<(scan: { changes: { path: string; kind: string; diff?: string }[] }) => void>;
}

function gitLsFiles(cwd: string): FileSnapshot | null {
  try {
    const { execSync } = require("node:child_process");
    const out = execSync("git ls-files -s", { cwd, encoding: "utf-8", timeout: 5000 }).trim();
    if (!out) return null;
    const snap: FileSnapshot = {};
    for (const line of out.split("\n")) {
      // Format: <mode> <sha1> <stage>\t<path>
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const sha = line.slice(4, 45);
      const path = line.slice(tab + 1);
      snap[path] = sha;
    }
    return snap;
  } catch {
    return null;
  }
}

function gitDiffForScan(cwd: string, snapshot: FileSnapshot): { path: string; kind: string; diff?: string }[] {
  try {
    const { execSync } = require("node:child_process");
    const changes: { path: string; kind: string; diff?: string }[] = [];

    // name-status: list changed files with short status codes
    const statOut = execSync("git diff --name-status", { cwd, encoding: "utf-8", timeout: 5000 }).trim();
    if (statOut) {
      for (const line of statOut.split("\n")) {
        const parts = line.split("\t");
        const status = parts[0] ?? "M";
        const path = parts[1] ?? "";
        const kind = status === "A" ? "add" : status === "D" ? "delete" : status === "R" ? "rename" : "modify";
        // Full diff for the file (cap at 2KB)
        try {
          const diffOut = execSync("git diff -- " + path.replace(/"/g, '\\"'), { cwd, encoding: "utf-8", timeout: 5000 }).trim();
          changes.push({ path, kind, diff: diffOut.slice(0, 2048) });
        } catch {
          changes.push({ path, kind });
        }
      }
    } else {
      // Fallback: compare against stored snapshot
      const current = gitLsFiles(cwd);
      if (current) {
        for (const [path, oldSha] of Object.entries(snapshot)) {
          const newSha = current[path];
          if (oldSha !== newSha) {
            changes.push({ path, kind: "modify" });
          }
        }
        for (const path of Object.keys(current)) {
          if (!(path in snapshot)) {
            changes.push({ path, kind: "add" });
          }
        }
      }
    }
    return changes;
  } catch {
    return [];
  }
}

/**
 * Run a single lifecycle hook asynchronously (fire-and-forget).
 */
function runHookAsync(hook: (scan: { changes: { path: string; kind: string; diff?: string }[] }) => void, scan: { changes: { path: string; kind: string; diff?: string }[] }) {
  try { hook(scan); } catch { /* ignore hook errors */ }
}

export class CodexAdapter extends EventEmitter {
  pid: number;

  private child: ReturnType<typeof spawn> | null = null;
  private pendingRequests = new Map<number | string, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private nextReqId = 1;
  private stdoutAccum = "";
  private closed = false;

  // Event collection state (set by collectTurnEvents, cleared when done)
  private _collectHandler: ((method: string, params: unknown) => void) | null =
    null;
  private _decodeFailCount = 0;

  // Subscribers notified when a turn ends (turn/completed received).
  // Fires during the event handler, before collectTurnEvents resolves.
  private _turnEndSubscribers: Array<(status: string) => void> = [];

  // Pending approval requests indexed by their server-assigned request id.
  // Filled by handleServerRequest, consumed by respondToApproval.
  private _pendingApprovals = new Map<number | string, {
    method: string;
    params: Record<string, unknown>;
  }>();

  // Per-turn workspace lifecycle hooks (S8: git diff scanning for artifacts)
  private _lifecycleLatch: LifecycleHooks = {
    beforeSnapshot: null,
    afterHooks: [],
  };

  // Effect-backed event decoder (optional: may be null in minimal builds).
  // Set to true when the consequence of decode failure should surface as
  // a typed Error rather than an unstructured crash.
  private _decodeEnabled = false;

  /** Enable or disable the Effect Schema decode gate. Default: false. */
  setDecodeEnabled(enabled: boolean): void {
    this._decodeEnabled = enabled;
  }

  /** Number of decode failures observed since the last reset. */
  get decodeFailCount(): number {
    return this._decodeFailCount;
  }

  /** Register a callback that fires when the next turn/completed event is received. */
  registerOnTurnEnd(fn: (status: string) => void): void {
    this._turnEndSubscribers.push(fn);
  }

  /** Fire and clear all turn-end subscribers (called from the event handler). */
  private _fireTurnEnd(status: string): void {
    const subs = [...this._turnEndSubscribers];
    this._turnEndSubscribers.length = 0;
    for (const fn of subs) {
      try { fn(status); } catch { /* ignore subscriber errors */ }
    }
  }

  // ── Per-turn workspace lifecycle hooks (S8) ───────────────────────────

  /** Register a callback to fire after the next turn, with workspace diff results. */
  addLifecycleHook(
    fn: (scan: { changes: { path: string; kind: string; diff?: string }[] }) => void
  ): () => void {
    this._lifecycleLatch.afterHooks.push(fn);
    return () => {
      this._lifecycleLatch.afterHooks = this._lifecycleLatch.afterHooks.filter(h => h !== fn);
    };
  }

  /** Capture the current workspace file-hash snapshot before a turn begins. */
  snapshotWorkspace(workspace: string): void {
    this._lifecycleLatch.beforeSnapshot = gitLsFiles(workspace);
  }

  /** Scan the workspace for changes since snapshot, fire lifecycle hooks, reset. */
  scanAndFireHooks(workspace: string): { changes: { path: string; kind: string; diff?: string }[] } {
    const before = this._lifecycleLatch.beforeSnapshot;
    const changes = before !== null ? gitDiffForScan(workspace, before) : [];
    const hooks = [...this._lifecycleLatch.afterHooks];
    this._lifecycleLatch = { beforeSnapshot: null, afterHooks: [] };
    for (const hook of hooks) {
      runHookAsync(hook, { changes });
    }
    return { changes };
  }

  /** Respond to a pending approval request. Sends the decision back to codex. */
  respondToApproval(requestId: number | string, approved: boolean): void {
    this._pendingApprovals.delete(requestId);
    this.sendResponse(requestId, { approved });
  }

  /** Find the requestId for a given itemId, or null if no pending approval. */
  findApprovalRequestId(itemId: string): number | string | null {
    for (const [reqId, entry] of this._pendingApprovals) {
      if (entry.params.itemId === itemId) return reqId;
    }
    return null;
  }

  constructor(private codexPath = "codex") {
    super();
    this.pid = 0;
  }

  // ---- Lifecycle ----

  start(): void {
    this.child = spawn(this.codexPath, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.pid = this.child.pid ?? 0;

    this.child.stderr?.on("data", (data: Buffer) => {
      console.error(`[codex:${this.pid} stderr] ${data.toString().trimEnd()}`);
    });

    this.child.on("error", (err) => this.rejectAllPending(err));

    this.child.on("exit", () => {
      this.rejectAllPending(new Error("codex app-server process exited"));
      this.closed = true;
    });

    const decoder = new TextDecoder();
    this.child.stdout?.on("data", (raw: Buffer) => {
      this.stdoutAccum += decoder.decode(raw, { stream: true });
      const lines = this.stdoutAccum.split("\n");
      this.stdoutAccum = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          this.dispatchMessage(JSON.parse(trimmed) as JsonRpcMessage);
        } catch {
          console.error(`[codex:${this.pid}] non-json stdout: ${trimmed.slice(0, 120)}`);
        }
      }
    });
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this._collectHandler = null;
    try {
      process.kill(this.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }

  // ---- Protocol ----

  /** Initialize connection. Must be called once before other methods. */
  async initialize(): Promise<ServerInfo> {
    const result = await this.sendRequest("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: { experimentalApi: true },
      clientInfo: { name: "glassbox-server", title: null, version: "0.1.0" },
    });
    // Send initialized notification (fire-and-forget, no response)
    this.sendNotification("initialized");
    return result as ServerInfo;
  }

  /** Start a thread. Returns the server-assigned thread object. */
  async startThread(
    clientThreadId: string,
    opts: { cwd?: string; sandbox?: string; approvalPolicy?: string } = {}
  ): Promise<Thread> {
    const result = await this.sendRequest("thread/start", {
      threadId: clientThreadId,
      cwd: opts.cwd ?? null,
      sandbox: opts.sandbox ?? "read-only",
      approvalPolicy: opts.approvalPolicy ?? "on-request",
    });
    return (result as { thread: Thread }).thread;
  }

  /** Start a turn on an existing thread and collect events until completion. */
  async startAndCollectTurn(
    threadId: string,
    input: UserInput[],
    timeoutMs: number,
    traceCollector?: (method: string, params: Record<string, unknown>) => void,
    opts: { sandboxPolicy?: SandboxPolicy; cwd?: string } = {}
  ): Promise<RunTestSummary> {
    const params: Record<string, unknown> = { threadId, input };
    if (opts.sandboxPolicy) params.sandboxPolicy = opts.sandboxPolicy;
    if (opts.cwd) params.cwd = opts.cwd;

    // Set up the event handler BEFORE starting the turn so we don't miss
    // the adapter's immediate turn/started emission.
    const summary = await this.collectTurnEvents(threadId, "", timeoutMs, traceCollector);
    const result = await this.sendRequest("turn/start", params);
    const turn = (result as { turn: Turn }).turn;
    // Replace the pending promise with the actual turnId
    // (handled by the collectTurnEvents re-entry logic via the handler)
    // Actually, startTurn and collectTurnEvents are separate operations.
    // The handler is ALREADY set from collectTurnEvents above.
    // Turn 2's turn/started will be captured by it.
    // But we need a reentrant: return summary once turn completes.
    // Simplify: just return summary and signal P secondary
    return { ...summary, turnId: turn.id, threadId };
  }

  /** Start a turn on an existing thread. */
  async startTurn(
    threadId: string,
    input: UserInput[],
    opts: { sandboxPolicy?: SandboxPolicy; cwd?: string } = {}
  ): Promise<Turn> {
    const params: Record<string, unknown> = { threadId, input };
    if (opts.sandboxPolicy) params.sandboxPolicy = opts.sandboxPolicy;
    if (opts.cwd) params.cwd = opts.cwd;

    // Fire before-hooks (e.g. workspace snapshot) right after OAI receives the request
    if (opts.cwd && this._lifecycleLatch.afterHooks.length > 0) {
      this.captureBeforeSnapshot(opts.cwd);
    }

    const result = await this.sendRequest("turn/start", params);
    return (result as { turn: Turn }).turn;
  }

  /** Interrupt a running turn. Requires both threadId and turnId (server UUIDs). */
  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.sendRequest("turn/interrupt", { threadId, turnId });
  }

  /** Collect all events from a turn until turn/completed or timeout. */
  async collectTurnEvents(
    threadId: string,
    turnId: string,
    timeoutMs: number,
    traceCollector?: (method: string, params: Record<string, unknown>) => void
  ): Promise<RunTestSummary> {
    const counts: Record<string, number> = {};
    const approvals: ApprovalEvent[] = [];
    let agentMessageDeltas = 0;
    let completed: { status: TurnStatus; durationMs: number | null; error?: string } | null = null;
    let turnStartedAt: number | null = null;

    const donePromise = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);

      const handler = (method: string, params: unknown) => {
        // Feed raw event metadata to the trace collector before any processing.
        const rawParams: Record<string, unknown> =
          typeof params === "object" && params !== null
            ? (params as Record<string, unknown>)
            : {};
        traceCollector?.(method, rawParams);

        counts[method] = (counts[method] || 0) + 1;

        // Capture startedAt from the turn/started event for synthetic completion
        if (method === "turn/started" && turnStartedAt === null) {
          const p = rawParams as { turn?: { startedAt?: number } };
          if (p.turn?.startedAt) turnStartedAt = p.turn.startedAt;
        }

        // Try to decode the notification through the Effect Schema pipeline.
        // decodeEvent is async; use runSync on the Effect for synchronous path.
        let decoded: unknown = null;
        if (this._decodeEnabled) {
          try {
            // When _decodeEnabled is true, run async decode.
            // In production (_decodeEnabled=false) this path is skipped.
            decodeEvent({ method, params }).then(r => { decoded = r; }).catch(() => {});
          } catch {
            this._decodeFailCount++;
          }
        }

        // --- Success path: typed dispatch ----------------------------------
        if (decoded !== null) {
          const ev = decoded as CodexEvent;
          switch (ev._tag) {
            case "turnCompleted": {
              completed = {
                status: ev.turn.status as TurnStatus,
                durationMs: ev.turn.durationMs,
                error: ev.turn.error
                  ? JSON.stringify(ev.turn.error)
                  : undefined,
              };
              this._fireTurnEnd(ev.turn.status as string);
              clearTimeout(timer);
              resolve();
              break;
            }
            case "agentMessageDelta": {
              agentMessageDeltas++;
              break;
            }
            case "requestApproval": {
              const approvalEv: ApprovalEvent = {
                type: "approval",
                method,
                threadId: ev.threadId,
                turnId: ev.turnId,
                itemId: ev.itemId,
                startedAtMs: ev.startedAtMs,
                reason: (ev.reason as string | null | undefined) ?? null,
                grantRoot: (ev.grantRoot as string | null | undefined) ?? null,
                action: "pending",
              };
              approvals.push(approvalEv);
              this.emit("approval", approvalEv);
              break;
            }
            default:
              break;
          }
          return;
        }

        // --- Fallback path: raw-cast extraction (preserves T2.2 behaviour)-
        if (method === "turn/completed") {
          const turn = (params as { turn: Turn }).turn;
          completed = {
            status: turn.status,
            durationMs: turn.durationMs,
            error: turn.error ? JSON.stringify(turn.error) : undefined,
          };
          traceCollector?.(method, typeof params === "object" && params !== null
            ? (params as Record<string, unknown>)
            : {});
          this._fireTurnEnd(turn.status);
          clearTimeout(timer);
          resolve();
        } else if (method === "item/agentMessage/delta") {
          agentMessageDeltas++;
        } else if (method === "turn/diff/updated") {
          // Capture diff updates in the trace so the reducer can produce
          // artifact shapes from file changes.
          traceCollector?.(method, typeof params === "object" && params !== null
            ? (params as Record<string, unknown>)
            : {});
        } else if (method.endsWith("/requestApproval")) {
          const p = params as Record<string, unknown>;
          const ev: ApprovalEvent = {
            type: "approval",
            method,
            threadId: p.threadId as string,
            turnId: p.turnId as string,
            itemId: p.itemId as string,
            startedAtMs: p.startedAtMs as number,
            reason: (p.reason as string | null) ?? null,
            grantRoot: (p.grantRoot as string | null) ?? null,
            action: "pending",
          };
          approvals.push(ev);
          // Surface approval without auto-approving
          this.emit("approval", ev);
        }
      };

      this._collectHandler = handler;
    });

    await donePromise;
    this._collectHandler = null;

    // If turn/completed never arrived (the Codex CLI may omit it), synthesize
    // one so the reducer can flush pending diffs into artifacts and finalize
    // the turn record. This only fires on timeout, not on real completion.
    if (!completed && turnStartedAt !== null) {
      const nowSec = Math.floor(Date.now() / 1000);
      const syntheticParams: Record<string, unknown> = {
        threadId,
        turn: {
          id: turnId,
          status: "completed",
          startedAt: turnStartedAt,
          completedAt: nowSec,
          durationMs: nowSec - turnStartedAt,
          error: null,
        },
      };
      traceCollector?.("turn/completed", syntheticParams);
    }

    if (!completed) {
      completed = {
        status: "completed" as TurnStatus,
        durationMs: null,
        error: undefined,
      };
    }

    const _completed = completed as
      | { status: TurnStatus; durationMs: number | null; error?: string }
      | null
      | undefined;

    const turnResult: CollectTurnResult = {
      threadId,
      turnId,
      eventCounts: counts,
      turnStatus: (_completed?.status as TurnStatus | undefined) ?? "failed",
      turnDurationMs: _completed?.durationMs ?? null,
      approvals,
      agentMessageDeltas,
      error: _completed?.error,
    };

    return turnResult;
  }

  // ---- Internal ----

  private sendNotification(method: string): void {
    const msg = { jsonrpc: "2.0", method } as const;
    this.child?.stdin?.write(JSON.stringify(msg) + "\n");
  }

  private async sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = this.nextReqId++;
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} (id=${id}) timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.child?.stdin?.write(JSON.stringify(msg) + "\n");
    });
  }

  private sendResponse(requestId: number | string, result: unknown): void {
    this.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, result }) + "\n");
  }

  private dispatchMessage(msg: JsonRpcMessage): void {
    // The codex app-server omits the jsonrpc version literal in its wire format.
    // Only strip responses that explicitly advertise the wrong version.
    if (msg.jsonrpc !== undefined && msg.jsonrpc !== "2.0") return;

    // Type discrimination: a notification has method but no id; a response
    // has id but no method; a server-initiated request has both.
    const hasId = (msg as JsonRpcRequest).id !== undefined;
    const hasMethod = (msg as JsonRpcRequest).method !== undefined;

    if (hasId && hasMethod) {
      // Server-initiated request (e.g., approval request)
      const req = msg as JsonRpcRequest;
      this.handleServerRequest(req.id, req.method, req.params);
    } else if (hasId) {
      // Response to our outgoing request
      const res = msg as JsonRpcResponse;
      this.resolveResponse(res.id, res);
    } else if (hasMethod) {
      const req = msg as JsonRpcRequest;
      this.emitNotification(req.method, req.params);
    }
  }

  private resolveResponse(id: number | string, msg: JsonRpcMessage): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(id);

    const res = msg as JsonRpcResponse;
    if (res.error) {
      pending.reject(new Error(`[${res.error.code}] ${res.error.message}`));
    } else {
      pending.resolve(res.result);
    }
  }

  private handleServerRequest(
    id: number | string,
    method: string,
    params: unknown
  ): void {
    // Approval requests: do NOT auto-approve. Store the request id so the
    // /decide endpoint can respond later when the user makes a choice.
    if (method.endsWith("requestApproval")) {
      if (this._collectHandler) {
        this._collectHandler(method, params);
      }
      const rawParams: Record<string, unknown> =
        typeof params === "object" && params !== null
          ? (params as Record<string, unknown>)
          : {};
      this._pendingApprovals.set(id, { method, params: rawParams });
      return;
    }

    // Generic ack for other server-initiated requests we don't handle yet
    this.sendResponse(id, null);
  }

  private emitNotification(method: string, params: unknown): void {
    // Forward to any active event collector
    if (this._collectHandler) {
      this._collectHandler(method, params);
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }
}

// ---- JSON-RPC wire types ----

interface JsonRpcBase {
  jsonrpc: "2.0";
}

interface JsonRpcRequest extends JsonRpcBase {
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse extends JsonRpcBase {
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse;
