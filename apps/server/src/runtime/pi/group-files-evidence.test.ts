import { describe, expect, it } from "vite-plus/test";
import { groupFilesEvidence } from "./group-files-evidence.js";

const file = {
  group_id: 20001,
  file_id: "file-root-id",
  file_name: "root.txt",
  file_size: 123,
  busid: 102,
};
const folder = {
  group_id: "20001",
  folder_id: "folder-id",
  folder_name: "项目资料",
  total_file_count: 2,
  create_time: 1_728_000_000,
};
const toolResult = (details: Record<string, unknown>) => ({
  content: [{ type: "text", text: JSON.stringify(details) }],
  details,
});

describe("group file listing Trace projection", () => {
  it("projects provider rows to counts and a digest without retaining entry data", () => {
    const details = { files: [file], folders: [folder] };
    const evidence = groupFilesEvidence(toolResult(details));
    expect(evidence).toMatchObject({ schemaVersion: 1, fileCount: 1, folderCount: 1 });
    expect(evidence?.listingSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(evidence)).not.toContain("root.txt");
    expect(JSON.stringify(evidence)).not.toContain("folder-id");
  });

  it("accepts UTF-8 names within byte limits and hashes provider extras", () => {
    const longChinese = "文档".repeat(330);
    const details = {
      files: [{ ...file, file_name: longChinese, provider_extra: { checksum: "a".repeat(64) } }],
      folders: [{ ...folder, folder_name: longChinese }],
    };
    const baseline = groupFilesEvidence(
      toolResult({
        files: [{ ...file, file_name: longChinese }],
        folders: [{ ...folder, folder_name: longChinese }],
      }),
    );
    const withExtra = groupFilesEvidence(toolResult(details));
    expect(withExtra?.fileCount).toBe(1);
    expect(withExtra?.listingSha256).not.toBe(baseline?.listingSha256);
    expect(JSON.stringify(withExtra)).not.toContain(longChinese);
    expect(JSON.stringify(withExtra)).not.toContain("checksum");
  });

  it("canonicalizes object key order and preserves provider array order", () => {
    const first = {
      files: [{ group_id: 20001, file_id: "a", file_name: "a.txt", file_size: 1 }],
      folders: [],
    };
    const reordered = {
      folders: [],
      files: [{ file_size: 1, file_name: "a.txt", file_id: "a", group_id: 20001 }],
    };
    const sameRowsDifferentOrder = {
      files: [{ ...first.files[0], file_id: "b", file_name: "b.txt" }, first.files[0]],
      folders: [],
    };
    expect(groupFilesEvidence(toolResult(first))?.listingSha256).toBe(
      groupFilesEvidence(toolResult(reordered))?.listingSha256,
    );
    expect(groupFilesEvidence(toolResult(sameRowsDifferentOrder))?.listingSha256).not.toBe(
      groupFilesEvidence(
        toolResult({
          ...first,
          files: [first.files[0], { ...first.files[0], file_id: "b", file_name: "b.txt" }],
        }),
      )?.listingSha256,
    );
  });

  it("accepts an empty provider listing", () => {
    expect(groupFilesEvidence(toolResult({ files: [], folders: [] }))).toMatchObject({
      schemaVersion: 1,
      fileCount: 0,
      folderCount: 0,
    });
  });

  it("checks numeric group IDs and canonical digit strings for one listing scope", () => {
    const details = {
      files: [{ ...file, group_id: "20001" }],
      folders: [{ ...folder, group_id: 20001 }],
    };
    expect(groupFilesEvidence(toolResult(details))?.fileCount).toBe(1);
    expect(
      groupFilesEvidence(toolResult({ files: [{ ...file, group_id: "020001" }], folders: [] })),
    ).toBeUndefined();
    expect(
      groupFilesEvidence(toolResult({ files: [{ ...file, file_name: "   " }], folders: [] })),
    ).toBeUndefined();
  });

  it("rejects malformed wrappers, content mismatches, and extra wrapper keys", () => {
    const valid = toolResult({ files: [file], folders: [folder] });
    const malformed = [
      null,
      [],
      { details: valid.details },
      { ...valid, extra: true },
      { ...valid, content: [{ type: "text", text: "different" }] },
      { ...valid, content: [{ type: "image", text: JSON.stringify(valid.details) }] },
      { ...valid, content: [valid.content[0], valid.content[0]] },
      { content: valid.content, details: { ...valid.details, extra: true } },
    ];
    for (const value of malformed) expect(groupFilesEvidence(value)).toBeUndefined();
  });

  it("rejects malformed fields, duplicate IDs, mixed groups, and more than 50 rows", () => {
    const invalidDetails = [
      { files: [{ ...file, group_id: "2000" }], folders: [] },
      { files: [{ ...file, file_id: "" }], folders: [] },
      { files: [{ ...file, file_id: "x".repeat(4097) }], folders: [] },
      { files: [{ ...file, file_name: "文".repeat(683) }], folders: [] },
      { files: [{ ...file, file_size: -1 }], folders: [] },
      { files: [{ ...file, file_size: Number.MAX_SAFE_INTEGER + 1 }], folders: [] },
      { files: [{ ...file, group_id: 20002 }], folders: [folder] },
      { files: [file, file], folders: [] },
      { files: [], folders: [folder, folder] },
      {
        files: Array.from({ length: 51 }, (_, index) => ({ ...file, file_id: `f${index}` })),
        folders: [],
      },
      { files: [{ ...file, provider_extra: Number.POSITIVE_INFINITY }], folders: [] },
      { files: [{ ...file, provider_extra: undefined }], folders: [] },
    ];
    for (const details of invalidDetails)
      expect(groupFilesEvidence(toolResult(details))).toBeUndefined();

    const circular: Record<string, unknown> = { files: [], folders: [] };
    circular.extra = circular;
    expect(
      groupFilesEvidence({ content: [{ type: "text", text: "{}" }], details: circular }),
    ).toBeUndefined();
  });

  it("rejects oversized serialized details and non-JSON arrays", () => {
    const oversized = { files: [{ ...file, provider_extra: "x".repeat(256 * 1024) }], folders: [] };
    expect(groupFilesEvidence(toolResult(oversized))).toBeUndefined();

    const sparse: unknown[] = [];
    sparse.length = 1;
    const details = { files: sparse, folders: [] };
    expect(groupFilesEvidence(toolResult(details))).toBeUndefined();
    let deep: unknown = "value";
    for (let index = 0; index < 130; index += 1) deep = { nested: deep };
    expect(
      groupFilesEvidence(toolResult({ files: [{ ...file, extra: deep }], folders: [] })),
    ).toBeUndefined();
    class ExtendedArray extends Array {}
    expect(
      groupFilesEvidence(
        toolResult({ files: [{ ...file, extra: new ExtendedArray() }], folders: [] }),
      ),
    ).toBeUndefined();
  });
});
