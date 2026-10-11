import { createHash } from "node:crypto";
import { fail } from "./core.mjs";

function invalid() {
  fail("HISTORY_INPUT_EVIDENCE", "历史工具的实际参数摘要缺失或与固定请求不一致。", "INCONCLUSIVE");
}
function ordered(value, depth = 0) {
  if (depth > 16) invalid();
  if (Array.isArray(value))
    return "[" + value.map((item) => ordered(item, depth + 1)).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + ordered(value[key], depth + 1))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}

/** Mirrors the protected-history producer's canonical JSON digest, without recording arguments. */
export function historyInputDigest(input) {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
    const raw = JSON.stringify(input);
    if (typeof raw !== "string" || Buffer.byteLength(raw) > 65536) invalid();
    const canonical = ordered(JSON.parse(raw));
    const inputBytes = Buffer.byteLength(canonical, "utf8");
    if (inputBytes > 65536) invalid();
    return {
      inputSha256: createHash("sha256").update(canonical, "utf8").digest("hex"),
      inputBytes,
    };
  } catch {
    invalid();
  }
}

export function verifyHistoryInputEvidence(call, input) {
  const expected = historyInputDigest(input);
  if (
    !call?.data ||
    Object.hasOwn(call.data, "input") ||
    call.data.inputSha256 !== expected.inputSha256 ||
    call.data.inputBytes !== expected.inputBytes
  )
    invalid();
}
