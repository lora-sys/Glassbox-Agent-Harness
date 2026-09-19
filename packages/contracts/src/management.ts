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
