import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  observeGroupFilesResult,
  projectGroupFiles,
  verifyGroupFilesEvidence,
} from "../lib/group-files-evidence.mjs";
import { observeFeature } from "../lib/feature-observer.mjs";

const runId = "run-group-files-1";
const groupId = "20001";
const fileName = "验收.pdf";
const fileId = "f1";
const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");

const providerResult = () => ({
  files: [
    {
      group_id: Number(groupId),
      file_id: fileId,
      file_name: fileName,
      file_size: 412,
    },
  ],
  folders: [
    {
      group_id: groupId,
      folder_id: "d1",
      folder_name: "资料",
      total_file_count: 2,
    },
  ],
});

function fixture({ result = providerResult(), params, inputGroupId = groupId } = {}) {
  const input = { groupId: inputGroupId, operation: "get_group_root_files" };
  if (params !== undefined) input.params = params;
  const wrapper = {
    content: [{ type: "text", text: JSON.stringify(result) }],
    details: result,
  };
  const outputHead = JSON.stringify(wrapper);
  const callId = "call-group-files-1";
  const projection = projectGroupFiles(result, groupId);
  const events = [
    {
      type: "tool_call",
      runId,
      toolCallId: callId,
      data: { toolCallId: callId, name: "qq_group_files", input },
    },
    {
      type: "tool_result",
      runId,
      toolCallId: callId,
      data: {
        toolCallId: callId,
        name: "qq_group_files",
        isError: false,
        groupFiles: { schemaVersion: 1, ...projection },
        outputHead:
          Buffer.byteLength(outputHead, "utf8") > 512
            ? Buffer.from(outputHead, "utf8").subarray(0, 512).toString("utf8")
            : outputHead,
        outputTruncated: Buffer.byteLength(outputHead, "utf8") > 512,
        outputBytes: Buffer.byteLength(outputHead, "utf8"),
        outputSha256: hash(outputHead),
      },
    },
  ];
  const traceAssertion = {
    kind: "trace",
    type: "tool_result",
    where: { name: "qq_group_files", isError: false },
    count: 1,
  };
  const groupFilesAssertion = {
    kind: "group_files",
    tool: "qq_group_files",
    groupId,
    count: 1,
  };
  const assertions = [traceAssertion, groupFilesAssertion];
  const feature = observeFeature(assertions, { events, runId });
  const c = { route: "private", featureAssertions: assertions };
  const config = { groups: [{ alias: "A", id: groupId }] };
  const clients = { bot: { readGroupRootFiles: async () => projectGroupFiles(result, groupId) } };
  const witness = { fileCount: projection.fileCount, folderCount: projection.folderCount };
  return {
    events,
    assertion: groupFilesAssertion,
    projection,
    feature,
    c,
    config,
    clients,
    witness,
    result,
  };
}

const verify = (f, overrides = {}) =>
  verifyGroupFilesEvidence(
    overrides.c ?? f.c,
    overrides.feature ?? f.feature,
    overrides.config ?? f.config,
    overrides.clients ?? f.clients,
    overrides.events ?? f.events,
    runId,
    Object.hasOwn(overrides, "witness") ? overrides.witness : f.witness,
  );

function replaceHead(events, head, overrides = {}) {
  const changed = structuredClone(events);
  Object.assign(changed[1].data, {
    outputHead: head,
    outputBytes: Buffer.byteLength(head, "utf8"),
    outputSha256: hash(head),
    ...overrides,
  });
  return changed;
}

function expectInconclusive(operation, code = "GROUP_FILES_EVIDENCE") {
  assert.throws(operation, (error) => {
    if (code !== null) assert.equal(error.code, code);
    assert.equal(error.status, "INCONCLUSIVE");
    assert.equal(error.message.includes(fileName), false);
    assert.equal(error.message.includes(fileId), false);
    return true;
  });
}

test("group file projection keeps counts and canonical digest without exposing row values", () => {
  const result = providerResult();
  const projected = projectGroupFiles(result, groupId);
  assert.deepEqual(projected, {
    fileCount: 1,
    folderCount: 1,
    listingSha256: hash(
      JSON.stringify({
        files: [
          {
            file_id: fileId,
            file_name: fileName,
            file_size: 412,
            group_id: Number(groupId),
          },
        ],
        folders: [
          {
            folder_id: "d1",
            folder_name: "资料",
            group_id: groupId,
            total_file_count: 2,
          },
        ],
      }),
    ),
  });
  assert.equal(JSON.stringify(projected).includes(fileName), false);
  assert.equal(JSON.stringify(projected).includes(fileId), false);

  const reordered = {
    folders: [
      {
        total_file_count: 2,
        folder_name: "资料",
        folder_id: "d1",
        group_id: groupId,
      },
    ],
    files: [
      {
        file_size: 412,
        file_name: fileName,
        file_id: fileId,
        group_id: Number(groupId),
      },
    ],
  };
  assert.equal(projectGroupFiles(reordered, groupId).listingSha256, projected.listingSha256);
  const secondFile = { ...result.files[0], file_id: "f2", file_name: "第二.pdf" };
  const ordered = { ...result, files: [...result.files, secondFile] };
  const reversed = { ...result, files: [secondFile, ...result.files] };
  assert.notEqual(
    projectGroupFiles(ordered, groupId).listingSha256,
    projectGroupFiles(reversed, groupId).listingSha256,
  );
  const changed = {
    ...result,
    folders: [...result.folders, { ...result.folders[0], folder_id: "d2" }],
  };
  assert.notEqual(projectGroupFiles(changed, groupId).listingSha256, projected.listingSha256);
});

test("group file verifier passes real observer output, private Owner route and independent snapshot", async () => {
  const f = fixture();
  assert.deepEqual(f.feature.observations, [
    { kind: "trace", type: "tool_result", count: 1 },
    { kind: "group_files", tool: "qq_group_files", ...f.projection },
  ]);
  assert.deepEqual(await verify(f), {
    status: "PASS",
    fileCount: 1,
    folderCount: 1,
  });
});

test("group file projection rejects scope, malformed rows, duplicates, count bounds and oversized JSON", () => {
  const base = providerResult();
  const malformed = [
    [{ ...base.files[0], group_id: 20002 }],
    [{ ...base.files[0], group_id: "020001" }],
    [{ ...base.files[0], file_id: "   " }],
    [{ ...base.files[0], file_name: "\t " }],
    [{ ...base.files[0], file_name: "x".repeat(2049) }],
    [{ ...base.files[0], file_id: "x".repeat(4097) }],
    [{ ...base.files[0], file_size: -1 }],
    [{ ...base.files[0], file_size: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...base.files[0], provider_extra: "x".repeat(256 * 1024) }],
    [base.files[0], { ...base.files[0] }],
  ];
  for (const files of malformed)
    expectInconclusive(
      () => projectGroupFiles({ ...base, files }, groupId),
      "GROUP_FILES_PROJECTION",
    );
  for (const folder of [
    { ...base.folders[0], group_id: 20002 },
    { ...base.folders[0], folder_id: "  " },
    { ...base.folders[0], folder_name: "\n" },
    { ...base.folders[0], folder_name: "x".repeat(2049) },
    { ...base.folders[0], total_file_count: -1 },
    { ...base.folders[0], total_file_count: Number.MAX_SAFE_INTEGER + 1 },
  ])
    expectInconclusive(
      () => projectGroupFiles({ ...base, folders: [folder] }, groupId),
      "GROUP_FILES_PROJECTION",
    );
  expectInconclusive(
    () =>
      projectGroupFiles({ ...base, folders: [base.folders[0], { ...base.folders[0] }] }, groupId),
    "GROUP_FILES_PROJECTION",
  );
  expectInconclusive(
    () =>
      projectGroupFiles(
        { ...base, folders: Array.from({ length: 50 }, () => base.folders[0]) },
        groupId,
      ),
    "GROUP_FILES_PROJECTION",
  );
  expectInconclusive(
    () => projectGroupFiles({ ...base, unexpected: true }, groupId),
    "GROUP_FILES_PROJECTION",
  );
});

test("group file projection rejects non-JSON accessors, symbols, sparse arrays and cycles", () => {
  const base = providerResult();
  const accessor = { ...base, files: [{ ...base.files[0] }] };
  Object.defineProperty(accessor.files[0], "extra", { enumerable: true, get: () => fileName });
  const hidden = { ...base, files: [{ ...base.files[0] }] };
  Object.defineProperty(hidden.files[0], "extra", { enumerable: false, value: 1 });
  const withSymbol = { ...base, files: [{ ...base.files[0], [Symbol("extra")]: 1 }] };
  const nonPlain = Object.assign(Object.create({ inherited: true }), base);
  const sparse = { ...base, files: [] };
  sparse.files.length = 1;
  const cyclic = { ...base };
  cyclic.files = [{ ...base.files[0], extra: cyclic }];
  for (const invalid of [accessor, hidden, withSymbol, nonPlain, sparse, cyclic])
    expectInconclusive(() => projectGroupFiles(invalid, groupId), "GROUP_FILES_PROJECTION");
});

test("group file observer rejects malformed wrapper hashes, call bindings and input", () => {
  const f = fixture();
  expectInconclusive(() =>
    observeGroupFilesResult(f.assertion, {
      events: replaceHead(f.events, f.events[1].data.outputHead, { outputSha256: "0".repeat(64) }),
      runId,
    }),
  );
  const wrongId = structuredClone(f.events);
  wrongId[1].toolCallId = "different";
  expectInconclusive(() => observeGroupFilesResult(f.assertion, { events: wrongId, runId }));
  expectInconclusive(() =>
    observeGroupFilesResult(f.assertion, {
      events: [...structuredClone(f.events)].reverse(),
      runId,
    }),
  );
  for (const params of [{ file_count: 2 }, { startIndex: 1 }]) {
    const changed = structuredClone(f.events);
    changed[0].data.input.params = params;
    expectInconclusive(() => observeGroupFilesResult(f.assertion, { events: changed, runId }));
  }
  const extraCall = structuredClone(f.events);
  extraCall.splice(1, 0, structuredClone(f.events[0]));
  expectInconclusive(() => observeGroupFilesResult(f.assertion, { events: extraCall, runId }));
});

test("group file observer rejects duplicate keys and disagreement between details and content", () => {
  const f = fixture();
  const duplicateDetails = `{"files":[],"files":[],"folders":[]}`;
  const duplicateWrapper = `{"content":[{"type":"text","text":${JSON.stringify(duplicateDetails)}}],"details":{"files":[],"folders":[]}}`;
  const repeated = replaceHead(f.events, duplicateWrapper);
  repeated[1].data.groupFiles = {
    schemaVersion: 1,
    fileCount: 0,
    folderCount: 0,
    listingSha256: hash('{"files":[],"folders":[]}'),
  };
  expectInconclusive(() => observeGroupFilesResult(f.assertion, { events: repeated, runId }));

  const mismatch = structuredClone(f.events);
  const parsed = JSON.parse(mismatch[1].data.outputHead);
  parsed.content[0].text = JSON.stringify({ files: [], folders: [] });
  mismatch[1].data.outputHead = JSON.stringify(parsed);
  mismatch[1].data.outputBytes = Buffer.byteLength(mismatch[1].data.outputHead, "utf8");
  mismatch[1].data.outputSha256 = hash(mismatch[1].data.outputHead);
  expectInconclusive(() => observeGroupFilesResult(f.assertion, { events: mismatch, runId }));
});

test("group file observer accepts UTF-8 truncated head only with a valid fixed summary", () => {
  const f = fixture();
  let details;
  let serialized;
  let head;
  for (let size = 300; size < 500; size += 1) {
    details = {
      ...providerResult(),
      files: [{ ...providerResult().files[0], provider_extension: `${"a".repeat(size)}中tail` }],
    };
    serialized = JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(details) }],
      details,
    });
    head = Buffer.from(serialized, "utf8").subarray(0, 512).toString("utf8");
    if (Buffer.byteLength(head, "utf8") > 512) break;
  }
  assert.ok(Buffer.byteLength(head, "utf8") >= 512 && Buffer.byteLength(head, "utf8") <= 514);
  const projected = projectGroupFiles(details, groupId);
  const truncated = structuredClone(f.events);
  Object.assign(truncated[1].data, {
    groupFiles: { schemaVersion: 1, ...projected },
    outputHead: head,
    outputTruncated: true,
    outputBytes: Buffer.byteLength(serialized, "utf8"),
    outputSha256: hash(serialized),
  });
  assert.deepEqual(observeGroupFilesResult(f.assertion, { events: truncated, runId }), {
    kind: "group_files",
    tool: "qq_group_files",
    ...projected,
  });
  for (const badHead of ["", "short"]) {
    const invalidEvents = structuredClone(truncated);
    invalidEvents[1].data.outputHead = badHead;
    expectInconclusive(() =>
      observeGroupFilesResult(f.assertion, { events: invalidEvents, runId }),
    );
  }
  const badEvidence = structuredClone(truncated);
  badEvidence[1].data.groupFiles.listingSha256 = "not-a-hash";
  expectInconclusive(() => observeGroupFilesResult(f.assertion, { events: badEvidence, runId }));
});

test("group file verifier fails closed on missing assertions, reply mismatch and independent read failure", async () => {
  const f = fixture();
  assert.deepEqual(await verify(f), {
    status: "PASS",
    fileCount: 1,
    folderCount: 1,
  });
  await assert.rejects(
    verify(f, { c: { route: "private", featureAssertions: [f.c.featureAssertions[1]] } }),
    (error) => error.code === "GROUP_FILES_SCOPE" && error.status === "INCONCLUSIVE",
  );
  await assert.rejects(
    verify(f, { witness: { fileCount: 0, folderCount: 1 } }),
    (error) => error.code === "GROUP_FILES_REPLY" && error.status === "INCONCLUSIVE",
  );
  await assert.rejects(
    verify(f, {
      witness: { fileCount: 1, folderCount: 1, listingSha256: f.projection.listingSha256 },
    }),
    (error) => error.code === "GROUP_FILES_REPLY" && error.status === "INCONCLUSIVE",
  );
  await assert.rejects(
    verify(f, {
      clients: {
        bot: {
          readGroupRootFiles: async () => {
            throw new Error(fileName);
          },
        },
      },
    }),
    (error) => error.code === "GROUP_FILES_UNAVAILABLE" && error.status === "INCONCLUSIVE",
  );
  await assert.rejects(
    verify(f, {
      clients: { bot: { readGroupRootFiles: async () => ({ ...f.projection, extra: 1 }) } },
    }),
    (error) => error.code === "GROUP_FILES_MISMATCH" && error.status === "INCONCLUSIVE",
  );
});

test("group file verifier compares the complete independent listing summary", async () => {
  const f = fixture();
  const wrongHash = { ...f.projection, listingSha256: "0".repeat(64) };
  await assert.rejects(
    verify(f, { clients: { bot: { readGroupRootFiles: async () => wrongHash } } }),
    (error) => error.code === "GROUP_FILES_MISMATCH" && error.status === "INCONCLUSIVE",
  );
  const wrongCounts = { ...f.projection, fileCount: 0 };
  await assert.rejects(
    verify(f, { clients: { bot: { readGroupRootFiles: async () => wrongCounts } } }),
    (error) => error.code === "GROUP_FILES_MISMATCH" && error.status === "INCONCLUSIVE",
  );
});
