/**
 * Public management contracts for models, status, and health.
 * Provenance: Glassbox-Agent-Harness commit d6012f14b4792f710ad471026366c54a5b3af25d
 */
export const MODEL_PROTOCOLS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
] as const;

export type ModelProtocol = (typeof MODEL_PROTOCOLS)[number];

export interface PublicModelProfile {
  id: string;
  label: string;
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  credentialConfigured: boolean;
}

export interface ManagementFailure {
  error: { code: string; message: string };
}

export interface ManagementStatus {
  service: "glassbox";
  version: string;
  status: "ready";
  platform: string;
  defaultExecution: "claude-code";
  capabilities: {
    modelConfiguration: boolean;
    channels: boolean;
    conversations: boolean;
    runs: boolean;
    trace: boolean;
    eval: boolean;
  };
}

export interface ManagementDoctor {
  checks: Array<{
    id: string;
    label: string;
    status: "detected" | "missing" | "error";
    message: string;
  }>;
}
