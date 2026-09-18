// Adapted from the owned ModelProfileStore atomic-write boundary. See CHANNEL-SOURCES.md.
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { ChannelSaveInput, PublicChannelProfile } from "@glassbox/contracts";
import { parseOneBotConfig, type OneBotConnectionConfig } from "../channels/onebot/config.js";

interface StoredChannel extends Omit<ChannelSaveInput, "token"> {
  credentialSlot: string;
  autoConnect: boolean;
}
interface Settings {
  version: 1;
  channels: StoredChannel[];
  credentials: Record<string, string>;
}

export class ChannelConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelConfigurationError";
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ChannelConfigurationError("Expected a channel configuration object");
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new ChannelConfigurationError(`Invalid ${field}`);
  return value.trim();
}

function identifier(value: unknown): string {
  const id = text(value, "channel identifier", 96);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(id))
    throw new ChannelConfigurationError("Invalid channel identifier");
  return id;
}

function tokenValue(value: unknown): string {
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,4096}$/u.test(value))
    throw new ChannelConfigurationError("Invalid channel token");
  return value;
}

function executionReference(value: unknown): string {
  if (value === undefined) return "claude-code";
  if (value === "claude-code" || value === "codex") return value;
  if (typeof value === "string" && /^(?:model|pi):[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(value))
    return value;
  throw new ChannelConfigurationError("Invalid execution reference");
}

function toConfig(channel: StoredChannel): OneBotConnectionConfig {
  return parseOneBotConfig({
    connectionId: channel.id,
    label: channel.label,
    endpoint: channel.endpoint,
    botId: channel.botId,
    ownerId: channel.ownerId,
    visitorIds: channel.visitorIds,
    groupIds: channel.groupIds,
    credentialSlot: channel.credentialSlot,
    allowRemote: false,
  });
}

function parseChannel(value: unknown): StoredChannel {
  const input = record(value);
  if (input.kind !== "qq-onebot" || typeof input.autoConnect !== "boolean")
    throw new ChannelConfigurationError("Invalid channel configuration");
  if (
    typeof input.botId !== "string" ||
    typeof input.ownerId !== "string" ||
    !Array.isArray(input.groupIds) ||
    input.groupIds.some((id) => typeof id !== "string")
  )
    throw new ChannelConfigurationError("QQ account and group identifiers must be strings");
  const channel: StoredChannel = {
    visitorIds: input.visitorIds === undefined ? [] : (input.visitorIds as string[]),
    id: identifier(input.id),
    label: text(input.label, "channel label", 120),
    kind: "qq-onebot",
    endpoint: text(input.endpoint, "OneBot address", 2048),
    botId: input.botId,
    ownerId: input.ownerId,
    groupIds: [...input.groupIds] as string[],
    executionRef: executionReference(input.executionRef),
    credentialSlot: identifier(input.credentialSlot),
    autoConnect: input.autoConnect,
  };
  try {
    const config = toConfig(channel);
    return {
      ...channel,
      endpoint: config.endpoint,
      groupIds: [...config.groupIds],
      visitorIds: [...config.visitorIds],
    };
  } catch {
    throw new ChannelConfigurationError("Invalid OneBot address or QQ identifiers");
  }
}

function parseSettings(raw: string): Settings {
  try {
    const input = record(JSON.parse(raw));
    if (input.version !== 1 || !Array.isArray(input.channels) || input.channels.length > 100)
      throw new ChannelConfigurationError("Unsupported channel configuration file");
    const channels = input.channels.map(parseChannel);
    if (new Set(channels.map((channel) => channel.id)).size !== channels.length)
      throw new ChannelConfigurationError("Duplicate channel identifier");
    // Each channel owns its slot. A malformed file cannot share credentials across identities.
    if (new Set(channels.map((channel) => channel.credentialSlot)).size !== channels.length)
      throw new ChannelConfigurationError("Shared channel credential slots are not supported");
    const entries = Object.entries(record(input.credentials));
    if (entries.length > 100) throw new ChannelConfigurationError("Too many channel credentials");
    const credentials = Object.fromEntries(
      entries.map(([slot, token]) => [identifier(slot), tokenValue(token)]),
    );
    return { version: 1, channels, credentials };
  } catch {
    // Never expose JSON parser fragments, endpoint contents or credentials.
    throw new ChannelConfigurationError(
      "Cannot read channel configuration; repair or restore its file",
    );
  }
}

async function atomicWrite(path: string, settings: Settings): Promise<void> {
  const temporary = join(dirname(path), `.channels-${randomUUID()}.tmp`);
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(settings, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch {
    await unlink(temporary).catch(() => undefined);
    throw new ChannelConfigurationError("Could not save channel configuration");
  }
}

/** One instance per server-owned data directory. Callers authorize management operations first. */
export class ChannelProfileStore {
  #settings: Settings;
  #path: string;
  #tail: Promise<unknown> = Promise.resolve();

  private constructor(path: string, settings: Settings) {
    this.#path = path;
    this.#settings = settings;
  }

  static async open(dataDirectory: string): Promise<ChannelProfileStore> {
    if (!isAbsolute(dataDirectory))
      throw new ChannelConfigurationError("Data directory must be absolute");
    const path = join(dataDirectory, "channels.json");
    let settings: Settings = { version: 1, channels: [], credentials: {} };
    try {
      if ((await stat(path)).size > 2 * 1024 * 1024)
        throw new ChannelConfigurationError("Channel configuration file is too large");
      settings = parseSettings(await readFile(path, "utf8"));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        if (error instanceof ChannelConfigurationError) throw error;
        throw new ChannelConfigurationError(
          "Cannot read channel configuration; repair or restore its file",
        );
      }
    }
    return new ChannelProfileStore(path, settings);
  }

  list(): PublicChannelProfile[] {
    return this.#settings.channels.map((channel) => this.#public(channel));
  }

  /** Server-only credential resolution. Never serialize this result into public responses or Trace. */
  resolve(id: string): {
    config: OneBotConnectionConfig;
    token?: string;
    executionRef: string;
    autoConnect: boolean;
  } {
    const channel = this.#find(id);
    const token = Object.hasOwn(this.#settings.credentials, channel.credentialSlot)
      ? this.#settings.credentials[channel.credentialSlot]
      : undefined;
    return {
      config: toConfig(channel),
      ...(token === undefined ? {} : { token }),
      executionRef: channel.executionRef,
      autoConnect: channel.autoConnect,
    };
  }

  /** Saving configuration does not connect. Runtime owners must reject edits while a connection is active. */
  save(input: unknown): Promise<PublicChannelProfile> {
    const value = record(input);
    if (
      Object.keys(value).some(
        (key) =>
          ![
            "id",
            "label",
            "kind",
            "endpoint",
            "botId",
            "ownerId",
            "visitorIds",
            "groupIds",
            "executionRef",
            "token",
          ].includes(key),
      )
    )
      throw new ChannelConfigurationError("Unknown channel profile field");
    const channel = parseChannel({
      ...value,
      credentialSlot: `channel-${randomUUID()}`,
      autoConnect: false,
    });
    const token =
      value.token === undefined || value.token === null ? value.token : tokenValue(value.token);
    return this.#enqueue(async () => {
      const current = this.#settings.channels.find((item) => item.id === channel.id);
      if (!current && this.#settings.channels.length >= 100)
        throw new ChannelConfigurationError("Too many channel profiles");
      if (
        current &&
        Object.hasOwn(this.#settings.credentials, current.credentialSlot) &&
        token === undefined &&
        new URL(current.endpoint).origin !== new URL(channel.endpoint).origin
      )
        throw new ChannelConfigurationError(
          "Changing the endpoint origin requires replacing or removing its token",
        );
      const credentials = { ...this.#settings.credentials };
      channel.credentialSlot = current?.credentialSlot ?? channel.credentialSlot;
      channel.autoConnect = current?.autoConnect ?? false;
      if (token === null) delete credentials[channel.credentialSlot];
      else if (typeof token === "string") credentials[channel.credentialSlot] = token;
      const channels = this.#settings.channels.filter((item) => item.id !== channel.id);
      channels.push(channel);
      await this.#persist(channels, credentials);
      return this.#public(this.#find(channel.id));
    });
  }

  /** Only an explicit connect/disconnect management action changes restart intent. */
  setAutoConnect(id: string, value: boolean): Promise<PublicChannelProfile> {
    if (typeof value !== "boolean")
      throw new ChannelConfigurationError("Invalid auto-connect setting");
    return this.#enqueue(async () => {
      const current = this.#find(id);
      const channels = this.#settings.channels.map((channel) =>
        channel.id === current.id ? { ...channel, autoConnect: value } : channel,
      );
      await this.#persist(channels, this.#settings.credentials);
      return this.#public(this.#find(id));
    });
  }

  #find(id: string): StoredChannel {
    const channel = this.#settings.channels.find((item) => item.id === id);
    if (!channel) throw new ChannelConfigurationError("Channel profile not found");
    return channel;
  }

  #public(channel: StoredChannel): PublicChannelProfile {
    const { credentialSlot, ...profile } = channel;
    return {
      ...profile,
      groupIds: [...profile.groupIds],
      visitorIds: [...(profile.visitorIds ?? [])],
      tokenConfigured: Object.hasOwn(this.#settings.credentials, credentialSlot),
      connectionState: "disconnected",
    };
  }

  async #persist(channels: StoredChannel[], credentials: Record<string, string>): Promise<void> {
    const slots = new Set(channels.map((channel) => channel.credentialSlot));
    const next = parseSettings(
      JSON.stringify({
        version: 1,
        channels,
        credentials: Object.fromEntries(
          Object.entries(credentials).filter(([slot]) => slots.has(slot)),
        ),
      }),
    );
    await atomicWrite(this.#path, next);
    this.#settings = next;
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.#tail.catch(() => undefined).then(task);
    this.#tail = operation;
    return operation;
  }
}
