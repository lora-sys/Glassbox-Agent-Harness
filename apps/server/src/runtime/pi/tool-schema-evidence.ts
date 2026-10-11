import { createHash } from "node:crypto";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fingerprint(value: unknown): { sha256: string; bytes: number } {
  const json = canonicalJson(value);
  return {
    sha256: createHash("sha256").update(json).digest("hex"),
    bytes: Buffer.byteLength(json),
  };
}

/** Fingerprints the exact selected definitions passed to Pi, without retaining schema values. */
export function toolSchemaEvidence(
  tools: readonly Pick<ToolDefinition, "name" | "description" | "parameters">[],
) {
  const definitions = tools.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
  return {
    source: "pi-selected-custom-tools" as const,
    ...fingerprint(definitions),
    tools: definitions.map((definition) => ({ name: definition.name, ...fingerprint(definition) })),
  };
}

export type ToolSchemaEvidence = ReturnType<typeof toolSchemaEvidence>;
