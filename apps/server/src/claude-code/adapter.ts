// apps/server/src/claude-code/adapter.ts
// ClaudeCodeAdapter: Provider adapter using the Anthropic Agent SDK (query).
//
// Spawn model:
//   1. Call `query()` from @anthropic-ai/claude-agent-sdk, which handles
//      subprocess management, stdio, and event streaming internally.
//   2. Consume the SDKMessage async iterator for event normalization.
//   3. Surface tool_use prompts via a canUseTool callback that defers to
//      the Glassbox decision flow via /decide.
//   4. Session state (resume IDs) is tracked internally for cross-turn resume.
//
// Write scoping:
//   cwd from session opts + permission mode + canUseTool. No OS sandbox
//   in Phase 2. See AGENTS.md for the guarantee gap.

import { query, type PermissionResult, type PermissionMode, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type {
  ProviderAdapter,
  Session,
  SessionOpts,
  TurnOpts,
  RunResult,
  ScanResult,
} from "../provider/types.js";
import type { ServerInfo, Turn, UserInput, ApprovalEvent } from "../codex/types.js";

// ---------------------------------------------------------------------------
// Direct trace write helper — bypasses async channel to guarantee
// thread/started and turn/started survive to the JSONL file even when
// the for-await loop's event routing causes async buffering.
// ---------------------------------------------------------------------------

import { mkdirSync, appendFileSync, readFileSync } from "node:fs";

function ensureTraceDir(sessionId: string): void {
  const base = `/data/lora/repos/Glassbox-Agent-Harness/.glassbox/sessions/${sessionId}`;
  mkdirSync(base, { recursive: true });
}

function nextSeq(sessionId: string): number {
  try {
    const content = readFileSync(
      `/data/lora/repos/Glassbox-Agent-Harness/.glassbox/sessions/${sessionId}/trace.jsonl`,
      "utf-8"
    );
    return content.split("\n").filter((l) => l.trim()).length + 1;
  } catch { return 1; }
}

function writeTraceDirect(sessionId: string, event: unknown, provenance: string): void {
  ensureTraceDir(sessionId);
  const seq = nextSeq(sessionId);
  const ts = new Date().toISOString();
  const line = JSON.stringify({ seq, ts, event, provenance }) + "\n";
  appendFileSync(
    `/data/lora/repos/Glassbox-Agent-Harness/.glassbox/sessions/${sessionId}/trace.jsonl`,
    line,
    "utf-8"
  );
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Permission mode mapping (Glassbox convention -> Claude SDK literal)
// TODO: wire from session opts. Currently hardcoded to "default" while the
// mapping table (supervised→default, auto-accept-edits→acceptEdits, auto→auto,
// full-access→bypassPermissions) is prepared here for Phase 2 wiring.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Internal session / turn state
// ---------------------------------------------------------------------------

interface PendingApproval {
  itemId: string;
  toolName: string;
  resolve: ((approved: boolean) => void) | null;
  timer: ReturnType<typeof setTimeout>;
}

interface SessionState {
  sdkSessionId: string | undefined;
  resumeSessionId: string | undefined;
  lastAssistantUuid: string | undefined;
  pendingApprovals: Map<string, PendingApproval>;
  pendingPrompt: string | null;
  cwd: string;
  permissionMode: string;
}

interface TurnState {
  turnId: string;
  startedAt: number;
  aborted: boolean;
  traceEmitted?: boolean;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class ClaudeCodeAdapter implements ProviderAdapter {
  private sessions = new Map<string, SessionState & { turn?: TurnState }>();
  private _info: ServerInfo;

  private approvalHandlers: Array<(ev: ApprovalEvent) => void> = [];
  private turnEndSubscribers: Array<(status: string) => void> = [];

  private _lifecycleLatch: {
    beforeSnapshot: FileSnapshot | null;
    afterHooks: Array<(scan: { changes: { path: string; kind: string; diff?: string }[] }) => void>;
  } = {
    beforeSnapshot: null,
    afterHooks: [],
  };

  constructor() {
    this._info = {
      userAgent: "claude-code-cli",
      codexHome: "n/a",
      platformFamily: "claude-code",
      platformOs: process.platform,
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async initialize(): Promise<ServerInfo> {
    return this._info;
  }

  start(): void {
    // No persistent process: query() spawns per-session.
  }

  stop(): void {
    this.sessions.clear();
    this.turnEndSubscribers = [];
    this.approvalHandlers = [];
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  async startSession(clientSessionId: string, _opts: SessionOpts = {}): Promise<Session> {
    this.sessions.set(clientSessionId, {
      sdkSessionId: clientSessionId,
      resumeSessionId: undefined,
      lastAssistantUuid: undefined,
      pendingApprovals: new Map(),
      pendingPrompt: null,
      cwd: typeof _opts.cwd === "string" ? _opts.cwd : "/tmp",
      permissionMode: typeof _opts.permissionMode === "string" ? _opts.permissionMode : "default",
    });
    return { id: clientSessionId };
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  async startTurn(
    sessionId: string,
    input: UserInput[],
    _opts: TurnOpts = {}
  ): Promise<Turn> {
    const text = input.map((u) => (u.type === "text" ? u.text : "")).join("");
    const turn = this.ensureTurn(sessionId);

    const s = this.sessions.get(sessionId)!;
    s.pendingPrompt = text;

    return {
      id: turn.turnId,
      status: "inProgress",
      items: [],
      itemsView: "",
      error: null,
      startedAt: turn.startedAt,
      completedAt: null,
      durationMs: null,
    };
  }

  async interruptTurn(sessionId: string, _turnId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s?.turn) {
      s.turn.aborted = true;
    }
  }

  // -------------------------------------------------------------------------
  // Event collection
  // -------------------------------------------------------------------------

  async collectTurnEvents(
    sessionId: string,
    turnId: string,
    _timeoutMs: number,
    traceCollector?: (method: string, params: Record<string, unknown>) => void
  ): Promise<RunResult> {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return this.makeResult(sessionId, turnId, { status: "failed", durationMs: 0, error: "no session" });
    }

    const turn = this.ensureTurn(sessionId, turnId);
    const cwd = state.cwd;
    const mode: PermissionMode = state.permissionMode as PermissionMode;

    const approvals: ApprovalEvent[] = [];
    let agentMessageCount = 0;
    const counts: Record<string, number> = {};
    let completed:
      | { status: "completed" | "interrupted" | "failed"; durationMs: number; error?: string }
      | null = null;

    const canUseTool: CanUseTool = this.buildCanUseTool(approvals, turn, sessionId);

    const q = query({
      prompt: state.pendingPrompt ?? "say ready",
      options: {
        cwd,
        permissionMode: mode,
        canUseTool,
        tools: { type: "preset" as const, preset: "claude_code" as const },
        systemPrompt: {
          type: "preset" as const,
          preset: "claude_code" as const,
          append: "",
        },
      } as Parameters<typeof query>[0]["options"],
    } as unknown as Parameters<typeof query>[0]);

    try {
      let threadStartedEmitted = false;

      for await (const msg of q) {
        const m = msg as Record<string, unknown>;
        counts[m.type as string] = (counts[m.type as string] || 0) + 1;

        if (traceCollector) {
          traceCollector(`sdk:${m.type as string}`, {
            session_id: m.session_id as string | undefined,
            subtype: m.subtype as string | undefined,
          });
        }

        switch (m.type) {
          case "system": {
            const sub = m.subtype as string | undefined;
            if (sub === "init") {
              const sid = m.session_id as string | undefined;
              if (sid) state.sdkSessionId = sid;
              // Emit thread/started so replayTrace knows a session began
              if (traceCollector && !threadStartedEmitted) {
                threadStartedEmitted = true;
                const tsThread = { sessionId, threadId: sessionId, ts: Date.now() };
                traceCollector("thread/started", tsThread);
                try { writeTraceDirect(sessionId, { method: "thread/started", params: tsThread }, "claude-code-cli"); } catch {}
              }
            }
            break;
          }

          case "assistant": {
            agentMessageCount++;
            if (typeof m.uuid === "string") {
              state.lastAssistantUuid = m.uuid;
            }
            // Emit turn/started on first assistant message of the turn
            if (traceCollector && !turn.traceEmitted) {
              turn.traceEmitted = true;
              const tsTurn = {
                threadId: sessionId,
                turn: { id: turn.turnId },
                input: typeof state.pendingPrompt === "string" ? [{ type: "text", text: state.pendingPrompt }] : [],
                startedAtMs: turn.startedAt,
              };
              traceCollector("turn/started", tsTurn);
              try { writeTraceDirect(sessionId, { method: "turn/started", params: tsTurn }, "claude-code-cli"); } catch {}
            }
            const message = msg as { message?: { content?: Array<Record<string, unknown>> } };
            if (message.message?.content) {
              for (const block of message.message.content as Array<Record<string, unknown>>) {
                if (block.type === "tool_use" && traceCollector) {
                  traceCollector("item/started", {
                    item: { type: "tool", id: block.id as string, name: block.name as string, input: block.input },
                    threadId: sessionId,
                    turnId: turn.turnId,
                    startedAtMs: Date.now(),
                  });
                } else if (block.type === "text" && traceCollector) {
                  traceCollector("item/agentMessage/delta", {
                    threadId: sessionId,
                    turnId: turn.turnId,
                    itemId: "agent-0",
                    delta: block.text as string,
                  });
                }
              }
            }
            break;
          }

          case "user": {
            const umsg = msg as { message?: { content?: Array<Record<string, unknown>> } };
            if (umsg.message?.content) {
              for (const block of umsg.message.content as Array<Record<string, unknown>>) {
                if (block.type === "tool_result" && traceCollector) {
                  const isError = block.is_error === true;
                  traceCollector("item/completed", {
                    item: {
                      type: "tool",
                      id: block.tool_use_id as string,
                      status: isError ? "failed" : "completed",
                      aggregatedOutput: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
                    },
                    threadId: sessionId,
                    turnId: turn.turnId,
                    completedAtMs: Date.now(),
                  });
                }
              }
            }
            break;
          }

          case "result": {
            const rmsg = msg as {
              subtype: string;
              is_error: boolean;
              duration_ms?: number;
              errors?: string[];
              result?: string;
              total_cost_usd?: number;
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                cache_read_input_tokens?: number;
              };
              modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; costUSD?: number }>;
            };
            const isError = rmsg.subtype === "error_during_execution" || rmsg.is_error;
            const durationMs = (typeof rmsg.duration_ms === "number" ? rmsg.duration_ms : Date.now() - turn.startedAt) as number;

            if (turn.aborted) {
              completed = { status: "interrupted", durationMs };
            } else if (isError) {
              const err = Array.isArray(rmsg.errors)
                ? rmsg.errors.find((e: string) => !e.startsWith("[ede_diagnostic]")) ?? rmsg.result
                : rmsg.result;
              completed = { status: "failed", durationMs, error: typeof err === "string" ? err : String(err) };
            } else {
              completed = { status: "completed", durationMs };
            }

            if (traceCollector) {
              traceCollector("turn/completed", {
                threadId: sessionId,
                turn: {
                  id: turn.turnId,
                  status: completed!.status,
                  startedAt: Math.floor(turn.startedAt / 1000),
                  completedAt: Math.floor(Date.now() / 1000),
                  durationMs: completed!.durationMs,
                  error: completed!.error ?? null,
                },
              });

              // Emit token usage so both providers feed the same reducer case.
              // Prefer aggregated modelUsage (cumulative across models), fall back
              // to single-turn usage.
              const usage = rmsg.usage ?? {};
              const modelEntries = rmsg.modelUsage ? Object.values(rmsg.modelUsage) : [];
              let aggInput = 0, aggOutput = 0, aggCost = 0;
              for (const m of modelEntries) {
                aggInput += m.inputTokens ?? 0;
                aggOutput += m.outputTokens ?? 0;
                aggCost += m.costUSD ?? 0;
              }
              const inputTokens = aggInput || usage.input_tokens || undefined;
              const outputTokens = aggOutput || usage.output_tokens || undefined;
              const costUsd = rmsg.total_cost_usd ?? (aggCost || undefined);

              if (inputTokens || outputTokens || rmsg.total_cost_usd) {
                traceCollector("thread/tokenUsage/updated", {
                  threadId: sessionId,
                  turnId: turn.turnId,
                  tokenUsage: {
                    total: {
                      totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
                      inputTokens: inputTokens ?? 0,
                      outputTokens: outputTokens ?? 0,
                    },
                  },
                  costUsd,
                });
              }
            }
            this.turnEndSubscribers.forEach((fn) => fn(completed!.status));
            this.turnEndSubscribers = [];
            break;
          }

          case "tool_progress":
          case "rate_limit_event":
            // Telemetry only.
            break;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - turn.startedAt;
      completed = {
        status: turn.aborted ? "interrupted" : "failed",
        durationMs,
        error: msg,
      };
      if (!completed) return this.makeResult(sessionId, turn.turnId, { status: "failed", durationMs, error: msg }, counts, approvals, agentMessageCount);

      if (traceCollector) {
        traceCollector("turn/completed", {
          threadId: sessionId,
          turn: {
            id: turn.turnId,
            status: completed!.status,
            startedAt: Math.floor(turn.startedAt / 1000),
            completedAt: Math.floor(Date.now() / 1000),
            durationMs: completed!.durationMs,
            error: completed!.error ?? null,
          },
        });
      }
      this.turnEndSubscribers.forEach((fn) => fn(completed!.status));
      this.turnEndSubscribers = [];
    } finally {
      // Clean up pending approval timers.
      for (const [, pa] of state.pendingApprovals) {
        clearTimeout(pa.timer);
      }
      state.pendingApprovals.clear();
    }

    return this.makeResult(sessionId, turn.turnId, completed ?? { status: "failed", durationMs: 0 }, counts, approvals, agentMessageCount);
  }

  // -------------------------------------------------------------------------
  // canUseTool factory — captures per-turn approval list via closure
  // -------------------------------------------------------------------------

  private buildCanUseTool(
    turnApprovals: ApprovalEvent[],
    turn: TurnState & { turnId: string },
    sessionId: string
  ): CanUseTool {
    return async (_toolName: string, _input: Record<string, unknown>, options: {
      signal: AbortSignal;
      toolUseID: string;
      title?: string;
      decisionReason?: string;
    }): Promise<PermissionResult | null> => {
      const toolUseId = options.toolUseID;

      const approvalEvent: ApprovalEvent = {
        type: "approval",
        method: "canUseTool",
        threadId: sessionId,
        turnId: turn.turnId,
        itemId: toolUseId,
        startedAtMs: Date.now(),
        reason: options.decisionReason ?? null,
        grantRoot: null,
        action: "pending",
      };

      turnApprovals.push(approvalEvent);

      const state = this.sessions.get(sessionId);
      if (!state) {
        return { behavior: "deny", message: "no session" };
      }

      const pending: PendingApproval = {
        itemId: toolUseId,
        toolName: _toolName,
        resolve: null,
        timer: setTimeout(() => {
          if (pending.resolve) pending.resolve(false); // fail-closed
          pending.resolve = null;
          approvalEvent.action = "declined";
        }, 120_000),
      };

      state.pendingApprovals.set(toolUseId, pending);
      this.approvalHandlers.forEach((fn) => fn(approvalEvent));

      return new Promise<PermissionResult | null>((resolve) => {
        pending.resolve = (approved: boolean) => {
          clearTimeout(pending.timer);
          state.pendingApprovals.delete(toolUseId);
          approvalEvent.action = approved ? "pending" : "declined";
          resolve(approved ? { behavior: "allow", updatedPermissions: [] } : { behavior: "deny", message: "denied by user" });
        };
      });
    };
  }

  // -------------------------------------------------------------------------
  // Approval flow
  // -------------------------------------------------------------------------

  registerOnTurnEnd(fn: (status: string) => void): void {
    this.turnEndSubscribers.push(fn);
  }

  on(_event: "approval", handler: (ev: ApprovalEvent) => void): void {
    this.approvalHandlers.push(handler);
  }

  respondToApproval(requestId: number | string, approved: boolean): void {
    const key = String(requestId);
    for (const session of this.sessions.values()) {
      const pending = session.pendingApprovals.get(key);
      if (pending && pending.resolve) {
        pending.resolve(approved);
        pending.resolve = null;
        clearTimeout(pending.timer);
        return;
      }
    }
  }

  findApprovalRequestId(itemId: string): number | string | null {
    for (const session of this.sessions.values()) {
      if (session.pendingApprovals.has(itemId)) return itemId;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Workspace lifecycle hooks (S8 artifact detection)
  // -------------------------------------------------------------------------

  snapshotWorkspace(workspace: string): void {
    this._lifecycleLatch.beforeSnapshot = gitLsFiles(workspace);
  }

  scanAndFireHooks(workspace: string): ScanResult {
    const before = this._lifecycleLatch.beforeSnapshot;
    const changes = before !== null ? gitDiffForScan(workspace, before) : [];
    const hooks = [...this._lifecycleLatch.afterHooks];
    this._lifecycleLatch = { beforeSnapshot: null, afterHooks: [] };
    for (const hook of hooks) {
      try { hook({ changes }); } catch { /* ignore hook errors */ }
    }
    return { changes };
  }

  // -------------------------------------------------------------------------
  // Result helper
  // -------------------------------------------------------------------------

  private makeResult(
    sessionId: string,
    turnId: string,
    result: { status: "completed" | "interrupted" | "failed"; durationMs: number; error?: string },
    counts: Record<string, number> = {},
    approvals: ApprovalEvent[] = [],
    agentMessageDeltas = 0,
  ): RunResult {
    return {
      sessionId,
      turnId,
      eventCounts: counts,
      turnStatus: result.status,
      turnDurationMs: result.durationMs,
      approvals,
      agentMessageDeltas,
      error: result.error,
    };
  }

  // -------------------------------------------------------------------------
  // Turn/session state helpers
  // -------------------------------------------------------------------------

  private ensureTurn(sessionId: string, turnId?: string): TurnState & { turnId: string } {
    let s = this.sessions.get(sessionId);
    if (!s) {
      const tid = turnId ?? crypto.randomUUID();
      this.sessions.set(sessionId, {
        sdkSessionId: sessionId,
        resumeSessionId: undefined,
        lastAssistantUuid: undefined,
        pendingApprovals: new Map(),
        pendingPrompt: null,
        cwd: "/tmp",
        permissionMode: "default",
        turn: { turnId: tid, startedAt: Date.now(), aborted: false },
      });
      return (this.sessions.get(sessionId) as SessionState & { turn: TurnState }).turn;
    }
    if (!s.turn) {
      s.turn = { turnId: turnId ?? crypto.randomUUID(), startedAt: Date.now(), aborted: false };
    }
    return s.turn;
  }
}

// ---------------------------------------------------------------------------
// Git diff scanning helpers (S8 artifact detection fallback)
// Mirrors CodexAdapter.ts exactly.
// ---------------------------------------------------------------------------

interface FileSnapshot {
  [filePath: string]: string;
}

function gitLsFiles(cwd: string): FileSnapshot | null {
  try {
    const { execSync } = require("node:child_process");
    const out = execSync("git ls-files -s", { cwd, encoding: "utf-8", timeout: 5000 }).trim();
    if (!out) return null;
    const snap: FileSnapshot = {};
    for (const line of out.split("\n")) {
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
    const statOut = execSync("git diff --name-status", { cwd, encoding: "utf-8", timeout: 5000 }).trim();
    if (statOut) {
      for (const line of statOut.split("\n")) {
        const parts = line.split("\t");
        const status = parts[0] ?? "M";
        const path = parts[1] ?? "";
        const kind = status === "A" ? "add" : status === "D" ? "delete" : status === "R" ? "rename" : "modify";
        try {
          const diffOut = execSync("git diff -- " + path.replace(/"/g, '\\"'), { cwd, encoding: "utf-8", timeout: 5000 }).trim();
          changes.push({ path, kind, diff: diffOut.slice(0, 2048) });
        } catch {
          changes.push({ path, kind });
        }
      }
    } else {
      const current = gitLsFiles(cwd);
      if (current) {
        for (const [p, oldSha] of Object.entries(snapshot)) {
          if (oldSha !== current[p]) changes.push({ path: p, kind: "modify" });
        }
        for (const p of Object.keys(current)) {
          if (!(p in snapshot)) changes.push({ path: p, kind: "add" });
        }
      }
    }
    return changes;
  } catch {
    return [];
  }
}
