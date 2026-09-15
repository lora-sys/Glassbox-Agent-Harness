import type { Options, Query, SDKMessage, tool } from "@anthropic-ai/claude-agent-sdk";
import type { ExecutionInput, ExecutionResult, RunExecutionAdapter } from "../run-service/types.js";

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

export interface HarnessResult extends ExecutionResult {
  usage: HarnessUsage | null;
  code?: HarnessFailureCode;
}

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
  /** Only SystemRoot and WINDIR are read, even when a caller passes process.env. */
  hostEnvironment?: Readonly<Record<string, string | undefined>>;
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
