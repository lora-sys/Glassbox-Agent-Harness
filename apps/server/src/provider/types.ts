import type {
  ServerInfo,
  Turn,
  TurnStatus,
  UserInput,
  ApprovalEvent,
} from "../codex/types.js";

/** A session as returned by the provider (Codex: "thread"). */
export interface Session {
  id: string;
}

/** Options for starting a session. `cwd` is universal; additional keys are
 *  provider-specific (e.g. Codex "sandbox" / "approvalPolicy"). */
export interface SessionOpts {
  cwd?: string;
  [key: string]: unknown;
}

/** Options for starting a turn. `cwd` is universal; additional keys are
 *  provider-specific (e.g. Codex "sandboxPolicy"). */
export interface TurnOpts {
  cwd?: string;
  [key: string]: unknown;
}

/** Result of scanning the workspace for changes since the last snapshot. */
export interface ScanResult {
  changes: { path: string; kind: string; diff?: string }[];
}

/** Summary of a turn execution cycle. */
export interface RunResult {
  sessionId: string;
  turnId: string;
  eventCounts: Record<string, number>;
  turnStatus: TurnStatus;
  turnDurationMs: number | null;
  approvals: ApprovalEvent[];
  agentMessageDeltas: number;
  error?: string;
}

/** Minimal adapter surface shared across providers.

 *  Methods intentionally left on CodexAdapter only (not in this interface):
 *  - setDecodeEnabled / decodeFailCount: Codex Effect-Schema debug gating
 *  - startAndCollectTurn: codex-internal convenience, not called by the runtime
 */
export interface ProviderAdapter {
  start(): void;
  stop(): void;
  initialize(): Promise<ServerInfo>;

  startSession(clientSessionId: string, opts?: SessionOpts): Promise<Session>;
  startTurn(sessionId: string, input: UserInput[], opts?: TurnOpts): Promise<Turn>;
  interruptTurn(sessionId: string, turnId: string): Promise<void>;

  collectTurnEvents(
    sessionId: string,
    turnId: string,
    timeoutMs: number,
    traceCollector?: (method: string, params: Record<string, unknown>) => void
  ): Promise<RunResult>;

  registerOnTurnEnd(fn: (status: string) => void): void;

  on(event: "approval", handler: (ev: ApprovalEvent) => void): void;
  respondToApproval(requestId: number | string, approved: boolean): void;
  findApprovalRequestId(itemId: string): number | string | null;

  snapshotWorkspace(workspace: string): void;
  scanAndFireHooks(workspace: string): ScanResult;
}
