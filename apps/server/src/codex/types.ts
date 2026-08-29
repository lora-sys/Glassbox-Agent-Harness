// apps/server/src/codex/types.ts
// Minimal TypeScript types for the Codex app-server protocol.
// Effect Schema adoption is deferred to T2.3.

/** Codex app-server info returned by initialize. */
export interface ServerInfo {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

/** Client identification sent in initialize. */
export interface ClientInfo {
  name: string;
  title: string | null;
  version: string;
}

/** Turn execution status. */
export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

/** A turn returned by the server. */
export interface Turn {
  id: string;
  status: TurnStatus;
  items: ThreadItem[];
  itemsView: string;
  error: Record<string, unknown> | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

/** A thread returned by the server. */
export interface Thread {
  id: string;
  sessionId: string;
  status: { type: string };
  cwd: string;
}

/** User message input. */
export type UserInput = {
  type: "text";
  text: string;
};

/** Sandbox policy for thread/turn start. */
export type SandboxPolicy =
  | { type: "readOnly"; networkAccess: boolean }
  | { type: "workspaceWrite"; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean }
  | { type: "dangerFullAccess" };

/** Discriminated union of thread items from the event stream. */
export type ThreadItem =
  | {
      type: "agentMessage";
      id: string;
      text: string;
      phase: string | null;
    }
  | {
      type: "userMessage";
      id: string;
      content: UserInput[];
    }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      status: string;
      aggregatedOutput: string | null;
    }
  | {
      type: "fileChange";
      id: string;
      changes: unknown[];
      status: string;
    }
  | {
      type: "mcpToolCall";
      id: string;
      server: string;
      tool: string;
      status: string;
      result: unknown | null;
      error: unknown | null;
    }
  | {
      type: "reasoning";
      id: string;
      summary: string[];
      content: string[];
    };

/** Approval request surfaced by the adapter (never auto-approved). */
export interface ApprovalEvent {
  type: "approval";
  method: string;
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs: number;
  reason: string | null;
  grantRoot: string | null;
  action: "pending" | "declined";
}

/** Summary returned by POST /run-test. */
export interface RunTestSummary {
  threadId: string;
  turnId: string;
  eventCounts: Record<string, number>;
  turnStatus: TurnStatus;
  turnDurationMs: number | null;
  approvals: ApprovalEvent[];
  agentMessageDeltas: number;
  error?: string;
}
