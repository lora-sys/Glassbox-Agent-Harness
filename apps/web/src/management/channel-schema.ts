import { CHANNEL_SAFE_ERRORS } from "@glassbox/contracts";
import type { ChannelSaveInput, PublicChannelProfile } from "@glassbox/contracts";
import { ManagementApiError } from "./errors";

export interface ChannelDraft extends Omit<ChannelSaveInput, "groupIds" | "token"> {
  groupIds: string;
  token: string;
  clearToken: boolean;
}

function invalid(): never {
  throw new ManagementApiError("INVALID_RESPONSE");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return invalid();
  return value;
}
function qqId(value: unknown): string {
  const id = text(value, 16);
  if (!/^[1-9]\d{0,15}$/u.test(id) || !Number.isSafeInteger(Number(id))) return invalid();
  return id;
}
function endpoint(value: unknown): string {
  const input = text(value, 2048);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return invalid();
  }
  if (
    !["ws:", "wss:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    ["/api", "/api/", "/event", "/event/"].includes(url.pathname)
  )
    return invalid();
  if (url.protocol === "ws:" && url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.href;
}

export function decodeChannel(value: unknown): PublicChannelProfile {
  const input = object(value);
  const keys = [
    "id",
    "label",
    "kind",
    "endpoint",
    "botId",
    "ownerId",
    "groupIds",
    "executionRef",
    "tokenConfigured",
    "autoConnect",
    "connectionState",
    "lastError",
  ];
  if (Object.keys(input).some((key) => !keys.includes(key))) return invalid();
  const id = text(input.id, 96);
  const botId = qqId(input.botId);
  const ownerId = qqId(input.ownerId);
  const executionRef = text(input.executionRef, 86);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(id) ||
    input.kind !== "qq-onebot" ||
    botId === ownerId ||
    !Array.isArray(input.groupIds) ||
    input.groupIds.length > 32 ||
    typeof input.tokenConfigured !== "boolean" ||
    typeof input.autoConnect !== "boolean" ||
    !["disconnected", "connecting", "connected", "error"].includes(String(input.connectionState)) ||
    !(
      ["claude-code", "codex"].includes(executionRef) ||
      /^model:[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(executionRef)
    )
  )
    return invalid();
  const groups = input.groupIds.map(qqId);
  if (new Set(groups).size !== groups.length) return invalid();
  const lastError = Object.values(CHANNEL_SAFE_ERRORS).find(
    (message) => message === input.lastError,
  );
  if (input.lastError !== undefined && !lastError) return invalid();
  return {
    id,
    label: text(input.label, 120),
    kind: "qq-onebot",
    endpoint: endpoint(input.endpoint),
    botId,
    ownerId,
    groupIds: groups,
    executionRef,
    tokenConfigured: input.tokenConfigured,
    autoConnect: input.autoConnect,
    connectionState: input.connectionState as PublicChannelProfile["connectionState"],
    ...(lastError ? { lastError } : {}),
  };
}

export function decodeChannelList(value: unknown): PublicChannelProfile[] {
  const input = object(value);
  if (
    Object.keys(input).length !== 1 ||
    !Array.isArray(input.channels) ||
    input.channels.length > 100
  )
    return invalid();
  const channels = input.channels.map(decodeChannel);
  if (new Set(channels.map((channel) => channel.id)).size !== channels.length) return invalid();
  return channels;
}

export function decodeChannelResult(value: unknown): PublicChannelProfile {
  const input = object(value);
  if (Object.keys(input).length !== 1) return invalid();
  return decodeChannel(input.channel);
}

export function emptyChannelDraft(): ChannelDraft {
  return {
    id: "",
    label: "",
    kind: "qq-onebot",
    endpoint: "ws://127.0.0.1:6700/",
    botId: "",
    ownerId: "",
    groupIds: "",
    executionRef: "claude-code",
    token: "",
    clearToken: false,
  };
}

export function channelDraftFor(channel: PublicChannelProfile): ChannelDraft {
  return {
    id: channel.id,
    label: channel.label,
    kind: channel.kind,
    endpoint: channel.endpoint,
    botId: channel.botId,
    ownerId: channel.ownerId,
    groupIds: channel.groupIds.join(", "),
    executionRef: channel.executionRef,
    token: "",
    clearToken: false,
  };
}

export function buildChannelSave(
  draft: ChannelDraft,
  previous?: PublicChannelProfile,
): ChannelSaveInput {
  if (previous && previous.id !== draft.id.trim()) throw new ManagementApiError("INVALID_INPUT");
  if (previous && ["connecting", "connected"].includes(previous.connectionState))
    throw new ManagementApiError("CHANNEL_ACTIVE");
  let channel: PublicChannelProfile;
  try {
    channel = decodeChannel({
      id: draft.id.trim(),
      label: draft.label.trim(),
      kind: draft.kind,
      endpoint: draft.endpoint.trim(),
      botId: draft.botId.trim(),
      ownerId: draft.ownerId.trim(),
      groupIds: [...new Set(draft.groupIds.trim() ? draft.groupIds.trim().split(/[\s,，]+/u) : [])],
      executionRef: draft.executionRef,
      tokenConfigured: false,
      autoConnect: false,
      connectionState: "disconnected",
    });
  } catch {
    throw new ManagementApiError("INVALID_CHANNEL");
  }
  if (
    (draft.token && draft.clearToken) ||
    (draft.token && !/^[\x21-\x7e]{1,4096}$/u.test(draft.token))
  )
    throw new ManagementApiError("INVALID_CHANNEL");
  if (
    previous?.tokenConfigured &&
    !draft.token &&
    !draft.clearToken &&
    new URL(previous.endpoint).origin !== new URL(channel.endpoint).origin
  )
    throw new ManagementApiError("CHANNEL_ORIGIN");
  const {
    tokenConfigured: _tokenConfigured,
    autoConnect: _autoConnect,
    connectionState: _connectionState,
    lastError: _lastError,
    ...input
  } = channel;
  return {
    ...input,
    ...(draft.token ? { token: draft.token } : draft.clearToken ? { token: null } : {}),
  };
}
