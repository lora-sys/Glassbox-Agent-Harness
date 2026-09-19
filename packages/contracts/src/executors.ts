/**
 * Public management contract for executors.
 * Provenance: Glassbox-Agent-Harness commit d6012f14b4792f710ad471026366c54a5b3af25d
 */
export interface ClaudeExecutorSettings {
  id: "claude-code";
  credentialSource: "local-claude" | "model-profile";
  modelProfileId: string | null;
  model: string | null;
}

export interface PublicExecutor extends ClaudeExecutorSettings {
  executableDetected: boolean;
  groupSupported: boolean;
  checking: boolean;
  tools: "none";
  lastCheck: { status: "passed" | "failed"; checkedAt: string; code?: string } | null;
}
