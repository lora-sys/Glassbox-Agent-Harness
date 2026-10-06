import { describe, expect, it } from "vite-plus/test";
import { createHash } from "node:crypto";
import { groupInfoEvidence } from "./group-info-evidence.js";

const details = {
  group_id: 20001,
  group_name: "专用测试群",
  member_count: 3,
  max_member_count: 200,
  remark: "private provider data".repeat(100),
};
const result = (data: Record<string, unknown> = details) => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  details: data,
});

describe("group metadata Trace projection", () => {
  it("projects the actual complete Tool result without retaining names or provider extras", () => {
    const actual = result();
    expect(Buffer.byteLength(JSON.stringify(actual))).toBeGreaterThan(512);
    expect(groupInfoEvidence(actual)).toEqual({
      schemaVersion: 1,
      groupId: "20001",
      groupNameSha256: createHash("sha256").update(details.group_name).digest("hex"),
      memberCount: 3,
      maxMemberCount: 200,
    });
  });
  it("omits evidence for malformed or inconsistent protected Tool results", () => {
    const changes = [
      { group_id: Number.MAX_SAFE_INTEGER + 1 },
      { group_id: "invalid" },
      { group_name: "" },
      { group_name: "x".repeat(513) },
      { member_count: -1 },
      { member_count: 201 },
      { member_count: "3" },
      { max_member_count: 2 },
      { max_member_count: 3.5 },
    ];
    for (const change of changes)
      expect(groupInfoEvidence(result({ ...details, ...change }))).toBeUndefined();
    for (const value of [
      null,
      [],
      { details },
      { ...result(), extra: true },
      { ...result(), content: [{ type: "text", text: "wrong" }] },
      { ...result(), content: [{ type: "image", text: JSON.stringify(details) }] },
    ])
      expect(groupInfoEvidence(value)).toBeUndefined();
  });
});
