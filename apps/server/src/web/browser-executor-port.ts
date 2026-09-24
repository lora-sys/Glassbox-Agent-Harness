import type { BrowserSessionBinding } from "./browser-session.js";

export interface BrowserArtifactReference {
  id: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface BrowserExecutorResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  artifact?: BrowserArtifactReference;
}

export interface BrowserExecutorLimits {
  timeoutMs: number;
  maxOutputChars: number;
  maxArtifactBytes: number;
}

/** A capability scoped to one server-bound browser session. */
export interface BrowserExecutionSession {
  execute(args: readonly string[], limits: BrowserExecutorLimits): Promise<BrowserExecutorResult>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

/** The executor owns process/container details; callers only receive this narrow session port. */
export interface BrowserExecutorPort {
  open(binding: BrowserSessionBinding, sessionId: string): Promise<BrowserExecutionSession>;
}
