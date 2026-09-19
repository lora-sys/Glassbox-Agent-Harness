import type { ExecutionInput, RunExecutionAdapter } from "../run-service/types.js";
import type { HarnessEvent, HarnessResult, ProtectedHarnessTool } from "./types.js";

export interface CodexProtectedTool extends Pick<
  ProtectedHarnessTool,
  "name" | "description" | "authorize" | "execute"
> {
  /** JSON Schema supplied by the owned tool, without external references. */
  inputSchema: Record<string, unknown>;
  /** Host-owned argument validation before authorization and execution. */
  parseArguments(value: unknown): unknown;
}

export interface CodexHarnessOptions {
  dataDirectory: string;
  executionRef: string;
  executablePath: string;
  credentials(input: ExecutionInput): Promise<{ apiKey: string }>;
  hostEnvironment?: Readonly<Record<string, string | undefined>>;
  model?: string;
  protectedTools?: readonly CodexProtectedTool[];
  onEvent?(event: HarnessEvent): void | Promise<void>;
  executionTimeoutMs?: number;
  exitTimeoutMs?: number;
  maxOutputBytes?: number;
}

export interface CodexHarnessAdapter extends RunExecutionAdapter {
  supportsGroup: false;
  capabilities: { tools: "none" | "protected-dynamic"; resume: false };
  execute(input: ExecutionInput): Promise<HarnessResult>;
}
