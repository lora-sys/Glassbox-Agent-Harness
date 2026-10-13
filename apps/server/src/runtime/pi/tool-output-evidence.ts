import { createHash } from "node:crypto";

/** Tools whose serialized output is or contains user message bodies. */
const PROTECTED_OUTPUT_TOOLS = new Set<string>([
  "group_history_search",
  "owner_history_search",
  "worker_read",
  "worker_prompt",
]);

/** Bounded fragment of a tool's return value, so an unexpected result is debuggable. */
const TOOL_OUTPUT_HEAD_BYTES = 512;

export function safeToolOutput(toolName: string, result: unknown): Record<string, unknown> {
  let serialized = "";
  try {
    serialized = JSON.stringify(result) ?? String(result);
  } catch {
    serialized = "";
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  const digest = createHash("sha256").update(serialized, "utf8").digest("hex");
  // Digest and byte count are recorded for every Tool: they prove a result existed and
  // let two runs be compared without the trace holding payload text. The head is the part
  // that needs a decision, so it is limited to Tools whose output is known to be metadata
  // rather than message bodies — the same reason `safeToolInput` is a whitelist.
  if (PROTECTED_OUTPUT_TOOLS.has(toolName)) return { outputBytes: bytes, outputSha256: digest };
  const slice = Buffer.from(serialized, "utf8")
    .subarray(0, TOOL_OUTPUT_HEAD_BYTES)
    .toString("utf8");
  return {
    outputBytes: bytes,
    outputSha256: digest,
    outputHead: slice,
    outputTruncated: bytes > TOOL_OUTPUT_HEAD_BYTES,
  };
}
