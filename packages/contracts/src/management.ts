export const MODEL_PROTOCOLS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
] as const;

export type ModelProtocol = (typeof MODEL_PROTOCOLS)[number];

export interface PublicModelProfile {
  id: string;
  label: string;
  /** Pi provider identity for profiles projected from Pi's own ModelRuntime. */
  providerId?: string;
  protocol: ModelProtocol | "google-generative-ai";
  baseUrl: string;
  model: string;
  credentialConfigured: boolean;
  /** Operator-declared request capacity. This is not a measured provider quota. */
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  /** Routing is opt-in on both the current profile and each candidate. */
  routingEnabled?: boolean;
  allowRouting?: boolean;
  routingAvailable?: boolean;
  routePriority?: number;
  capabilityRank?: number;
  supportsTools?: boolean;
  supportsThinking?: boolean;
  supportsVision?: boolean;
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
