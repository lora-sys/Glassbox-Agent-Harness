import type { Options, Query, SDKMessage, tool } from "@anthropic-ai/claude-agent-sdk";
import type {
  ExecutionFailureCode,
  ExecutionInput,
  ExecutionResult,
  RunExecutionAdapter,
} from "../run-service/types.js";

export type HarnessFailureCode =
  | "INVALID_INPUT"
  | "EXECUTABLE_MISSING"
  | "EXECUTABLE_CHANGED"
  | "GROUP_ISOLATION_UNVERIFIED"
  | "ISOLATION_VIOLATION"
  | "CREDENTIAL_UNAVAILABLE"
  | "SPAWN_FAILED"
  | "PROVIDER_FAILED"
  | "OUTPUT_LIMIT"
  | "TIMED_OUT"
  | "EXIT_UNCONFIRMED"
  | "CODEX_ISOLATION_UNVERIFIED";

export class HarnessFailure extends Error {
  constructor(readonly code: HarnessFailureCode) {
    super(code);
    this.name = "HarnessFailure";
  }
}

/**
 * What a harness stage says about the runtime behind the Run.
 *
 * Every one of these stages ends a Run, and the harness codes distinguish "the external runtime
 * was engaged and failed" from "Glassbox refused to engage it". Mapping them in one place is
 * what keeps a failed Run from naming no cause at all: a later layer reading a cause-free
 * failure has to guess, and the guess it used to make was that the runtime was down.
 */
export function harnessFailureCause(code: HarnessFailureCode | undefined): ExecutionFailureCode {
  switch (code) {
    case undefined:
    // The stage named nothing, which is the one case that has to fall back on the conservative
    // answer: the external runtime was engaged and something went wrong that nobody classified.
    case "SPAWN_FAILED":
    case "PROVIDER_FAILED":
    case "OUTPUT_LIMIT":
    case "TIMED_OUT":
    case "ISOLATION_VIOLATION":
    case "EXIT_UNCONFIRMED":
      return "runtime_run_errored";
    case "INVALID_INPUT":
    case "EXECUTABLE_MISSING":
    case "EXECUTABLE_CHANGED":
    case "GROUP_ISOLATION_UNVERIFIED":
    case "CREDENTIAL_UNAVAILABLE":
    case "CODEX_ISOLATION_UNVERIFIED":
      return "gate_refused";
  }
}

export interface HarnessUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** SDK modelUsage totals are estimates, not billing statements. */
  source: "claude-sdk-model-usage";
}

export type HarnessEvent =
  | { type: "started"; runId: string }
  | { type: "text"; runId: string; text: string }
  | {
      type: "tool";
      runId: string;
      name: string;
      status: "started" | "completed" | "denied" | "failed";
    }
  | {
      type: "finished";
      runId: string;
      status: ExecutionResult["status"];
      usage: HarnessUsage | null;
      code?: HarnessFailureCode;
    };

/**
 * `ExecutionResult` is a union now, so the extra harness fields have to be distributed over its
 * members rather than appended to a flattened object — an `extends` would erase the
 * `status`/`failureCode` pairing that a failed Run is required to name.
 */
type WithHarnessFields<T> = T extends unknown ? T & HarnessResultFields : never;

interface HarnessResultFields {
  usage: HarnessUsage | null;
  code?: HarnessFailureCode;
}

export type HarnessResult = WithHarnessFields<ExecutionResult>;

export interface HarnessAdapter extends RunExecutionAdapter {
  readonly capabilities: {
    tools: "none" | "protected-mcp";
    resume: false;
    reason?: HarnessFailureCode;
  };
  execute(input: ExecutionInput): Promise<HarnessResult>;
}

export type ClaudeCredentialEnvironment = Partial<
  Record<"ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN" | "CLAUDE_CODE_OAUTH_TOKEN", string>
>;

export interface ProtectedHarnessTool {
  name: string;
  description: string;
  inputSchema: Parameters<typeof tool>[2];
  /** Both checks must resolve against current authority, including the output destination. */
  authorize(
    input: ExecutionInput,
    phase: "execute" | "publish-result",
    args: unknown,
  ): Promise<boolean>;
  /** Implementations own resource confinement and must honor signal before side effects. */
  execute(
    args: unknown,
    context: { input: ExecutionInput; workspace: string; signal: AbortSignal },
  ): Promise<string>;
}

export type HarnessQuery = Pick<Query, "close"> & AsyncIterable<SDKMessage>;
export type HarnessQueryFactory = (input: { prompt: string; options: Options }) => HarnessQuery;

export interface ClaudeHarnessOptions {
  dataDirectory: string;
  executionRef: string;
  /** Explicit installed executable only. The SDK bundled executable is never selected. */
  executablePath: string;
  /** Host resolves an authorized credential. Only these exact environment fields survive. */
  credentials(input: ExecutionInput): Promise<ClaudeCredentialEnvironment>;
  apiBaseUrl?: string;
  model?: string;
  systemPrompt?: string;
  protectedTools?: readonly ProtectedHarnessTool[];
  /** Host supplies this only after testing this installed binary and tool mode for group isolation. */
  groupIsolation?: { executableSha256: string; toolMode: "none" | "protected-mcp" };
  executionTimeoutMs?: number;
  exitTimeoutMs?: number;
  maxOutputBytes?: number;
  onEvent?(event: HarnessEvent): void | Promise<void>;
  /** Offline test seam; production uses the installed SDK query implementation. */
  query?: HarnessQueryFactory;
}
