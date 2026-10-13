import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GATE_MESSAGES,
  type GateMessages,
  type GateMessageKey,
} from "../runtime/pi/gate-messages.js";
import type { PiRuntimeProfileName } from "../runtime/pi/types.js";

const profiles: readonly PiRuntimeProfileName[] = [
  "main-agent",
  "local-coding",
  "owner-direct",
  "qq-group",
  "herdr-worker",
  "test",
];

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasControlCharacters(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true;
  }
  return false;
}

/** Trusted local settings only. A Run receives one immutable wording snapshot. */
export function parseRuntimeReplies(
  value: unknown,
): (profile: PiRuntimeProfileName) => GateMessages {
  if (
    !object(value) ||
    value.version !== 1 ||
    !object(value.profiles) ||
    Object.keys(value).some((key) => key !== "version" && key !== "profiles")
  )
    throw new Error("invalid_runtime_replies");
  const resolved = new Map<PiRuntimeProfileName, GateMessages>();
  for (const [profile, overrides] of Object.entries(value.profiles)) {
    if (!profiles.includes(profile as PiRuntimeProfileName) || !object(overrides))
      throw new Error("invalid_runtime_replies");
    const messages: Record<GateMessageKey, string> = { ...GATE_MESSAGES };
    for (const [key, text] of Object.entries(overrides)) {
      if (
        !Object.hasOwn(GATE_MESSAGES, key) ||
        typeof text !== "string" ||
        text.trim().length === 0 ||
        text.length > 1000 ||
        hasControlCharacters(text)
      )
        throw new Error("invalid_runtime_replies");
      messages[key as GateMessageKey] = text.trim();
    }
    resolved.set(profile as PiRuntimeProfileName, Object.freeze(messages));
  }
  const defaults: GateMessages = Object.freeze({ ...GATE_MESSAGES });
  return (profile) => resolved.get(profile) ?? defaults;
}

export function loadRuntimeReplies(
  dataDirectory: string,
): (profile: PiRuntimeProfileName) => GateMessages {
  const path = join(dataDirectory, "runtime-replies.json");
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return parseRuntimeReplies({ version: 1, profiles: {} });
    throw error;
  }
  if (bytes.byteLength > 64 * 1024) throw new Error("invalid_runtime_replies");
  return parseRuntimeReplies(JSON.parse(bytes.toString("utf8")));
}
