// apps/server/src/codex/adapter.ts
// Spawns `codex app-server`, communicates via JSON-RPC 2.0 over stdio.

import { spawn, execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
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
import type {
  ProviderAdapter,
  RunResult,
  ScanResult,
  Session,
  SessionOpts,
  TurnOpts,
} from "../provider/types.js";
import { gitLsFiles, gitDiffForScan, type FileSnapshot } from "../platform/git.js";
import { resolveCodexExecutable } from "../platform/executable.js";

const REQUEST_TIMEOUT_MS = 30_000;

/** Optional owned transport boundary. Existing Workbench callers retain their launch configuration. */
export interface CodexTransportOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  launchArgs?: readonly string[];
  requireShellFree?: boolean;
  quiet?: boolean;
  maxFrameBytes?: number;
  onNotification?: (method: string, params: unknown) => void;
  onServerRequest?: (method: string, params: unknown) => Promise<unknown>;
  onExit?: () => void;
  onProtocolError?: () => void;
}

// ---------------------------------------------------------------------------
// Workspace git-diff scanning helpers (S8 artifact detection fallback)
// ---------------------------------------------------------------------------

interface LifecycleHooks {
  beforeSnapshot: FileSnapshot | null;
  afterHooks: Array<(scan: { changes: { path: string; kind: string; diff?: string }[] }) => void>;
}

/**
 * Run a single lifecycle hook asynchronously (fire-and-forget).
 */
function runHookAsync(
  hook: (scan: { changes: { path: string; kind: string; diff?: string }[] }) => void,
  scan: { changes: { path: string; kind: string; diff?: string }[] },
) {
  try {
    hook(scan);
  } catch {
    /* ignore hook errors */
  }
}

export class CodexAdapter extends EventEmitter implements ProviderAdapter {
  pid: number;
  private spawnError: Error | null = null;

  private child: ReturnType<typeof spawn> | null = null;
  private pendingRequests = new Map<
    number | string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private nextReqId = 1;
  private stdoutAccum = "";
  private closed = false;

  // Event collection state (set by collectTurnEvents, cleared when done)
  private collectors = new Set<(method: string, params: unknown) => void>();
  private _decodeFailCount = 0;

  // Subscribers notified when a turn ends (turn/completed received).
  private _turnEndSubscribers: Array<{ fn: (status: string) => void; threadId?: string }> = [];

  // Pending approval requests indexed by their server-assigned request id.
  private _pendingApprovals = new Map<
    number | string,
    {
      method: string;
      params: Record<string, unknown>;
    }
  >();

  // Per-turn workspace lifecycle hooks (S8: git diff scanning for artifacts)
  private _lifecycleLatch: LifecycleHooks = {
    beforeSnapshot: null,
    afterHooks: [],
  };

  // Effect-backed event decoder (optional: may be null in minimal builds).

  /** Enable or disable the Effect Schema decode gate. Default: false.
   *  Codex-internal debug only — not part of ProviderAdapter. */
  setDecodeEnabled(enabled: boolean): void {
    void enabled;
  }

  /** Number of decode failures observed since the last reset.
   *  Codex-internal debug only — not part of ProviderAdapter. */
  get decodeFailCount(): number {
    return this._decodeFailCount;
  }

  /** Register a callback that fires when the next turn/completed event is received. */
  registerOnTurnEnd(fn: (status: string) => void, threadId?: string): void {
    this._turnEndSubscribers.push({ fn, threadId });
  }

  /** Fire and clear all turn-end subscribers (called from the event handler). */
  private _fireTurnEnd(status: string, threadId: string): void {
    const subs = this._turnEndSubscribers.filter((entry) => !entry.threadId || entry.threadId === threadId);
    this._turnEndSubscribers = this._turnEndSubscribers.filter((entry) => entry.threadId && entry.threadId !== threadId);
    for (const { fn } of subs) {
      try {
        fn(status);
      } catch {
        /* ignore subscriber errors */
      }
    }
  }

  // ── Per-turn workspace lifecycle hooks (S8) ───────────────────────────

  /** Register a callback to fire after the next turn, with workspace diff results. */
  addLifecycleHook(
    fn: (scan: { changes: { path: string; kind: string; diff?: string }[] }) => void,
  ): () => void {
    this._lifecycleLatch.afterHooks.push(fn);
    return () => {
      this._lifecycleLatch.afterHooks = this._lifecycleLatch.afterHooks.filter((h) => h !== fn);
    };
  }

  /** Capture the current workspace file-hash snapshot before a turn begins. */
  snapshotWorkspace(workspace: string): void {
    this._lifecycleLatch.beforeSnapshot = gitLsFiles(workspace);
  }

  /** Scan the workspace for changes since snapshot, fire lifecycle hooks, reset. */
  scanAndFireHooks(workspace: string): ScanResult {
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

  constructor(
    private codexPath = process.env.CODEX_BINARY_PATH ?? "codex",
    private readonly transport: CodexTransportOptions = {},
  ) {
    super();
    this.pid = 0;
  }

  // ---- Lifecycle ----

  start(): void {
    if (this.child) return;
    this.closed = false;
    this.spawnError = null;

    const resolved = resolveCodexExecutable({
      binaryPath: this.codexPath,
      env: this.transport.env,
    });
    if (!resolved || (this.transport.requireShellFree && resolved.shell)) {
      this.spawnError = new Error(
        `Codex executable not found at "${this.codexPath}". Ensure codex is installed and in PATH, or set CODEX_BINARY_PATH.`,
      );
      this.closed = true;
      throw this.spawnError;
    }

    try {
      this.child = spawn(
        resolved.command,
        [...resolved.args, ...(this.transport.launchArgs ?? [])],
        {
          stdio: ["pipe", "pipe", "pipe"],
          shell: resolved.shell,
          windowsHide: true,
          env: this.transport.env,
          cwd: this.transport.cwd,
        },
      );
    } catch (err) {
      this.spawnError = err instanceof Error ? err : new Error(String(err));
      this.closed = true;
      throw this.spawnError;
    }

    this.pid = this.child.pid ?? 0;
    this.child.stdin?.on("error", () => {
      this.rejectAllPending(new Error("Codex input stream closed"));
    });

    this.child.stderr?.on("data", (data: Buffer) => {
      if (!this.transport.quiet)
        console.error(`[codex:${this.pid} stderr] ${data.toString().trimEnd()}`);
    });

    this.child.on("error", (err) => {
      this.spawnError = err;
      this.rejectAllPending(err);
      if (!this.child?.pid) this.transport.onExit?.();
    });

    this.child.on("exit", () => {
      if (!this.closed) {
        this.rejectAllPending(new Error("codex app-server process exited"));
        this.closed = true;
      }
      this.transport.onExit?.();
    });

    const decoder = new TextDecoder();
    this.child.stdout?.on("data", (raw: Buffer) => {
      this.stdoutAccum += decoder.decode(raw, { stream: true });
      if (
        Buffer.byteLength(this.stdoutAccum, "utf8") >
        (this.transport.maxFrameBytes ?? 4 * 1024 * 1024)
      ) {
        this.stdoutAccum = "";
        this.rejectAllPending(new Error("Codex protocol frame limit exceeded"));
        this.transport.onProtocolError?.();
        this.child?.kill("SIGTERM");
        return;
      }
      const lines = this.stdoutAccum.split("\n");
      this.stdoutAccum = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          this.dispatchMessage(JSON.parse(trimmed) as JsonRpcMessage);
        } catch {
          if (!this.transport.quiet) console.error(`[codex:${this.pid}] non-json stdout`);
          this.transport.onProtocolError?.();
        }
      }
    });
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.collectors.clear();
    this._turnEndSubscribers = [];
    this.rejectAllPending(new Error("codex adapter stopped"));
    if (this.child) {
      const pidToKill = this.pid;
      try {
        this.child.removeAllListeners();
        if (process.platform === "win32" && pidToKill > 0) {
          try {
            execFileSync("taskkill.exe", ["/pid", String(pidToKill), "/T", "/F"], {
              stdio: "ignore",
              windowsHide: true,
            });
          } catch {
            this.child.kill("SIGTERM");
          }
        } else {
          this.child.kill("SIGTERM");
        }
      } catch {
        // already gone
      }
      this.child = null;
    }
    this.pid = 0;
  }

  /** Wait for real child exit. Abort acknowledgement and a sent signal are not exit evidence. */
  async shutdownAndWait(timeoutMs = 3000): Promise<boolean> {
    const child = this.child;
    if (!child) return true;
    this.closed = true;
    this.rejectAllPending(new Error("Codex transport shutdown"));
    if (child.exitCode !== null || child.signalCode || (!child.pid && this.spawnError)) return true;
    const ended = new Promise<boolean>((resolve) => {
      child.once("exit", () => resolve(true));
      child.once("error", () => {
        if (!child.pid) resolve(true);
      });
    });
    const wait = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          ended,
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    child.stdin?.end();
    if (await wait()) return true;
    child.kill("SIGTERM");
    if (await wait()) return true;
    if (process.platform === "win32" && child.pid) {
      try {
        execFileSync("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
          timeout: timeoutMs,
        });
      } catch {
        child.kill("SIGKILL");
      }
    } else child.kill("SIGKILL");
    return wait();
  }

  /** Harness integrations share this transport instead of maintaining a second JSON-RPC client. */
  requestProtocol(method: string, params: unknown): Promise<unknown> {
    return this.sendRequest(method, params);
  }

  // ---- ProviderAdapter surface ----

  /** Initialize connection. Must be called once before other methods. */
  async initialize(): Promise<ServerInfo> {
    if (this.spawnError) {
      throw new Error(`Codex process failed to start: ${this.spawnError.message}`);
    }
    const result = await this.sendRequest("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: { experimentalApi: true },
      clientInfo: { name: "glassbox-server", title: null, version: "0.1.0" },
    });
    // Send initialized notification (fire-and-forget, no response)
    this.sendNotification("initialized");
    return result as ServerInfo;
  }

  /** Start a session (Codex: thread). Returns the provider-assigned session object. */
  async startSession(clientSessionId: string, opts: SessionOpts = {}): Promise<Session> {
    const result = await this.sendRequest("thread/start", {
      threadId: clientSessionId, // wire-level name
      cwd: opts.cwd ?? null,
      sandbox: (opts as Record<string, unknown> & { sandbox?: string }).sandbox ?? "read-only",
      approvalPolicy:
        (opts as Record<string, unknown> & { approvalPolicy?: string }).approvalPolicy ??
        "on-request",
    });
    return { id: (result as { thread: Thread }).thread.id };
  }

  /** Start a turn on an existing session. */
  async startTurn(sessionId: string, input: UserInput[], opts: TurnOpts = {}): Promise<Turn> {
    const wireOpts: Record<string, unknown> = { threadId: sessionId, input };
    if (opts.cwd) wireOpts.cwd = opts.cwd;
    const sp = opts as Record<string, unknown> & { sandboxPolicy?: SandboxPolicy };
    if (sp.sandboxPolicy) wireOpts.sandboxPolicy = sp.sandboxPolicy;

    // Fire before-hooks (e.g. workspace snapshot) right after the server receives the request
    if (opts.cwd && this._lifecycleLatch.afterHooks.length > 0) {
      this.snapshotWorkspace(opts.cwd);
    }

    const result = await this.sendRequest("turn/start", wireOpts);
    return (result as { turn: Turn }).turn;
  }

  /** Interrupt a running turn. */
  async interruptTurn(sessionId: string, turnId: string): Promise<void> {
    await this.sendRequest("turn/interrupt", { threadId: sessionId, turnId });
  }

  /** Collect all events from a turn until turn/completed or timeout. */
  async collectTurnEvents(
    sessionId: string,
    turnId: string,
    timeoutMs: number,
    traceCollector?: (method: string, params: Record<string, unknown>) => void,
  ): Promise<RunResult> {
    const counts: Record<string, number> = {};
    const approvals: ApprovalEvent[] = [];
    let agentMessageDeltas = 0;
    let turnStatus: TurnStatus = "inProgress";
    let turnDurationMs: number | null = null;
    let error: string | undefined;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.collectors.delete(handler);
        resolve();
      };
      const timer = setTimeout(() => {
        error = "OBSERVATION_TIMED_OUT";
        // Preserve the evidence sink until a real terminal event or transport stop.
        resolve();
      }, timeoutMs);
      const handler = (method: string, params: unknown) => {
        if (!params || typeof params !== "object") return;
        const raw = params as Record<string, unknown>;
        const turn =
          raw.turn && typeof raw.turn === "object"
            ? (raw.turn as Record<string, unknown>)
            : undefined;
        const eventTurnId = raw.turnId ?? turn?.id;
        if (raw.threadId !== sessionId || eventTurnId !== turnId) return;
        counts[method] = (counts[method] ?? 0) + 1;
        traceCollector?.(method, raw);
        if (method === "item/agentMessage/delta") agentMessageDeltas++;
        if (method.endsWith("/requestApproval")) {
          const ev: ApprovalEvent = {
            type: "approval",
            method,
            threadId: sessionId,
            turnId,
            itemId: typeof raw.itemId === "string" ? raw.itemId : "",
            startedAtMs: Date.now(),
            reason: null,
            grantRoot: null,
            action: "pending",
          };
          approvals.push(ev);
          this.emit("approval", ev);
        }
        if (
          method === "turn/completed" &&
          turn &&
          ["completed", "failed", "interrupted"].includes(String(turn.status))
        ) {
          turnStatus = turn.status as TurnStatus;
          turnDurationMs = typeof turn.durationMs === "number" ? turn.durationMs : null;
          if (turn.error) error = "PROVIDER_FAILED";
          finish();
        }
      };
      this.collectors.add(handler);
    });
    return {
      sessionId,
      turnId,
      eventCounts: { ...counts },
      turnStatus,
      turnDurationMs,
      approvals: [...approvals],
      agentMessageDeltas,
      ...(error ? { error } : {}),
    };
  }

  // ---- Internal helpers (not on ProviderAdapter) ----

  /** Convenience: start a turn and collect its events. Codex-internal only. */
  async startAndCollectTurn(
    threadId: string,
    input: UserInput[],
    timeoutMs: number,
    traceCollector?: (method: string, params: Record<string, unknown>) => void,
    opts: { sandboxPolicy?: SandboxPolicy; cwd?: string } = {},
  ): Promise<RunTestSummary> {
    const params: Record<string, unknown> = { threadId, input };
    if (opts.sandboxPolicy) params.sandboxPolicy = opts.sandboxPolicy;
    if (opts.cwd) params.cwd = opts.cwd;

    const buffered: Array<[string, unknown]> = [];
    let overflow = false;
    const buffer = (method: string, value: unknown) => {
      if (!value || typeof value !== "object" || (value as Record<string, unknown>).threadId !== threadId) return;
      if (buffered.length >= 128 || Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) overflow = true;
      else buffered.push([method, value]);
    };
    this.collectors.add(buffer);
    try {
      const result = await this.sendRequest("turn/start", params);
      const turn = (result as { turn: Turn }).turn;
      if (overflow) throw new Error("Codex initial event buffer exceeded");
      this.collectors.delete(buffer);
      const collecting = this.collectTurnEvents(threadId, turn.id, timeoutMs, traceCollector);
      for (const [method, value] of buffered) {
        for (const collector of this.collectors) collector(method, value);
      }
      const summary = await collecting;
      return { ...summary, turnId: turn.id, threadId };
    } finally {
      this.collectors.delete(buffer);
    }
  }

  // ---- Protocol internals ----

  private sendNotification(method: string): void {
    if (this.closed || !this.child?.stdin || this.child.stdin.destroyed) return;
    try {
      const msg = { jsonrpc: "2.0", method } as const;
      this.child.stdin.write(JSON.stringify(msg) + "\n");
    } catch {
      // ignore write error for notifications
    }
  }

  private async sendRequest(method: string, params: unknown): Promise<unknown> {
    if (this.spawnError) {
      return Promise.reject(new Error(`Codex process error: ${this.spawnError.message}`));
    }
    if (this.closed) {
      return Promise.reject(new Error("codex adapter is closed"));
    }
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      return Promise.reject(new Error("codex child process stdin is not available"));
    }

    const id = this.nextReqId++;
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} (id=${id}) timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timer });
      try {
        this.child!.stdin!.write(JSON.stringify(msg) + "\n");
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private sendResponse(requestId: number | string, result: unknown): void {
    if (this.closed || !this.child?.stdin || this.child.stdin.destroyed) return;
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, result }) + "\n");
    } catch {
      // ignore write error for responses
    }
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

  private handleServerRequest(id: number | string, method: string, params: unknown): void {
    if (this.transport.onServerRequest) {
      void this.transport.onServerRequest(method, params).then(
        (result) => this.sendResponse(id, result),
        () => {
          this.transport.onProtocolError?.();
          // An unknown request never receives a permissive generic acknowledgement.
          this.child?.stdin?.write(
            JSON.stringify({ id, error: { code: -32601, message: "Request denied" } }) + "\n",
          );
        },
      );
      return;
    }
    // Approval requests: do NOT auto-approve. Store the request id so the
    // /decide endpoint can respond later when the user makes a choice.
    if (method.endsWith("requestApproval")) {
      for (const collector of this.collectors) collector(method, params);
      const rawParams: Record<string, unknown> =
        typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
      this._pendingApprovals.set(id, { method, params: rawParams });
      return;
    }

    // Generic ack for other server-initiated requests we don't handle yet
    this.sendResponse(id, null);
  }

  private emitNotification(method: string, params: unknown): void {
    if (method === "turn/completed" && params && typeof params === "object") {
      const value = params as Record<string, unknown>;
      const turn = value.turn && typeof value.turn === "object" ? value.turn as Record<string, unknown> : undefined;
      if (typeof value.threadId === "string" && ["completed", "interrupted", "failed"].includes(String(turn?.status))) {
        this._fireTurnEnd(String(turn!.status), value.threadId);
      }
    }
    // Forward to any active event collector
    this.transport.onNotification?.(method, params);
    for (const collector of this.collectors) collector(method, params);
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
