import { createHash } from "node:crypto";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Payload-free evidence from the actual protected Tool result, independent of head truncation. */
export function groupInfoEvidence(result: unknown):
  | {
      schemaVersion: 1;
      groupId: string;
      groupNameSha256: string;
      memberCount: number;
      maxMemberCount: number;
    }
  | undefined {
  if (!isRecord(result) || Object.keys(result).sort().join(",") !== "content,details") return;
  const { content, details } = result;
  if (
    !Array.isArray(content) ||
    content.length !== 1 ||
    !isRecord(content[0]) ||
    Object.keys(content[0]).sort().join(",") !== "text,type" ||
    content[0].type !== "text" ||
    !isRecord(details) ||
    typeof details.group_name !== "string" ||
    !details.group_name.trim() ||
    Buffer.byteLength(details.group_name, "utf8") > 512 ||
    typeof details.member_count !== "number" ||
    !Number.isSafeInteger(details.member_count) ||
    details.member_count < 0 ||
    typeof details.max_member_count !== "number" ||
    !Number.isSafeInteger(details.max_member_count) ||
    details.max_member_count < details.member_count
  )
    return;
  const id = details.group_id;
  const groupId =
    typeof id === "string"
      ? id
      : typeof id === "number" && Number.isSafeInteger(id)
        ? String(id)
        : "";
  if (!/^[1-9]\d{4,15}$/u.test(groupId)) return;
  try {
    if (content[0].text !== JSON.stringify(details)) return;
  } catch {
    return;
  }
  return {
    schemaVersion: 1,
    groupId,
    groupNameSha256: createHash("sha256").update(details.group_name, "utf8").digest("hex"),
    memberCount: details.member_count,
    maxMemberCount: details.max_member_count,
  };
}
