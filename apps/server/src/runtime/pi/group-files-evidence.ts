import { createHash } from "node:crypto";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === "string") &&
    (keys as string[]).sort().join(",") === [...expected].sort().join(",")
  );
}

function validJsonValue(
  value: unknown,
  ancestors = new Set<object>(),
  depth = 0,
): value is JsonValue {
  if (depth > 128) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;

  ancestors.add(value);
  let valid = true;
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    valid =
      Object.getPrototypeOf(value) === Array.prototype &&
      keys.length === value.length + 1 &&
      keys.every(
        (key) => key === "length" || (typeof key === "string" && /^(0|[1-9]\d*)$/u.test(key)),
      );
    if (valid) {
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (
          !descriptor?.enumerable ||
          !Object.hasOwn(descriptor, "value") ||
          !validJsonValue(descriptor.value, ancestors, depth + 1)
        ) {
          valid = false;
          break;
        }
      }
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    valid =
      (prototype === Object.prototype || prototype === null) &&
      Reflect.ownKeys(value).every((key) => {
        if (typeof key !== "string") return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return Boolean(
          descriptor?.enumerable &&
          Object.hasOwn(descriptor, "value") &&
          validJsonValue(descriptor.value, ancestors, depth + 1),
        );
      });
  }
  ancestors.delete(value);
  return valid;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}

function validGroupId(value: unknown): string | undefined {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return undefined;
    value = String(value);
  }
  return typeof value === "string" && /^[1-9]\d{4,15}$/u.test(value) ? value : undefined;
}

function boundedNonemptyString(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= maxBytes
  );
}

function validFile(value: unknown): value is { [key: string]: JsonValue } {
  if (!isRecord(value)) return false;
  return (
    validGroupId(value.group_id) !== undefined &&
    boundedNonemptyString(value.file_id, 4096) &&
    boundedNonemptyString(value.file_name, 2048) &&
    typeof value.file_size === "number" &&
    Number.isSafeInteger(value.file_size) &&
    value.file_size >= 0
  );
}

function validFolder(value: unknown): value is { [key: string]: JsonValue } {
  if (!isRecord(value)) return false;
  return (
    validGroupId(value.group_id) !== undefined &&
    boundedNonemptyString(value.folder_id, 4096) &&
    boundedNonemptyString(value.folder_name, 2048) &&
    typeof value.total_file_count === "number" &&
    Number.isSafeInteger(value.total_file_count) &&
    value.total_file_count >= 0
  );
}

/** Payload-free evidence from the complete returned provider page in the protected Tool result. */
export function groupFilesEvidence(result: unknown):
  | {
      schemaVersion: 2;
      fileCount: number;
      folderCount: number;
      listingSha256: string;
      metadataSha256: string;
    }
  | undefined {
  try {
    if (
      !isRecord(result) ||
      !hasExactKeys(result, ["content", "details"]) ||
      !validJsonValue(result) ||
      !Array.isArray(result.content) ||
      result.content.length !== 1 ||
      !isRecord(result.content[0]) ||
      !hasExactKeys(result.content[0], ["text", "type"]) ||
      result.content[0].type !== "text" ||
      typeof result.content[0].text !== "string" ||
      !isRecord(result.details) ||
      !hasExactKeys(result.details, ["data", "status"]) ||
      result.details.status !== "ok" ||
      !isRecord(result.details.data) ||
      !hasExactKeys(result.details.data, ["files", "folders"]) ||
      !Array.isArray(result.details.data.files) ||
      !Array.isArray(result.details.data.folders) ||
      result.details.data.files.length + result.details.data.folders.length > 50 ||
      !validJsonValue(result.details)
    )
      return undefined;

    const serializedEnvelope = JSON.stringify(result.details);
    if (
      typeof serializedEnvelope !== "string" ||
      Buffer.byteLength(serializedEnvelope, "utf8") > 256 * 1024 ||
      result.content[0].text !== serializedEnvelope
    )
      return undefined;

    const details = result.details.data;
    const files = details.files as JsonValue[];
    const folders = details.folders as JsonValue[];
    if (!files.every(validFile) || !folders.every(validFolder)) return undefined;
    const groupIds = [...files, ...folders].map((row) => validGroupId(row.group_id));
    if (groupIds.some((groupId) => groupId === undefined) || new Set(groupIds).size > 1)
      return undefined;
    if (
      new Set(files.map((file) => file.file_id)).size !== files.length ||
      new Set(folders.map((folder) => folder.folder_id)).size !== folders.length
    )
      return undefined;

    const canonical = canonicalJson(details as JsonValue);
    // Keep file_id in the full listing digest. The metadata digest compares
    // every other file-row field and the complete folders array.
    const metadata: JsonValue = {
      files: files.map((file) => {
        const { file_id: _fileId, ...rest } = file as Record<string, JsonValue>;
        return rest;
      }),
      folders,
    };
    const canonicalMetadata = canonicalJson(metadata);
    return {
      schemaVersion: 2,
      fileCount: files.length,
      folderCount: folders.length,
      listingSha256: createHash("sha256").update(canonical, "utf8").digest("hex"),
      metadataSha256: createHash("sha256").update(canonicalMetadata, "utf8").digest("hex"),
    };
  } catch {
    return undefined;
  }
}
