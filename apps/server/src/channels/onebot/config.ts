export interface OneBotConnectionConfig {
  connectionId: string;
  label: string;
  endpoint: string;
  botId: string;
  ownerId: string;
  coOwnerId?: string;
  visitorIds: readonly string[];
  groupIds: readonly string[];
  credentialSlot: string;
  allowRemote: boolean;
}

export class OneBotConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OneBotConfigurationError";
  }
}

export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** QQ account and group numbers must survive JSON numbers without losing identity. */
export function qqId(value: unknown): string | undefined {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  if (typeof value !== "string" || !/^[1-9]\d{0,15}$/u.test(value)) return undefined;
  return Number.isSafeInteger(Number(value)) ? value : undefined;
}

export function messageId(value: unknown): string | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) ? String(value) : undefined;
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d{0,15})$/u.test(value)) return undefined;
  return Number.isSafeInteger(Number(value)) ? String(Number(value)) : undefined;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u.test(value))
    throw new OneBotConfigurationError(`Invalid ${label}`);
  return value;
}

export function parseOneBotConfig(value: unknown): OneBotConnectionConfig {
  const config = object(value);
  if (!config) throw new OneBotConfigurationError("Expected a OneBot connection object");
  const botId = qqId(config.botId);
  const ownerId = qqId(config.ownerId);
  const coOwnerId = config.coOwnerId !== undefined ? qqId(config.coOwnerId) : undefined;
  if (!botId || !ownerId || botId === ownerId)
    throw new OneBotConfigurationError("Configure separate valid bot and Owner QQ numbers");
  if (coOwnerId !== undefined && (coOwnerId === botId || coOwnerId === ownerId))
    throw new OneBotConfigurationError("Configure separate valid bot, Owner, and Co-Owner QQ numbers");
  if (!Array.isArray(config.groupIds) || config.groupIds.length > 32)
    throw new OneBotConfigurationError("Configure at most 32 allowed group numbers");
  const groups = config.groupIds.map(qqId);
  if (groups.some((group) => group === undefined))
    throw new OneBotConfigurationError("Invalid allowed group number");
  const visitorValues = config.visitorIds ?? [];
  if (!Array.isArray(visitorValues) || visitorValues.length > 64)
    throw new OneBotConfigurationError("Configure at most 64 Visitor QQ numbers");
  const visitors = visitorValues.map(qqId);
  if (
    visitors.some((visitor) => visitor === undefined) ||
    visitors.includes(ownerId) ||
    (coOwnerId !== undefined && visitors.includes(coOwnerId)) ||
    visitors.includes(botId)
  )
    throw new OneBotConfigurationError("Invalid Visitor QQ number");
  if (config.allowRemote !== undefined && typeof config.allowRemote !== "boolean")
    throw new OneBotConfigurationError("Invalid remote connection setting");
  const allowRemote = config.allowRemote === true;
  let endpoint: URL;
  try {
    endpoint = new URL(
      typeof config.endpoint === "string" ? config.endpoint : "ws://127.0.0.1:6700/",
    );
  } catch {
    throw new OneBotConfigurationError("Invalid OneBot WebSocket address");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !["ws:", "wss:"].includes(endpoint.protocol)
  )
    throw new OneBotConfigurationError(
      "Use a WebSocket address without credentials or query parameters",
    );
  if (!local && (!allowRemote || endpoint.protocol !== "wss:"))
    throw new OneBotConfigurationError("Remote OneBot connections require explicit opt-in and WSS");
  if (["/api", "/api/", "/event", "/event/"].includes(endpoint.pathname))
    throw new OneBotConfigurationError("Use a combined OneBot API and event WebSocket endpoint");
  if (endpoint.hostname === "localhost" && endpoint.protocol === "ws:")
    endpoint.hostname = "127.0.0.1";
  const label = config.label;
  if (typeof label !== "string" || !label.trim() || label.length > 120)
    throw new OneBotConfigurationError("Invalid connection label");
  return Object.freeze({
    connectionId: identifier(config.connectionId, "connection identifier"),
    label: label.trim(),
    endpoint: endpoint.href,
    botId,
    ownerId,
    ...(coOwnerId !== undefined ? { coOwnerId } : {}),
    visitorIds: Object.freeze([...new Set(visitors as string[])]),
    groupIds: Object.freeze([...new Set(groups as string[])]),
    credentialSlot: identifier(config.credentialSlot, "credential slot"),
    allowRemote,
  });
}
