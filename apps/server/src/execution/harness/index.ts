export { createClaudeHarnessAdapter, executableSha256 } from "./claude.js";
export { createCodexHarnessAdapter } from "./codex.js";
export type { CodexHarnessOptions, CodexHarnessAdapter, CodexProtectedTool } from "./codex-types.js";
export type {
  ClaudeHarnessOptions,
  HarnessAdapter,
  HarnessEvent,
  HarnessResult,
  HarnessUsage,
  ProtectedHarnessTool,
  ClaudeCredentialEnvironment,
} from "./types.js";

/** Codex remains available in the existing Owner Workbench. It is not connected to group Runs. */
export const CODEX_RUN_CAPABILITY = {
  implemented: true,
  supportsGroup: false,
  reason: "CODEX_ISOLATION_UNVERIFIED",
  detail:
    "Owner Run adapter uses a fresh CODEX_HOME and no native environment access. Protected dynamic tools are host-authorized. Real installed acceptance and group validation remain pending.",
} as const;
