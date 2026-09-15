import { MODEL_PROTOCOLS } from "@glassbox/contracts";
import type {
  ManagementDoctor,
  ManagementStatus,
  ModelProtocol,
  PublicModelProfile,
} from "@glassbox/contracts";
import { ManagementApiError } from "./errors";

const capabilityNames = [
  "modelConfiguration",
  "channels",
  "conversations",
  "runs",
  "trace",
  "eval",
] as const;
export type ServiceStatus = ManagementStatus;
export type DoctorCheck = ManagementDoctor["checks"][number];
export interface ModelSave {
  id: string;
  label: string;
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  apiKey?: string | null;
}
export interface ModelDraft extends Omit<ModelSave, "apiKey"> {
  apiKey: string;
  clearApiKey: boolean;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ManagementApiError("INVALID_RESPONSE");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new ManagementApiError("INVALID_RESPONSE");
  for (let index = 0; index < value.length; index++)
    if (value.charCodeAt(index) < 32 || value.charCodeAt(index) === 127)
      throw new ManagementApiError("INVALID_RESPONSE");
  return value;
}
function endpoint(value: unknown): string {
  const input = text(value, 2048);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ManagementApiError("INVALID_RESPONSE");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new ManagementApiError("INVALID_RESPONSE");
  return input;
}

export function decodeStatus(value: unknown): ServiceStatus {
  const input = object(value);
  if (
    input.service !== "glassbox" ||
    input.status !== "ready" ||
    input.defaultExecution !== "claude-code"
  )
    throw new ManagementApiError("INVALID_RESPONSE");
  const capabilities = object(input.capabilities);
  for (const name of capabilityNames)
    if (typeof capabilities[name] !== "boolean") throw new ManagementApiError("INVALID_RESPONSE");
  return {
    service: "glassbox",
    status: "ready",
    version: text(input.version, 80),
    platform: text(input.platform, 32),
    defaultExecution: "claude-code",
    capabilities: Object.fromEntries(
      capabilityNames.map((name) => [name, capabilities[name]]),
    ) as ServiceStatus["capabilities"],
  };
}

export function decodeDoctor(value: unknown): DoctorCheck[] {
  const checks = object(value).checks;
  if (!Array.isArray(checks) || checks.length > 100)
    throw new ManagementApiError("INVALID_RESPONSE");
  const result = checks.map((value): DoctorCheck => {
    const input = object(value);
    if (input.status !== "detected" && input.status !== "missing" && input.status !== "error")
      throw new ManagementApiError("INVALID_RESPONSE");
    return {
      id: text(input.id, 80),
      label: text(input.label, 120),
      status: input.status,
      message: text(input.message, 1000),
    };
  });
  if (new Set(result.map((check) => check.id)).size !== result.length)
    throw new ManagementApiError("INVALID_RESPONSE");
  return result;
}

export function decodeModel(value: unknown): PublicModelProfile {
  const input = object(value);
  const id = text(input.id, 80);
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(id) ||
    !MODEL_PROTOCOLS.some((protocol) => protocol === input.protocol) ||
    typeof input.credentialConfigured !== "boolean"
  )
    throw new ManagementApiError("INVALID_RESPONSE");
  if (["apiKey", "credentialSlot", "credentials", "secret", "token"].some((key) => key in input))
    throw new ManagementApiError("INVALID_RESPONSE");
  return {
    id,
    label: text(input.label, 120),
    protocol: input.protocol as ModelProtocol,
    baseUrl: endpoint(input.baseUrl),
    model: text(input.model),
    credentialConfigured: input.credentialConfigured,
  };
}
export function decodeModelList(value: unknown): PublicModelProfile[] {
  const profiles = object(value).profiles;
  if (!Array.isArray(profiles) || profiles.length > 100)
    throw new ManagementApiError("INVALID_RESPONSE");
  const result = profiles.map(decodeModel);
  if (new Set(result.map((profile) => profile.id)).size !== result.length)
    throw new ManagementApiError("INVALID_RESPONSE");
  return result;
}
export function decodeModelResult(value: unknown): PublicModelProfile {
  return decodeModel(object(value).profile);
}

export function emptyModelDraft(): ModelDraft {
  return {
    id: "",
    label: "",
    protocol: "openai-completions",
    baseUrl: "",
    model: "",
    apiKey: "",
    clearApiKey: false,
  };
}

export function buildModelSave(draft: ModelDraft, previous?: PublicModelProfile): ModelSave {
  let profile: PublicModelProfile;
  try {
    profile = decodeModel({
      id: draft.id.trim(),
      label: draft.label.trim(),
      protocol: draft.protocol,
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
      credentialConfigured: false,
    });
  } catch {
    throw new ManagementApiError("INVALID_INPUT");
  }
  if (draft.apiKey && draft.clearApiKey) throw new ManagementApiError("INVALID_INPUT");
  const key = draft.apiKey.trim();
  if (key.length > 16384) throw new ManagementApiError("INVALID_INPUT");
  if (key) {
    try {
      text(key, 16384);
    } catch {
      throw new ManagementApiError("INVALID_INPUT");
    }
  }
  if (
    previous?.credentialConfigured &&
    !key &&
    !draft.clearApiKey &&
    new URL(previous.baseUrl).origin !== new URL(profile.baseUrl).origin
  )
    throw new ManagementApiError("INVALID_CONFIGURATION");
  const { credentialConfigured: _configured, ...saved } = profile;
  return { ...saved, ...(key ? { apiKey: key } : draft.clearApiKey ? { apiKey: null } : {}) };
}
