// Adapted from OpenHarness ProviderProfile and atomic_write_bytes. See SOURCES.md.
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { MODEL_PROTOCOLS, type ModelProtocol, type PublicModelProfile } from "@glassbox/contracts";

export { MODEL_PROTOCOLS };
export type { ModelProtocol, PublicModelProfile };

export interface ModelProfile {
  id: string;
  label: string;
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  credentialSlot: string | null;
}

interface Settings {
  version: 1;
  profiles: ModelProfile[];
  credentials: Record<string, string>;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ConfigurationError("Expected a configuration object");
  }
  return input as Record<string, unknown>;
}

function boundedText(value: unknown, field: string, max = 256): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    throw new ConfigurationError(`Invalid ${field}`);
  }
  return value.trim();
}

function profileId(value: unknown, max = 80): string {
  const id = boundedText(value, "profile id", max);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(id)) throw new ConfigurationError("Invalid profile id");
  return id;
}

function endpoint(value: unknown): string {
  const text = boundedText(value, "API address", 2048);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigurationError("Invalid API address");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new ConfigurationError("API address requires HTTPS or loopback HTTP");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigurationError(
      "API address cannot contain credentials, query parameters, or a fragment",
    );
  }
  return url.href.replace(/\/$/u, "");
}

function parseProfile(value: unknown): ModelProfile {
  const input = record(value);
  const protocol = input.protocol;
  if (!MODEL_PROTOCOLS.some((candidate) => candidate === protocol)) {
    throw new ConfigurationError("Unsupported model protocol");
  }
  return {
    id: profileId(input.id),
    label: boundedText(input.label, "profile label", 120),
    protocol: protocol as ModelProtocol,
    baseUrl: endpoint(input.baseUrl),
    model: boundedText(input.model, "model", 256),
    credentialSlot: input.credentialSlot == null ? null : profileId(input.credentialSlot, 96),
  };
}

function parseSettings(raw: string): Settings {
  try {
    const input = record(JSON.parse(raw));
    if (input.version !== 1 || !Array.isArray(input.profiles) || input.profiles.length > 100) {
      throw new ConfigurationError("Unsupported configuration file");
    }
    const profiles = input.profiles.map(parseProfile);
    if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
      throw new ConfigurationError("Duplicate profile id");
    }
    const entries = Object.entries(record(input.credentials));
    if (entries.length > 100) throw new ConfigurationError("Too many credentials");
    const credentials = Object.fromEntries(
      entries.map(([slot, secret]) => [
        profileId(slot, 96),
        boundedText(secret, "credential", 16384),
      ]),
    );
    if (
      profiles.some(
        (profile) =>
          profile.credentialSlot !== null && !Object.hasOwn(credentials, profile.credentialSlot),
      )
    ) {
      throw new ConfigurationError("Missing profile credential");
    }
    return { version: 1, profiles, credentials };
  } catch {
    // JSON parser errors can include credential-bearing source text.
    throw new ConfigurationError("Cannot read model configuration; repair or restore its file");
  }
}

async function atomicWrite(path: string, value: Settings): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = join(dirname(path), `.models-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
  } catch {
    await unlink(temporaryPath).catch(() => undefined);
    throw new ConfigurationError("Could not save model configuration");
  }
}

/** One instance per server-owned data directory. HTTP callers must authorize first. */
export class ModelProfileStore {
  #settings: Settings;
  #tail: Promise<unknown> = Promise.resolve();
  #path: string;

  private constructor(path: string, settings: Settings) {
    this.#path = path;
    this.#settings = settings;
  }

  static async open(dataDirectory: string): Promise<ModelProfileStore> {
    if (!isAbsolute(dataDirectory)) throw new ConfigurationError("Data directory must be absolute");
    const path = join(dataDirectory, "models.json");
    let settings: Settings = { version: 1, profiles: [], credentials: {} };
    try {
      settings = parseSettings(await readFile(path, "utf8"));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    return new ModelProfileStore(path, settings);
  }

  list(): PublicModelProfile[] {
    return this.#settings.profiles.map(({ credentialSlot, ...profile }) => ({
      ...profile,
      credentialConfigured:
        credentialSlot !== null && Object.hasOwn(this.#settings.credentials, credentialSlot),
    }));
  }

  /** Explicit server-only resolution. Never pass its result to the management API or Trace. */
  resolve(id: string): { profile: ModelProfile; apiKey?: string } {
    const profile = this.#settings.profiles.find((candidate) => candidate.id === id);
    if (!profile) throw new ConfigurationError("Model profile not found");
    return {
      profile: { ...profile },
      ...(profile.credentialSlot !== null
        ? { apiKey: this.#settings.credentials[profile.credentialSlot] }
        : {}),
    };
  }

  /** Omitted apiKey preserves the current key. null explicitly removes it. */
  save(input: unknown): Promise<PublicModelProfile> {
    const value = record(input);
    if (
      Object.keys(value).some(
        (key) => !["id", "label", "protocol", "baseUrl", "model", "apiKey"].includes(key),
      )
    ) {
      throw new ConfigurationError("Unknown model profile field");
    }
    const profile = parseProfile(value);
    const apiKey =
      value.apiKey === undefined || value.apiKey === null
        ? value.apiKey
        : boundedText(value.apiKey, "credential", 16384);
    return this.#enqueue(async () => {
      const current = this.#settings.profiles.find((candidate) => candidate.id === profile.id);
      if (!current && this.#settings.profiles.length >= 100)
        throw new ConfigurationError("Too many model profiles");
      if (
        current?.credentialSlot &&
        apiKey === undefined &&
        new URL(current.baseUrl).origin !== new URL(profile.baseUrl).origin
      ) {
        throw new ConfigurationError(
          "Changing the API origin requires replacing or removing its credential",
        );
      }
      const credentials = { ...this.#settings.credentials };
      profile.credentialSlot = current?.credentialSlot ?? null;
      if (apiKey === null) {
        profile.credentialSlot = null;
      } else if (typeof apiKey === "string") {
        const slot = `model-${randomUUID()}`;
        credentials[slot] = apiKey;
        profile.credentialSlot = slot;
      }
      const profiles = this.#settings.profiles.filter((candidate) => candidate.id !== profile.id);
      profiles.push(profile);
      const referencedSlots = new Set(profiles.map((candidate) => candidate.credentialSlot));
      const next = parseSettings(
        JSON.stringify({
          version: 1,
          credentials: Object.fromEntries(
            Object.entries(credentials).filter(([slot]) => referencedSlots.has(slot)),
          ),
          profiles,
        }),
      );
      await atomicWrite(this.#path, next);
      this.#settings = next;
      const { credentialSlot, ...publicProfile } = profile;
      return { ...publicProfile, credentialConfigured: credentialSlot !== null };
    });
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.#tail.catch(() => undefined).then(task);
    this.#tail = operation;
    return operation;
  }
}
