import type { ChannelSaveInput } from "@glassbox/contracts";
import { CliError, hasControlCharacters, isRecord } from "./errors.ts";

const fields = new Set([
  "id",
  "label",
  "kind",
  "endpoint",
  "botId",
  "ownerId",
  "groupIds",
  "executionRef",
  "token",
]);

/** A public contract check only. The server remains authoritative for configuration and permission. */
export function parseChannelInput(text: string): ChannelSaveInput {
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) throw new CliError("INPUT_TOO_LARGE");
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || Object.keys(value).some((key) => !fields.has(key))) throw new Error();
    const string = (key: string, max: number) => {
      const entry = value[key];
      if (
        typeof entry !== "string" ||
        !entry.trim() ||
        entry.length > max ||
        hasControlCharacters(entry)
      )
        throw new Error();
      return entry;
    };
    const id = string("id", 80);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(id) || value.kind !== "qq-onebot") throw new Error();
    const label = string("label", 120);
    const endpoint = string("endpoint", 2048);
    const url = new URL(endpoint);
    if (
      !["ws:", "wss:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    const qqId = (entry: unknown): entry is string =>
      typeof entry === "string" &&
      /^[1-9]\d{0,15}$/u.test(entry) &&
      Number.isSafeInteger(Number(entry));
    if (
      !qqId(value.botId) ||
      !qqId(value.ownerId) ||
      value.botId === value.ownerId ||
      !Array.isArray(value.groupIds) ||
      value.groupIds.length > 32 ||
      !value.groupIds.every(qqId)
    )
      throw new Error();
    const executionRef = string("executionRef", 86);
    if (
      !["claude-code", "codex"].includes(executionRef) &&
      !/^model:[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(executionRef)
    )
      throw new Error();
    if (
      value.token !== undefined &&
      value.token !== null &&
      (typeof value.token !== "string" || !/^[\x21-\x7e]{1,4096}$/u.test(value.token))
    )
      throw new Error();
    return {
      id,
      label,
      kind: "qq-onebot",
      endpoint,
      botId: value.botId,
      ownerId: value.ownerId,
      groupIds: value.groupIds,
      executionRef,
      ...(value.token === undefined ? {} : { token: value.token }),
    };
  } catch {
    throw new CliError("INVALID_INPUT");
  }
}
